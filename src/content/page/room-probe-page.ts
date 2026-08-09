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

import {
  type PauseSignal,
  PROBE_MARK_ATTR,
  frameEventName,
  isEnvelopeFrame,
  readPauseFrame,
} from "./room-probe-parse";

interface ProbeWindow extends Window {
  __pnRoomProbeInstalled?: boolean;
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

  /** Пауза уже объявлена наружу — чтобы «паузы нет» слать только переходом. */
  let pauseReported = false;

  /**
   * Полный лог кадров — ВЫКЛЮЧЕН, пока расширение прямо не попросит.
   *
   * Команду шлёт content-скрипт: настройки живут в storage расширения, а он
   * асинхронный, и читать его здесь, в мире страницы, нечем. Подделать
   * команду может и сама страница — но это ничего ей не даёт: кадры её
   * собственного сокета она и так видит, а наружу они не уходят.
   */
  let frameLogOn = false;
  const LOG_CMD = "pn-ws-log-cmd";

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const d = e.data as { source?: string; on?: unknown };
    if (d?.source !== LOG_CMD) return;
    frameLogOn = d.on === true;
  });

  const sendFrame = (dir: "in" | "out", raw: unknown): void => {
    if (!frameLogOn || typeof raw !== "string") return;
    try {
      window.postMessage({ source: "pn-room-probe", frame: { dir, raw } }, location.origin);
    } catch {
      /* страница уходит — сказать уже некому */
    }
  };

  /** Разбор в изоляции: наша ошибка не должна касаться игры. */
  const handle = (raw: unknown): void => {
    try {
      sendFrame("in", raw);
      const signal = readPauseFrame(raw);
      if (signal) {
        if (signal.finished) {
          // Состояние без паузы приезжает с КАЖДЫМ кадром комнаты, то есть
          // пачками на любое действие за столом. Без этого гейта мы будили
          // бы подписчика и перерисовку впустую весь матч.
          if (!pauseReported) return;
          pauseReported = false;
        } else {
          pauseReported = true;
        }
        send(signal);
        return;
      }
      // Кадр про паузу, который мы НЕ поняли: сообщаем одно лишь имя
      // события. Конверты сюда не попадают — они разобраны выше, а их общее
      // имя «events» только глушило бы диагностику (разбор 09.08.2026:
      // первый же кадр при входе съедал строку на весь матч).
      if (typeof raw === "string" && !isEnvelopeFrame(raw) && raw.indexOf("pause") >= 0) {
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
   * Исходящие кадры — для полного лога.
   *
   * Обёртка над `send` безопаснее, чем над addEventListener: она не подменяет
   * ничьих ссылок и ничего не ломает при отписке (тот блокер 08.08.2026).
   * Сначала отдаём кадр сокету и только потом копируем себе: наша ошибка не
   * имеет права задержать отправку хода игрока. При выключенном логе
   * обёртка стоит копейки — одна проверка флага.
   */
  const originalSend = proto.send;
  proto.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    const result = originalSend.call(this, data);
    try {
      sendFrame("out", data);
    } catch {
      /* копия кадра не удалась — игре это безразлично */
    }
    return result;
  };

  /**
   * Метка «зонд установлен» — атрибутом на <html>, а не сообщением: content
   * -скрипт стартует позже нас, и разовый postMessage он бы уже не застал.
   * Без такой метки по логу нельзя отличить «паузы не было» от «зонд не
   * встал» — ровно тот тупик, в который упёрся разбор лога 09.08.2026.
   */
  document.documentElement.setAttribute(PROBE_MARK_ATTR, "1");
})();
