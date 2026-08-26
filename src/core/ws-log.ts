/**
 * Полный лог общения с сервером — отдельное хранилище, отдельная выгрузка.
 *
 * Зачем отдельно от обычного журнала: там записи о наших решениях, и они
 * должны оставаться читаемыми. Здесь — сырые кадры сокета комнаты, тысячи
 * строк за игру; смешивать их значит утопить обычный лог и выбить его лимиты.
 *
 * Зачем вообще: разбор «кто поставил паузу» трижды упёрся в догадки о
 * протоколе (07–09.08.2026). Каждый заход стоил владельцу отдельной игры с
 * паузой, а ответ давал ровно один: как выглядит кадр на самом деле.
 *
 * ЧТО СЮДА НЕ ПОПАДАЕТ (осознанные пропуски, не забывчивость):
 *  - медиа: сокет Janus целиком и кадры `janus_message` игрового сокета —
 *    это SDP и ICE-кандидаты, мегабайты про камеры и звук, из которых для
 *    разбора логики игры не следует ничего (решение владельца 09.08.2026);
 *  - секреты: `authKey` уезжает в самом первом кадре подключения к комнате,
 *    поэтому каждая строка проходит через redactSecrets — файл пересылают в
 *    поддержку, и ключ сессии в нём был бы находкой для чужого.
 *
 * ЧТО ПОПАДАЕТ: всё остальное с игрового сокета, в обе стороны. Это роли,
 * ночные ходы и чат — то есть настройка по умолчанию ВЫКЛЮЧЕНА, включает её
 * человек осознанно и ради разбора конкретной жалобы.
 */
import { browser } from "./env";
import { log, redactSecrets } from "./log";

const SCOPE = "ws-log";

export interface WsFrame {
  /** Время получения (мс). */
  t: number;
  /** Направление: от сервера или к серверу. */
  d: "in" | "out";
  /** Тело кадра — обрезанное и зачищенное от секретов. */
  m: string;
}

export const WS_LOG_PREFIX = "polemica:wslog:";
/** Живёт сутки, как и обычные логи вкладок: дальше это просто мусор на диске. */
export const WS_LOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Лимиты. Кадр состояния комнаты — десятки килобайт, а идут они пачками;
 * без потолка одна игра забила бы storage.local целиком (в Chrome это
 * жёсткие 10 МБ на всё расширение, включая заметки пользователя).
 */
export const MAX_FRAME_CHARS = 4000;
export const MAX_TOTAL_CHARS = 2_000_000;
/**
 * Потолок НЕзаписанной очереди (перф-аудит 26.08.2026, PERF26-4): при
 * медленном хранилище приход кадров обгоняет запись, и очередь без предела
 * росла бы бесконечно. Свежие кадры дороже: переполнение отбрасывает
 * старейшие из очереди.
 */
export const PENDING_MAX_CHARS = 400_000;
/**
 * Потолок числа КЛЮЧЕЙ: капельный поток писал кусок раз в 5 с — до 2160
 * ключей за вечер при соблюдённом символьном потолке (PERF26-4, механизм 3).
 */
export const MAX_CHUNKS = 100;

/** Кадры, которые не пишем: медиа-сигналинг (см. шапку). */
const SKIP_EVENTS = ["janus_message"];

/**
 * Кадр игрового сокета? Движок socket.io шлёт текст, начинающийся с цифры
 * (тип пакета engine.io). Сигналинг Janus — обычный JSON-объект, то есть
 * начинается со скобки, и этой проверкой отсекается целиком, даже если
 * когда-нибудь поедет по тому же соединению.
 */
export function isGameFrame(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (raw.charCodeAt(0) < 48 || raw.charCodeAt(0) > 57) return false;
  // Имя события стоит в начале кадра — искать по всему телу незачем и дорого.
  const head = raw.slice(0, 64);
  return !SKIP_EVENTS.some(e => head.includes(e));
}

