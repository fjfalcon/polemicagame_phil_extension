/**
 * Зонд комнаты — PAGE-скрипт (мир страницы).
 *
 * Единственная задача: отдавать расширению кадры игрового сокета для полного
 * лога общения с сервером. Из мира content-скрипта это невозможно — у
 * изолированного мира свой `window.WebSocket`, и сокеты сайта оттуда не видны.
 *
 * Зонд родился ради подписи «кто поставил паузу» и разбор кадров жил прямо
 * здесь. Полный лог 09.08.2026 показал, что сервер инициатора паузы не
 * присылает вовсе, фичу убрали — а зонд остался, потому что оказался
 * полезнее исходной задачи: он и позволил это выяснить.
 *
 * ПРИВАТНОСТЬ. Через комнатный сокет идёт всё: роли, ночные действия, чат.
 * Поэтому зонд ставится ТОЛЬКО при включённой настройке «Полный лог общения
 * с сервером» (по умолчанию выключена, гейт в room-probe-inject), пересылку
 * кадров отдельно разрешает content-скрипт командой, а отбор, вырезание
 * секретов и потолки — на стороне расширения (core/ws-log).
 *
 * НЕ ЛОМАТЬ САЙТ — второе ограничение, и оно диктует форму перехвата:
 *  - хукаем сеттер `onmessage`, а не `addEventListener`: последний
 *    регистрирует другую функцию, и `removeEventListener` сайта перестаёт
 *    снимать свой слушатель. В комнате так подписан сигнальный сокет медиа
 *    (Janus), который снимает слушатели при разрушении сессии — мы сломали
 *    бы ему teardown (ревью 08.08.2026, блокер);
 *  - сначала кадр уходит игре, и только потом копия нам, всё под try/catch:
 *    наша ошибка не имеет права съесть кадр игры или задержать ход игрока.
 *
 * ВАЖНО: файл самодостаточен — никаких импортов (в мире страницы нет ни
 * browser.*, ни наших модулей).
 */

interface ProbeWindow extends Window {
  __pnRoomProbeInstalled?: boolean;
}

/** Маркер «зонд на месте»: читается content-скриптом без гонок с postMessage. */
export const PROBE_MARK_ATTR = "data-pn-room-probe-ready";

(() => {
  const w = window as ProbeWindow;
  if (w.__pnRoomProbeInstalled) return;
  w.__pnRoomProbeInstalled = true;

  /**
   * Пересылка кадров — ВЫКЛЮЧЕНА, пока расширение прямо не попросит.
   *
   * Команду шлёт content-скрипт: настройки живут в storage расширения, а он
   * асинхронный, и читать его здесь нечем. Подделать команду может и сама
   * страница — но это ничего ей не даёт: кадры своего сокета она и так
   * видит, а наружу они не уходят.
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
              try {
                sendFrame("in", (e as MessageEvent).data);
              } catch {
                /* копия кадра не удалась — игре это безразлично */
              }
              return result;
            }
          : fn;
      return desc.set!.call(this, wrapped);
    },
  });

  /**
   * Исходящие кадры: по ним видно, что именно сайт и расширение просят у
   * сервера. Обёртка над `send` безопаснее, чем над addEventListener — она
   * не подменяет ничьих ссылок и не мешает отписке.
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
   * Без метки «лог пуст, потому что зонд не встал» неотличимо от «лог пуст,
   * потому что настройку включили после игры» — тупик, в который разбор уже
   * упирался (09.08.2026).
   */
  document.documentElement.setAttribute(PROBE_MARK_ATTR, "1");
})();
