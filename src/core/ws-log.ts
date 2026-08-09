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
import { redactSecrets } from "./log";

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
let recorded = 0;

/** Добавить кадр. Возвращает false, если кадр отброшен как чужой. */
export function record(dir: "in" | "out", raw: unknown): boolean {
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
  flushChain = flushChain.then(
    () => writeChunk(frames, chars),
    () => writeChunk(frames, chars),
  );
  return flushChain;
}

let flushChain: Promise<void> = Promise.resolve();

async function writeChunk(frames: WsFrame[], chars: number): Promise<void> {
  const key = `${WS_LOG_PREFIX}${SESSION_ID}:${seq++}`;
  try {
    await browser.storage.local.set({ [key]: { at: Date.now(), frames } });
  } catch {
    // Квота кончилась или хранилище отказало — молча: сорвать игру ради
    // диагностического файла нельзя. Кусок потерян, но следующие пойдут.
    return;
  }
  chunks.push({ key, chars });
  storedChars += chars;
  // Потолок держим удалением самых старых кусков — по одному ключу за раз.
  while (storedChars > MAX_TOTAL_CHARS && chunks.length > 1) {
    const oldest = chunks.shift();
    if (!oldest) break;
    storedChars -= oldest.chars;
    try {
      await browser.storage.local.remove(oldest.key);
    } catch {
      /* не удалилось — TTL уберёт */
    }
  }
}

/** Забыть накопленное в памяти (при выключении настройки). */
export function resetBuffer(): void {
  pending = [];
  pendingChars = 0;
  recorded = 0;
  seq = 0;
  chunks = [];
  storedChars = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

interface StoredChunk {
  at?: number;
  frames?: WsFrame[];
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
    "медиа (janus/SDP/ICE) и ключи сессии в файл не попадают",
    "",
  ].join("\n");
  const body = frames
    .map(f => `${new Date(f.t).toISOString()} ${f.d === "in" ? "<<" : ">>"} ${f.m}`)
    .join("\n");
  return `${head}${body}\n`;
}