/** Подготовить строку к хранению: обрезать и вычистить секреты. */
export function sanitizeFrame(raw: string): string {
  // redactSecrets сам режет по длине — свой предел передаём явно, иначе он
  // применит собственный (400 символов) и кадр состояния превратится в
  // огрызок, по которому ничего не разобрать.
  const clean = redactSecrets(raw, MAX_FRAME_CHARS);
  return raw.length > MAX_FRAME_CHARS ? `${clean}…[обрезано ${raw.length} симв.]` : clean;
}

/**
 * Хранение КУСКАМИ, а не одним ключом.
 *
 * Соблазн был написать «весь буфер в один ключ по таймеру», и это порвало
 * бы диск: кадр состояния комнаты весит десятки килобайт, у потолка буфер
 * держит два миллиона символов, и каждый сброс переписывал бы их целиком —
 * мегабайты записи в минуту всю игру. Кусок пишется один раз и больше не
 * трогается; место освобождается удалением самых старых кусков.
 */
const FLUSH_DELAY_MS = 5000;
/** Порог, после которого кусок пишется не дожидаясь таймера. */
const CHUNK_CHARS = 200_000;

/** Ключ этой вкладки: у каждой свой, иначе две игры затирали бы друг друга. */
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let pending: WsFrame[] = [];
let pendingChars = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
/** Уже записанные куски этой вкладки — в порядке появления. */
let chunks: Array<{ key: string; chars: number }> = [];
let storedChars = 0;
/** Сколько символов лежит в кусках ПРОШЛЫХ сессий после уборки: они входят
 *  в общий потолок (PERF26-4, механизм 1 — раньше «свой» счётчик стартовал
 *  с нуля и суммарный объём доходил до двух потолков). */
let foreignChars = 0;
let recorded = 0;
/** Отброшено кадров переполненной очередью — честная строка в файле. */
let droppedByBackpressure = 0;
/** Символы, стоящие в ЦЕПОЧКЕ записи (захвачены замыканиями writeChunk):
 *  именно она растёт без предела при медленном хранилище — pending режет
 *  порог CHUNK_CHARS сам (PERF26-4, механизм 2). */
let chainBacklogChars = 0;
/**
 * Поколение сессии записи: resetBuffer() его инкрементирует, и висящие в
 * цепочке записи прошлой жизни не касаются ни диска, ни учёта (PERF26-4:
 * disable сбрасывал счётчики до завершения цепочки, а тот же SESSION_ID
 * переиспользовал ключи).
 */
let generation = 0;
/** Хранилище отказало даже после уборки — до конца сессии не пишем. */
let stopped = false;

/** Добавить кадр. Возвращает false, если кадр отброшен как чужой. */
export function record(dir: "in" | "out", raw: unknown): boolean {
  if (stopped) return false;
  if (!isGameFrame(raw)) return false;
  const m = sanitizeFrame(raw);
  pending.push({ t: Date.now(), d: dir, m });
  pendingChars += m.length;
  recorded++;
  // Считаем ОБЪЁМ, а не число кадров: кадры различаются в сотни раз, и
  // счётчик штук не защитил бы ни от чего.
  if (pendingChars >= CHUNK_CHARS) void flushNow();
  else scheduleFlush();
  return true;
}

/** Сколько кадров записано за сессию — для тестов и строки в логе. */
export function size(): number {
  return recorded;
}

/** Отброшено переполненной очередью — для строки в выгрузке. */
export function droppedCount(): number {
  return droppedByBackpressure;
}

/**
 * Старт сессии записи: уборка чужого с ПОЛОВИННЫМ бюджетом и учёт остатка
 * в общем потолке. Раньше enable звал sweepStorage() с полным бюджетом и
 * выбрасывал результат — старые сессии удерживали до 2М, текущая писала
 * свои 2М поверх (PERF26-4, механизм 1).
 */
export async function startSession(): Promise<void> {
  foreignChars = await sweepStorage(Math.floor(MAX_TOTAL_CHARS / 2));
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => void flushNow(), FLUSH_DELAY_MS);
}

/**
 * Записать накопленный кусок. Зовётся по таймеру, по порогу объёма и на
 * уходе со страницы: F5 посреди игры не должен стирать собранное — ради
 * этого хранилище вообще и появилось.
 */
