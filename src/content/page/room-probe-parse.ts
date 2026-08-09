/**
 * Разбор кадров комнаты — ЧИСТАЯ часть зонда, без единого побочного эффекта.
 *
 * Отделена от room-probe-page намеренно: там установка перехвата живёт в
 * IIFE, то есть срабатывает от одного лишь импорта. Пока разбор лежал в том
 * же файле, любой импортёр (тесты, да и сама фича — ради одной константы)
 * молча ставил хук на WebSocket, в том числе в изолированном мире
 * контент-скрипта, где он бесполезен (разбор 09.08.2026).
 *
 * ПРИВАТНОСТЬ: наружу отсюда уходит РОВНО одно число (место инициатора
 * паузы), признак конца паузы и — когда инициатора в кадре нет — ИМЕНА
 * полей состояния. Тела сообщений не пересылаются и не логируются: через
 * тот же сокет идут роли и ночные ходы.
 *
 * ВАЖНО: никаких импортов из core/* — код исполняется и в мире страницы,
 * где нет ни browser.*, ни наших модулей.
 */

/** События паузы: инициатор может прийти прямо в пейлоаде. */
const PAUSE_EVENTS = ["on_start_pause", "on_update_pause_time"];
/** Полное состояние игры: инициатор лежит в объекте `pause`. */
const STATE_EVENT = "on_detailed_game_state";
const END_EVENT = "on_finish_pause";

/**
 * Конверт нового протокола: сервер шлёт `42["events",{type,data}]`, и
 * состояние комнаты приезжает именно так (`socket.on("events", e =>
 * "roomState"===e.type && commit("setGameView", e.data))`).
 *
 * Разбор жалобы 09.08.2026: пауза БЫЛА, а кадра `on_start_pause` в игре не
 * случилось ни одного — вся пауза приехала этим конвертом. Старые имена
 * событий на проводе тоже существуют (сайт на них подписан), поэтому обе
 * ветки остаются: какая из них живая, зависит от версии комнаты.
 */
const ENVELOPE_EVENT = "events";
/** Конверт стоит в начале кадра: `42[…]`, возможен неймспейс и ack-id. */
const ENVELOPE_PREFIX_MAX = 24;
const ROOM_STATE_TYPE = "roomState";

/**
 * Признак паузы в состоянии комнаты — ЗАМОРОЖЕННЫЙ таймер.
 *
 * Сайт судит ровно так: `timer.passed` определён → игра на паузе (функция
 * `LA` в room/bundle/main.js, сверено 09.08.2026). Отдельного объекта
 * `pause` в этом протоколе нет — потому старый разбор кадры и не узнавал.
 *
 * Регулярка нужна как ДЕШЁВЫЙ фильтр: без неё пришлось бы гонять JSON.parse
 * на каждом кадре состояния, а они идут пачками на каждое действие за столом.
 */
const PAUSED_TIMER_RE = /"passed":\s*\d/;

export interface PauseSignal {
  /** id инициатора; null — событие про паузу есть, а инициатора в нём нет. */
  initiatorId: number | null;
  /** Пауза закончилась — подпись пора убирать. */
  finished: boolean;
  /** Какое событие принесло сигнал — нужно для разбора жалоб по логу. */
  event?: string;
  /**
   * Сырое значение поля инициатора и имя поля, в котором оно нашлось.
   * Нумерация мест в двух протоколах разная (в новом ссылки на игрока
   * единичные: сайт делает `v.player - 1`), и пока живой паузы не видели —
   * это единственный способ поймать промах на единицу по логу.
   */
  raw?: string;
  /**
   * ИМЕНА полей состояния (без значений) — только когда пауза найдена, а
   * инициатора в ней нет. Иначе следующий шаг снова упирается в гадание:
   * поля с инициатором может не быть на проводе вовсе.
   */
  schema?: string;
}

/** Маркер «зонд на месте»: читается content-скриптом без гонок с postMessage. */
export const PROBE_MARK_ATTR = "data-pn-room-probe-ready";

/**
 * Имя события в кадре — ТОЛЬКО для диагностики: по логу «пауза была, а
 * подписи нет» иначе невозможно отличить «кадр не пришёл» от «пришёл, но
 * называется иначе» (разбор 09.08.2026). Имя события не секрет: тела и
 * поля кадра наружу по-прежнему не уходят.
 */
