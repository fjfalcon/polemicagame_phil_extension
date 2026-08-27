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
/**
 * Общий потолок хранения — в СЕРИАЛИЗОВАННЫХ символах (метрика едина для
 * учёта, вытеснения и sweep с 9.42.0, SEC26-3). Честное следствие: полезных
 * кадров помещается ~в 5 раз меньше, чем обещала прежняя цифра, — но прежняя
 * и была фикцией: реальный диск при «2М тел» доходил до ~10 МБ, то есть до
 * всей квоты расширения вместе с заметками. Теперь 2М — это ~2 МБ на диске.
 */
export const MAX_TOTAL_CHARS = 2_000_000;
/**
 * Потолок цепочки записи (перф-аудит 26.08.2026, PERF26-4) — теперь в тех же
 * СЕРИАЛИЗОВАННЫХ символах, что и учёт (adversarial 27.08, №3: старые 400К
 * «тел» против сериализованного бэклога сжимали терпимую очередь впятеро).
 * ~1М ≈ четыре-пять кусков в полёте. Семантика ОСОЗНАННО не кольцевая:
 * отбрасываются НОВЫЕ партии (стоящие в цепочке не вынуть из замыканий),
 * при затяжном подвисании теряется конец; файл честно помечает отброс.
 */
export const PENDING_MAX_CHARS = 1_000_000;
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
let chunks: Array<{ key: string; chars: number; frames: number }> = [];
let storedChars = 0;
/** Сколько символов лежит в кусках ПРОШЛЫХ сессий после уборки: они входят
 *  в общий потолок (PERF26-4, механизм 1 — раньше «свой» счётчик стартовал
 *  с нуля и суммарный объём доходил до двух потолков). */
let foreignChars = 0;
let recorded = 0;
/**
 * ЕДИНЫЙ счётчик потерь (ревью 27.08.2026, п.3): backpressure, вытеснение
 * по потолкам и отказ записи — для пользователя это одно и то же «в файле
 * не всё». Раньше признак неполноты знал только про backpressure.
 */
let droppedByBackpressure = 0;
/**
 * Персистентный признак неполноты (adversarial 27.08, №2/№8): счётчик живёт
 * в контенте, а файл собирает попап — при остановленной записи, вытеснении
 * и уборке маркер в кусок уже не попадёт. Отдельный маленький ключ пролезает
 * даже в забитую квоту; best-effort, ошибку глотаем.
 */
/** ВНЕ префикса кусков: иначе попадал бы во все фильтры «мои куски». */
export const WS_LOSS_KEY = "polemica:wslog-loss";
let lossChain: Promise<void> = Promise.resolve();
/** Признак потерь дописан на диск — тестовый шов и точка ожидания. */
export function lossSettled(): Promise<void> {
  return lossChain;
}

/**
 * ПОЛНЫЙ барьер перед чтением: и куски, и счётчик потерь на диске.
 * Раньше выгрузка успевала прочитать состояние «до» (ревью 27.08.2026).
 */