export function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Партию отрезаем СИНХРОННО. Асинхронная нарезка выглядит так же, но
  // порог объёма зовёт сброс из record() без ожидания: пока первый сброс
  // ждал storage, кадры копились в той же партии, и вся игра уезжала одним
  // куском — то есть вытеснять становилось нечего (поймано тестом).
  if (pending.length === 0) return flushChain;
  const frames = pending;
  const chars = pendingChars;
  pending = [];
  pendingChars = 0;
  // Записи — строго по очереди: иначе учёт занятого места отставал бы от
  // факта, а вытеснение старого — от учёта.
  // Backpressure: хранилище отстаёт от потока — новые партии отбрасываем,
  // не ставя в цепочку (замыкания копили бы кадры без предела). Старое в
  // цепочке дороже нового: оно ближе к началу истории разбора.
  if (chainBacklogChars > PENDING_MAX_CHARS) {
    if (droppedByBackpressure === 0) {
      log.warn(SCOPE, "хранилище не успевает за потоком кадров — новые партии отбрасываются");
    }
    droppedByBackpressure += frames.length;
    return flushChain;
  }
  const gen = generation;
  chainBacklogChars += chars;
  flushChain = flushChain.then(
    () => writeChunk(frames, chars, gen),
    () => writeChunk(frames, chars, gen),
  );
  flushChain = flushChain.finally(() => {
    if (gen === generation) chainBacklogChars -= chars;
  });
  return flushChain;
}

let flushChain: Promise<void> = Promise.resolve();

async function writeChunk(frames: WsFrame[], chars: number, gen: number): Promise<void> {
  // Сессию записи выключили, пока кусок стоял в очереди, — прошлой жизни
  // на диске и в учёте делать нечего.
  if (gen !== generation) return;
  const key = `${WS_LOG_PREFIX}${SESSION_ID}:${gen}-${seq++}`;
  try {
    await browser.storage.local.set({ [key]: { at: Date.now(), frames } });
  } catch (e) {
    // Скорее всего кончилась квота — а в том же хранилище лежат ЗАМЕТКИ.
    // Сначала освобождаем своё, потом пробуем ещё раз; не вышло — молчим до
    // конца сессии, чтобы не мешать заметкам сохраняться (жалоба 10.08.2026).
    log.warn(SCOPE, "кусок полного лога не записался, прибираю своё", e);
    await sweepStorage(Math.floor(MAX_TOTAL_CHARS / 2));
    try {
      await browser.storage.local.set({ [key]: { at: Date.now(), frames } });
    } catch {
      stopped = true;
      log.warn(SCOPE, "полный лог остановлен: хранилище браузера не принимает записи");
      return;
    }
  }
  if (gen !== generation) {
    // Выключили, пока ждали storage: кусок уже на диске — убираем и выходим,
    // счётчики новой жизни не трогаем.
    try {
      await browser.storage.local.remove(key);
    } catch {
      /* приберёт sweepStorage следующей сессии */
    }
    return;
  }
  chunks.push({ key, chars });
  storedChars += chars;
  // Потолок держим удалением самых старых кусков — по одному ключу за раз.
  // Чужой остаток (foreignChars) входит в общий потолок, а MAX_CHUNKS
  // ограничивает ЧИСЛО ключей (капельный поток, PERF26-4 механизм 3).
  while (
    (foreignChars + storedChars > MAX_TOTAL_CHARS || chunks.length > MAX_CHUNKS) &&
    chunks.length > 1
  ) {
    const oldest = chunks.shift();
    if (!oldest) break;
    storedChars -= oldest.chars;
    try {
      await browser.storage.local.remove(oldest.key);
    } catch {
      /* не удалилось — уберёт следующая уборка (sweepStorage) */
    }
  }
}