export function frameEventName(raw: string): string | null {
  const m = /\[\s*"([A-Za-z0-9_.:-]{1,40})"/.exec(raw);
  return m ? m[1] : null;
}

/**
 * Разбор кадра socket.io (engine.io v4): `42["event",{…}]`, возможен
 * неймспейс — `42/room,["event",{…}]`, и вложения — `451-[…]`.
 *
 * Экспортируется ради тестов: живой сокет в юнитах не поднять, а именно
 * здесь легче всего молча начать понимать не то (например, спутать
 * `on_finish_pause` с `on_start_pause` по подстроке).
 *
 * Возвращает null для всего, что не про паузу, — включая кадры, которые
 * парсить незачем: разбор JSON только для «своих» событий, иначе каждый
 * кадр игры гонял бы JSON.parse впустую.
 */
export function readPauseFrame(raw: unknown): PauseSignal | null {
  if (typeof raw !== "string") return null;
  if (isEnvelopeFrame(raw)) return readEnvelopeFrame(raw);
  // Дешёвый предфильтр: подавляющее большинство кадров — не про паузу.
  if (raw.indexOf("pause") < 0) return null;
  const parsed = parseFrame(raw);
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
  const event = parsed[0] as string;
  const payload = parsed[1] as Record<string, unknown> | undefined;

  if (event === END_EVENT) return { initiatorId: null, finished: true, event };
  if (PAUSE_EVENTS.includes(event)) {
    return { initiatorId: playerIdOrNull(payload?.initiatorId), finished: false, event };
  }
  if (event === STATE_EVENT) {
    const pause = payload?.pause as Record<string, unknown> | undefined;
    // Нет объекта паузы — состояние без паузы; это не сигнал «паузу сняли»:
    // такой кадр приходит и в обычной игре, и гасить им подпись нельзя.
    if (!pause || !pauseStillRunning(pause)) return null;
    return { initiatorId: playerIdOrNull(pause.initiatorId), finished: false, event };
  }
  return null;
}

/** Кадр socket.io → массив `[event, payload]`; null, если это не он. */
function parseFrame(raw: string): unknown {
  const at = raw.indexOf("[");
  if (at < 0) return null;
  try {
    return JSON.parse(raw.slice(at));
  } catch {
    return null;
  }
}

/**
 * Кадр — конверт нового протокола. Проверка по началу строки, а не поиском
 * по всему кадру: состояние комнаты весит десятки килобайт, а `indexOf` по
 * нему гонялся бы на каждом сообщении сокета.
 */
export function isEnvelopeFrame(raw: string): boolean {
  const at = raw.indexOf(`["${ENVELOPE_EVENT}"`);
  return at >= 0 && at <= ENVELOPE_PREFIX_MAX;
}

/**
 * Разбор конверта. Порядок проверок задан ценой: JSON.parse делаем ТОЛЬКО
 * когда дешёвая регулярка нашла замороженный таймер, то есть в паузу и
 * почти никогда вне её.
 */
function readEnvelopeFrame(raw: string): PauseSignal | null {
  if (!PAUSED_TIMER_RE.test(raw)) {
    // Состояние без паузы — сигнал «паузу сняли». Для НЕ состояния (иной
    // тип конверта) молчим: чужой кадр не имеет права гасить подпись.
    return raw.indexOf(`"${ROOM_STATE_TYPE}"`) >= 0
      ? { initiatorId: null, finished: true, event: `${ENVELOPE_EVENT}/${ROOM_STATE_TYPE}` }
      : null;
  }
  const parsed = parseFrame(raw);
  if (!Array.isArray(parsed)) return null;
  const envelope = parsed[1] as { type?: unknown; data?: unknown } | undefined;
  const data = envelope?.data;
  if (!data || typeof data !== "object") return null;
  const state = data as Record<string, unknown>;
  const timer = pausedTimer(state);
  // Регулярка нашла «passed» где-то ещё, а паузы по правилам сайта нет.
  if (!timer) return null;

  const type = typeof envelope?.type === "string" ? envelope.type : "?";
  const event = `${ENVELOPE_EVENT}/${type}`;
  const found = findInitiator(state);
  if (!found) return { initiatorId: null, finished: false, event, schema: describeShape(state, timer) };
  return {
    // В этом протоколе ссылки на игрока единичные — сайт сам пишет
    // `v.player - 1`. Приводим к тем же 0-based местам, что и старый путь.
    initiatorId: found.value - 1,
    finished: false,
    event,
    raw: `${found.key}=${found.value}`,
  };
}

/**
 * Таймер паузы по правилу сайта (функция `LA`): либо общий таймер комнаты с
 * заполненным `passed`, либо — если он один — таймер единственного игрока.
 */
export function pausedTimer(state: Record<string, unknown>): Record<string, unknown> | null {
  const own = state.timer as Record<string, unknown> | undefined;
  if (own && own.passed != null && own.isSystem !== true) return own;
  const players = Array.isArray(state.players) ? state.players : [];
  const timers = players
    .map(p => (p && typeof p === "object" ? (p as Record<string, unknown>).timer : null))
    .filter(t => t != null) as Array<Record<string, unknown>>;
  if (timers.length !== 1) return null;
  const only = timers[0];
  // `isSystem` — заморозка таймера самим сервером, а не игроком: так сайт
  // помечает трёхсекундный выкрик, во время которого речь тоже стоит
  // (видно в живых кадрах 09.08.2026). Настоящая пауза этого флага не несёт.
  if (only.isSystem === true) return null;
  return only.passed != null ? only : null;
}

/** Сколько узлов состояния просматриваем — страховка от разросшегося кадра. */
const MAX_SCAN_NODES = 2000;
const INITIATOR_KEY_RE = /initiator/i;

/**
 * Поиск инициатора ПО ИМЕНИ ПОЛЯ, а не по фиксированному пути.
 *
 * Жёсткий путь уже дважды промахнулся: сначала мы читали `pause.initiatorId`
 * из старого протокола, потом узнали, что живая комната шлёт другое
 * состояние целиком. Имя поля — самая устойчивая часть контракта, а его
 * место в дереве сервер волен менять.
 */
export function findInitiator(root: unknown): { key: string; value: number } | null {
  const queue: unknown[] = [root];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_SCAN_NODES) {
    const node = queue.shift();
    seen++;
    if (!node || typeof node !== "object") continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (INITIATOR_KEY_RE.test(key)) {
        const id = playerIdOrNull(value);
        if (id !== null) return { key, value: id };
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

/** Длина строки со схемой: в лог, а не в отчёт — держим её короткой. */
const SCHEMA_MAX = 400;
const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** Имена полей объекта — без значений и без вложенности. */
function safeKeys(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "-";
  return Object.keys(obj).filter(k => SAFE_KEY_RE.test(k)).slice(0, 24).join(",") || "-";
}

/**
 * Схема состояния — ТОЛЬКО имена полей.
 *
 * Зачем вообще: если инициатора на проводе нет, отличить это от «ищем не
 * там» иначе нечем, а каждая такая проверка стоит владельцу отдельной игры
 * с паузой. Значения не берём принципиально — через этот сокет идут роли и
 * ночные ходы (см. шапку файла), и утечь наружу они не должны даже в лог.
 */
function describeShape(state: Record<string, unknown>, timer: Record<string, unknown>): string {
  const players = Array.isArray(state.players) ? state.players : [];
  const line =
    `состояние: ${safeKeys(state)} | таймер: ${safeKeys(timer)} | ` +
    `игрок: ${safeKeys(players[0])} | этап: ${safeKeys(state.stage)}`;
  return line.length > SCHEMA_MAX ? line.slice(0, SCHEMA_MAX) : line;
}

/**
 * Пауза в состоянии игры ЕЩЁ идёт.
 *
 * Сайт гейтит ровно по остатку времени (`t.pause.time.total -
 * t.pause.time.current`), и это важно: после F5 сервер присылает состояние с
 * уже истёкшей паузой, а её инициатор в объекте остаётся. Без этой проверки
 * подпись воскресала бы на постороннем экране (ревью 08.08.2026).
 */
function pauseStillRunning(pause: Record<string, unknown>): boolean {
  const time = pause.time as Record<string, unknown> | undefined;
  const total = typeof time?.total === "number" ? time.total : 0;
  const current = typeof time?.current === "number" ? time.current : 0;
  return total - current > 0;
}

/**
 * id игрока или null. Сентинел `-1` («никого») в этом протоколе штатный —
 * он живёт и в соседних полях (`prosecutor`, `blamed`), и принимать его за
 * игрока значит утверждать заведомую неправду.
 */
function playerIdOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