export async function settleAll(): Promise<void> {
  await flushNow();
  await lossChain;
  // flushNow мог породить новые потери (вытеснение) — досушиваем.
  await lossChain;
}
function noteLoss(n: number): void {
  if (n <= 0) return;
  droppedByBackpressure += n;
  // Чтение-изменение-запись СЕРИАЛИЗУЕМ: параллельные инкременты внутри
  // вкладки терялись (ревью 27.08.2026). Между вкладками остаётся
  // best-effort — общий счётчик без координатора не сделать, а заводить
  // ради выключенной по умолчанию фичи фоновую очередь мы не станем.
  const gen = generation;
  lossChain = lossChain.then(async () => {
    // Очистка/перевключение подняли поколение — отложенный RMW прошлой
    // жизни не имеет права воскресить счётчик (ревью 27.08.2026).
    if (gen !== generation) return;
    try {
      const bag = (await browser.storage.local.get({ [WS_LOSS_KEY]: null })) as Record<
        string,
        unknown
      >;
      // ПОВТОРНАЯ проверка после await (ревью 27.08.2026): очистка могла
      // случиться, пока мы читали — иначе set воскресил бы счётчик.
      if (gen !== generation) return;
      const cur = bag[WS_LOSS_KEY] as { n?: unknown; at?: unknown } | number | null;
      const now = Date.now();
      let prev = 0;
      if (typeof cur === "number") prev = cur;
      else if (cur && typeof cur === "object" && typeof cur.n === "number") {
        const at = typeof cur.at === "number" ? cur.at : 0;
        prev = now - at <= WS_LOG_TTL_MS ? cur.n : 0; // протухшее не наследуем
      }
      await browser.storage.local.set({ [WS_LOSS_KEY]: { n: prev + n, at: now } });
    } catch {
      /* даже признак не влез — честнее промолчать, чем упасть */
    }
  });
}
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
  // Порядок важен: сначала «наш ли это кадр» (adversarial 27.08, №3 —
  // иначе после остановки в потери шли медиа-кадры, которых в логе не
  // бывает по дизайну, и счётчик врал на тысячи).
  if (!isGameFrame(raw)) return false;
  if (stopped) {
    // Лог остановлен отказом хранилища: каждый ПРОПУЩЕННЫЙ игровой кадр —
    // потеря, и файл обязан это признать.
    noteLoss(1);
    return false;
  }
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
  // Быстрое перевключение: не стартуем, пока прошлая сессия закрывается —
  // иначе кадры нового включения писались бы под СТАРЫМ поколением и
  // выбрасывались его закрытием (SEC26-4, гонка disable→enable).
  if (closing) await closing;
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
  void chars; // учёт ниже — по сериализованному размеру (SEC26-3)
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
    noteLoss(frames.length);
    return flushChain;
  }
  const gen = generation;
  // Отброшенное с прошлой записи — В КУСОК: счётчик модуля живёт в контенте,
  // а файл собирает ПОПАП (другой контекст; adversarial 26.08.2026, №3).
  // Учёт — по СЕРИАЛИЗОВАННОМУ размеру (SEC26-3): голые тела кадров занижали
  // фактический storage в ~5 раз (timestamp/direction/JSON-обвязка каждого
  // кадра), и «потолок 2М» подбирался к квоте вплотную.
  const payload = { at: Date.now(), frames };
  const serialized = JSON.stringify(payload).length;
  chainBacklogChars += serialized;
  flushChain = flushChain.then(
    () => writeChunk(payload, serialized, gen),
    () => writeChunk(payload, serialized, gen),
  );
  flushChain = flushChain.finally(() => {
    if (gen === generation) chainBacklogChars -= serialized;
  });
  return flushChain;
}

let flushChain: Promise<void> = Promise.resolve();

async function writeChunk(
  payload: { at: number; frames: WsFrame[]; dropped?: number },
  chars: number,
  gen: number,
): Promise<void> {
  // Сессию записи выключили, пока кусок стоял в очереди, — прошлой жизни
  // на диске и в учёте делать нечего.
  if (gen !== generation) return;
  const key = `${WS_LOG_PREFIX}${SESSION_ID}:${gen}-${seq++}`;
  try {
    await browser.storage.local.set({ [key]: payload });
  } catch (e) {
    // Скорее всего кончилась квота — а в том же хранилище лежат ЗАМЕТКИ.
    // Сначала освобождаем своё, потом пробуем ещё раз; не вышло — молчим до
    // конца сессии, чтобы не мешать заметкам сохраняться (жалоба 10.08.2026).
    log.warn(SCOPE, "кусок полного лога не записался, прибираю своё", e);
    // Результат уборки — В УЧЁТ (adversarial №7): чужого стало меньше.
    foreignChars = await sweepStorage(Math.floor(MAX_TOTAL_CHARS / 2));
    try {
      await browser.storage.local.set({ [key]: payload });
    } catch {
      stopped = true;
      // Эти кадры на диск не попали — считаем их потерянными, иначе файл
      // выглядел бы полным ровно там, где обрывается (п.3).
      noteLoss(payload.frames.length);
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
  chunks.push({ key, chars, frames: payload.frames.length });
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
      // Потерю отмечаем ПОСЛЕ успешного удаления (ревью 27.08.2026):
      // неудавшийся remove оставляет кадры на диске — они не потеряны.
      noteLoss(oldest.frames);
    } catch {
      /* не удалилось — уберёт следующая уборка (sweepStorage) */
    }
  }
}