/** Забыть накопленное в памяти (при выключении настройки). */
export function resetBuffer(): void {
  generation++; // висящая цепочка прошлой жизни больше не пишет и не считает
  stopped = false;
  pending = [];
  pendingChars = 0;
  recorded = 0;
  seq = 0;
  chunks = [];
  storedChars = 0;
  foreignChars = 0;
  droppedByBackpressure = 0;
  chainBacklogChars = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

interface StoredChunk {
  at?: number;
  frames?: WsFrame[];
}

/** Размер куска в символах — по тем же телам кадров, что мы и считали. */
function chunkChars(chunk: StoredChunk): number {
  let n = 0;
  for (const f of chunk.frames ?? []) n += typeof f?.m === "string" ? f.m.length : 0;
  return n;
}

/**
 * Прибрать ЧУЖИЕ куски: протухшие и лишние сверх общего потолка.
 *
 * Зачем отдельно от вытеснения внутри сессии: ключи именуются по сессии
 * страницы, и каждая новая загрузка начинала копить с нуля — своё вытесняла,
 * а куски прошлых заходов не трогал никто. Срок жизни применялся только при
 * ЧТЕНИИ и ничего не удалял (комментарий «TTL уберёт» был неправдой). С
 * включённым полным логом это оставляло на диске по паре мегабайт за заход, и
 * у пользователя переполнялось хранилище — вместе с ним переставали
 * сохраняться ЗАМЕТКИ и цвета (жалоба 10.08.2026).
 *
 * Возвращает, сколько символов осталось лежать.
 */
export async function sweepStorage(budget = MAX_TOTAL_CHARS): Promise<number> {
  try {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const now = Date.now();
    const mine: Array<{ key: string; at: number; chars: number }> = [];
    const doomed: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(WS_LOG_PREFIX)) continue;
      const chunk = value as StoredChunk;
      const at = typeof chunk?.at === "number" ? chunk.at : 0;
      // Протухшее и битое (без времени/кадров) убираем сразу.
      if (!Array.isArray(chunk?.frames) || now - at > WS_LOG_TTL_MS) {
        doomed.push(key);
        continue;
      }
      mine.push({ key, at, chars: chunkChars(chunk) });
    }
    // Потолок общий, а не «на сессию»: свежие куски дороже старых.
    mine.sort((a, b) => b.at - a.at);
    let kept = 0;
    for (const c of mine) {
      if (kept + c.chars > budget && kept > 0) doomed.push(c.key);
      else kept += c.chars;
    }
    if (doomed.length > 0) {
      await browser.storage.local.remove(doomed);
      log.info(SCOPE, `убрано кусков полного лога: ${doomed.length}`);
    }
    return kept;
  } catch (e) {
    log.warn(SCOPE, "уборка полного лога не удалась", e);
    return 0;
  }
}

/**
 * Собрать кадры всех вкладок, отсортировать по времени и выкинуть протухшее.
 * Ровно та же схема, что у обычного журнала: у каждой вкладки свой ключ.
 */
export async function collectAll(): Promise<WsFrame[]> {
  try {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const now = Date.now();
    const frames: WsFrame[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(WS_LOG_PREFIX)) continue;
      const chunk = value as StoredChunk;
      if (typeof chunk?.at === "number" && now - chunk.at > WS_LOG_TTL_MS) continue;
      if (Array.isArray(chunk?.frames)) frames.push(...chunk.frames);
    }
    return frames.sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

/** Стереть всё сохранённое (кнопка «Очистить» в попапе). */
export async function clearAll(): Promise<void> {
  resetBuffer();
  try {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const keys = Object.keys(all).filter(k => k.startsWith(WS_LOG_PREFIX));
    if (keys.length > 0) await browser.storage.local.remove(keys);
  } catch {
    /* нечего чистить или хранилище недоступно */
  }
}

/** Готовый текст файла. */
export function formatFrames(frames: WsFrame[]): string {
  const head = [
    "Polemica Notes — полный лог общения с сервером",
    `выгружено: ${new Date().toISOString()}`,
    `кадров: ${frames.length}`,
    ...(droppedByBackpressure > 0
      ? [`ВНИМАНИЕ: ${droppedByBackpressure} кадров отброшено переполненной очередью — лог неполный`]
      : []),
    "медиа (janus/SDP/ICE) и ключи сессии в файл не попадают",
    "",
  ].join("\n");
  const body = frames
    .map(f => `${new Date(f.t).toISOString()} ${f.d === "in" ? "<<" : ">>"} ${f.m}`)
    .join("\n");
  return `${head}${body}\n`;
}
