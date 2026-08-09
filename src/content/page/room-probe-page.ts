/**
 * Зонд комнаты — PAGE-скрипт (мир страницы).
 *
 * Зачем: сервер ЗНАЕТ, кто поставил паузу, и присылает это клиенту —
 * `pause.initiatorId` в состоянии игры, а сайт поле просто не показывает
 * (проверено по room/bundle/main.js 08.08.2026: `t.pause &&
 * t.pause.initiatorId && (f = t.pause.initiatorId)`, дальше значение
 * уезжает в обработчик, который его не читает). Достать можно только из
 * сокета, а сокет живёт в мире страницы: у isolated world контент-скрипта
 * свой `window.WebSocket`, подмена там сокетов сайта не видит.
 *
 * ПРИВАТНОСТЬ — главное ограничение этого файла. Через комнатный сокет идёт
 * всё: роли, ночные действия, чужие голоса. Наружу уходит РОВНО одно число
 * (id инициатора паузы) и признак «пауза кончилась». Тела сообщений не
 * пересылаются, не логируются и нигде не сохраняются — тот же принцип, что
 * в conn-diag после аудита безопасности 01.08.2026.
 *
 * НЕ ЛОМАТЬ САЙТ — второе ограничение, и оно диктует форму перехвата:
 *  - хукаем ТОЛЬКО сеттер `onmessage`. Игровой сокет подписывается именно
 *    так (`this.ws.onmessage = e => this.onData(e.data)`), а вот обёртка
 *    `addEventListener` была бы вредной: она регистрирует другую функцию,
 *    и `removeEventListener` сайта перестаёт снимать свой слушатель. В
 *    комнате так подписан сигнальный сокет медиа (Janus), который свои
 *    слушатели снимает при разрушении сессии — мы сломали бы ему teardown
 *    ради нуля кадров паузы (ревью 08.08.2026, блокер);
 *  - наш разбор идёт ПОСЛЕ обработчика сайта и под try/catch: исключение у
 *    нас не имеет права съесть кадр игры.
 *
 * ВАЖНО: файл самодостаточен — никаких импортов из core/* (в мире страницы
 * нет ни browser.*, ни наших модулей).
 */

interface ProbeWindow extends Window {
  __pnRoomProbeInstalled?: boolean;
}

/** События паузы: инициатор может прийти прямо в пейлоаде. */
const PAUSE_EVENTS = ["on_start_pause", "on_update_pause_time"];
/** Полное состояние игры: инициатор лежит в объекте `pause`. */
const STATE_EVENT = "on_detailed_game_state";
const END_EVENT = "on_finish_pause";

export interface PauseSignal {
  /** id инициатора; null — событие про паузу есть, а инициатора в нём нет. */
  initiatorId: number | null;
  /** Пауза закончилась — подпись пора убирать. */
  finished: boolean;
  /** Какое событие принесло сигнал — нужно для разбора жалоб по логу. */
  event?: string;
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
  // Дешёвый предфильтр: подавляющее большинство кадров — не про паузу.
  if (raw.indexOf("pause") < 0) return null;
  const at = raw.indexOf("[");
  if (at < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(at));
  } catch {
    return null;
  }
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

(() => {
  const w = window as ProbeWindow;
  if (w.__pnRoomProbeInstalled) return;
  w.__pnRoomProbeInstalled = true;

  const send = (signal: PauseSignal): void => {
    try {
      window.postMessage({ source: "pn-room-probe", ...signal }, location.origin);
    } catch {
      /* страница уходит — сказать уже некому */
    }
  };

  /** Разбор в изоляции: наша ошибка не должна касаться игры. */
  const handle = (raw: unknown): void => {
    try {
      const signal = readPauseFrame(raw);
      if (signal) {
        send(signal);
        return;
      }
      // Кадр про паузу, который мы НЕ поняли: сообщаем одно лишь имя
      // события. Без этого лог не отличает «сервер молчит» от «сервер
      // назвал событие иначе» — тупик разбора 09.08.2026.
      if (typeof raw === "string" && raw.indexOf("pause") >= 0) {
        const name = frameEventName(raw);
        if (name) window.postMessage({ source: "pn-room-probe", unrecognized: name }, location.origin);
      }
    } catch {
      /* кадр не наш и не разобрался — молчим */
    }
  };

  /**
   * Хук ставится на ПРОТОТИП, а не на конструктор: engine.io сохраняет
   * ссылку на `WebSocket` в момент вычисления своего модуля, то есть до нас,
   * и подменённый конструктор такой сокет обошёл бы стороной (урок
   * conn-diag, аудит устойчивости 01.08.2026, находка 16). Прототип общий
   * для любого экземпляра.
   *
   * Зонд инжектится на document_start — раньше, чем комната создаёт сокет,
   * поэтому обёртка ловит подписку игры и все её входящие кадры.
   */
  const proto = WebSocket.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
  if (!desc?.set || !desc.get) return;
  Object.defineProperty(proto, "onmessage", {
    configurable: true,
    enumerable: desc.enumerable,
    get(this: WebSocket) {
      return desc.get!.call(this);
    },
    set(this: WebSocket, fn: unknown) {
      const wrapped =
        typeof fn === "function"
          ? function (this: WebSocket, e: Event) {
              // Сначала игра, потом мы: порядок — часть предохранителя.
              const result = (fn as (ev: Event) => unknown).call(this, e);
              handle((e as MessageEvent).data);
              return result;
            }
          : fn;
      return desc.set!.call(this, wrapped);
    },
  });

  /**
   * Метка «зонд установлен» — атрибутом на <html>, а не сообщением: content
   * -скрипт стартует позже нас, и разовый postMessage он бы уже не застал.
   * Без такой метки по логу нельзя отличить «паузы не было» от «зонд не
   * встал» — ровно тот тупик, в который упёрся разбор лога 09.08.2026.
   */
  document.documentElement.setAttribute(PROBE_MARK_ATTR, "1");
})();