/**
 * Закрыть сессию записи, НЕ теряя хвост (adversarial 26.08.2026, HIGH-1):
 * прежний «flushNow(); resetBuffer()» инкрементировал поколение синхронно,
 * и gen-гейт выбрасывал последнюю партию — а маршрут пользователя ровно
 * «поймал момент → выключил → скачал». Ждём цепочку, потом закрываем.
 */
let closing: Promise<void> | null = null;

export async function finishSession(): Promise<void> {
  const run = (async () => {
    try {
      await flushNow();
      // Хвост отброшенных, не уехавший ни в один принятый кусок: без этого
      // «выключил сразу после перегрузки» давал файл, молчащий о потере
      // (ревью 27.08.2026). Пустой кусок-маркер — только с числом.
    } catch {
      /* хвост не записался — хуже уже не сделаем */
    }
    // Финальное вытеснение могло отметить потерю — ДОЖИДАЕМСЯ её записи:
    // resetBuffer поднимает поколение, и отложенный RMW был бы отброшен
    // gen-гейтом (ревью 27.08.2026).
    await lossChain;
    resetBuffer();
  })();
  closing = run;
  try {
    await run;
  } finally {
    if (closing === run) closing = null;
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
  /** Кадров отброшено backpressure'ом ПЕРЕД этим куском. */
  dropped?: number;
}

/** Размер куска — СЕРИАЛИЗОВАННЫЙ, той же метрикой, что и учёт (SEC26-3). */
function chunkChars(chunk: StoredChunk): number {
  try {
    return JSON.stringify(chunk)?.length ?? 0;
  } catch {
    return 0;
  }
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
    // Только АКТИВНОЕ поколение — «свои» (SEC26-4): закрытые поколения этой
    // же вкладки после перевключения настройки никем не учитывались и не
    // убирались — копились до отказа квоты.
    const ownPrefix = `${WS_LOG_PREFIX}${SESSION_ID}:${generation}-`;
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(WS_LOG_PREFIX)) continue;
      // Свою сессию не считаем и не удаляем: её ведёт учёт chunks/storedChars,
      // а двойной счёт вытеснял раньше времени (adversarial №7/№10).
      if (key.startsWith(ownPrefix)) continue;
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
    const overBudget: string[] = [];
    for (const c of mine) {
      if (kept + c.chars > budget && kept > 0) {
        doomed.push(c.key);
        overBudget.push(c.key);
      } else kept += c.chars;
    }
    if (doomed.length > 0) {
      // Уборка тоже уносит кадры из будущего файла (№8): признак неполноты
      // обязан это включать, иначе «единый» он только на словах.
      // Потерей считаем ТОЛЬКО вытесненное по БЮДЖЕТУ: протухшее по TTL —
      // ретенция, и подписывать ею свежий лог нечестно (ревью 27.08.2026).
      let lostFrames = 0;
      for (const key of overBudget) {
        const chunk = all[key] as StoredChunk | undefined;
        if (Array.isArray(chunk?.frames)) lostFrames += chunk.frames.length;
      }
      await browser.storage.local.remove(doomed);
      if (lostFrames > 0) noteLoss(lostFrames);
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
export async function collectAll(): Promise<{
  frames: WsFrame[];
  dropped: number;
  /** Чтение хранилища упало: пустота НЕ означает «лог не включали» (п.3). */
  readFailed?: boolean;
}> {
  try {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const now = Date.now();
    const frames: WsFrame[] = [];
    let dropped = 0;
    let legacyDropped = 0;
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(WS_LOG_PREFIX)) continue;
      const chunk = value as StoredChunk;
      if (typeof chunk?.at === "number" && now - chunk.at > WS_LOG_TTL_MS) continue;
      if (Array.isArray(chunk?.frames)) frames.push(...chunk.frames);
      // chunk.dropped (формат 9.45–9.46) складываем ТОЛЬКО если нового
      // счётчика на диске нет: иначе это двойной счёт, а без него —
      // недосчёт после обновления с той версии (ревью 27.08.2026).
      if (typeof chunk?.dropped === "number" && chunk.dropped > 0) legacyDropped += chunk.dropped;
    }
    // Персистентный признак: то, что не доехало ни до одного куска.
    const lossBag = (await browser.storage.local.get({ [WS_LOSS_KEY]: null })) as Record<
      string,
      unknown
    >;
    const loss = lossBag[WS_LOSS_KEY] as { n?: unknown; at?: unknown } | number | null;
    if (loss === null || loss === undefined) dropped += legacyDropped;
    if (typeof loss === "number") {
      // Формат до 9.48 — без метки времени. Учитываем один раз и переводим
      // в новый формат, чтобы TTL начал течь (ревью 27.08.2026).
      dropped += loss;
      void browser.storage.local.set({ [WS_LOSS_KEY]: { n: loss, at: now } }).catch(() => undefined);
    } else if (loss && typeof loss === "object") {
      const at = typeof loss.at === "number" ? loss.at : 0;
      // Счётчик живёт столько же, сколько куски: иначе вчерашняя потеря
      // подписывала бы сегодняшний пустой лог (ревью 27.08.2026).
      if (now - at <= WS_LOG_TTL_MS && typeof loss.n === "number") dropped += loss.n;
    }
    return { frames: frames.sort((a, b) => a.t - b.t), dropped };
  } catch (e) {
    log.warn(SCOPE, "чтение полного лога не удалось", e);
    return { frames: [], dropped: 0, readFailed: true };
  }
}

/**
 * Стереть всё сохранённое (кнопка «Очистить» в попапе).
 * Возвращает false, если хранилище отказало: тост обязан сказать правду,
 * а не рапортовать «очищен» поверх оставшегося на диске (ревью 27.08.2026).
 */
export async function clearAll(): Promise<boolean> {
  resetBuffer();
  try {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const keys = Object.keys(all).filter(k => k.startsWith(WS_LOG_PREFIX));
    keys.push(WS_LOSS_KEY); // признак неполноты живёт вне префикса — чистим явно
    if (keys.length > 0) await browser.storage.local.remove(keys);
    return true;
  } catch (e) {
    log.warn(SCOPE, "очистка полного лога не удалась", e);
    return false;
  }
}

/** Готовый текст файла. */
export function formatFrames(frames: WsFrame[], dropped = 0): string {
  const head = [
    "Polemica Notes — полный лог общения с сервером",
    `выгружено: ${new Date().toISOString()}`,
    `кадров: ${frames.length}`,
    ...(dropped > 0
      ? [`ВНИМАНИЕ: лог НЕПОЛНЫЙ — потеряно кадров: ${dropped} (перегрузка очереди, вытеснение по потолку или отказ хранилища)`]
      : []),
    "медиа (janus/SDP/ICE) и ключи сессии в файл не попадают",
    "",
  ].join("\n");
  const body = frames
    .map(f => `${new Date(f.t).toISOString()} ${f.d === "in" ? "<<" : ">>"} ${f.m}`)
    .join("\n");
  return `${head}${body}\n`;
}
