/**
 * Диагностика подключения очереди поиска — PAGE-скрипт (MAIN world).
 *
 * Живёт в мире страницы, потому что у isolated world контент-скрипта СВОЙ
 * window.WebSocket — подмена там не увидела бы сокеты сайта. Инжектится
 * фичей connection-diag тегом <script src=...> (web_accessible_resources);
 * CSP у сайта нет (проверено 26.07.2026).
 *
 * ВАЖНО: этот файл самодостаточен — никаких импортов из core/* (там
 * browser.* API, которых в мире страницы не существует).
 *
 * Наружу шлёт window.postMessage({ source: "pn-conn-diag", line }, origin) —
 * контент-скрипт пишет их в общий лог расширения. Останавливается по
 * сообщению { source: "pn-conn-diag-stop" } (сам прокси при этом остаётся —
 * снять подмену конструктора безопасно нельзя, он просто замолкает).
 */

interface DiagWindow extends Window {
  __pnConnDiagInstalled?: boolean;
  __pnConnDiagSilenced?: boolean;
}

(() => {
  const w = window as DiagWindow;
  // Повторный инжект (переключение тумблера туда-сюда) — молча выходим.
  if (w.__pnConnDiagInstalled) {
    w.__pnConnDiagSilenced = false;
    return;
  }
  w.__pnConnDiagInstalled = true;
  w.__pnConnDiagSilenced = false;

  const t0 = Date.now();
  const say = (line: string) => {
    if (w.__pnConnDiagSilenced) return;
    try {
      window.postMessage({ source: "pn-conn-diag", t: Date.now() - t0, line }, location.origin);
    } catch {
      /* страница умирает — молчим */
    }
  };

  window.addEventListener("message", (e) => {
    if (e.source === window && (e.data as { source?: string })?.source === "pn-conn-diag-stop") {
      w.__pnConnDiagSilenced = true;
    }
  });

  const RealWS = window.WebSocket;
  const shortUrl = (u: unknown) => String(u).replace(/\?.*/, "?…");

  const PatchedWS = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const ws = protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
    const label = shortUrl(url);
    say(`WS OPEN-ATTEMPT ${label}`);

    ws.addEventListener("open", () => say(`WS OPEN ${label}`));
    ws.addEventListener("message", (e: MessageEvent) => {
      const d = String(e.data);
      // engine.io v3: "0{handshake}" (внутри pingInterval/pingTimeout!),
      // "3" — pong сервера, "40..." — connect неймспейса, "42[...]" — событие.
      if (d[0] === "0") say(`WS HANDSHAKE ${d.slice(0, 200)}`);
      else if (d === "3") say("WS pong<-");
      else if (d.length <= 48) say(`WS msg ${d}`);
      else say(`WS msg(${d.length}) ${d.slice(0, 32)}…`);
    });
    const realSend = ws.send.bind(ws);
    ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
      const s = String(data);
      if (s === "2") say("WS ping->");
      else if (s.length <= 64) say(`WS send ${s}`);
      else say(`WS send(${s.length}) ${s.slice(0, 32)}…`);
      return realSend(data);
    };
    ws.addEventListener("close", (e: CloseEvent) =>
      say(`WS CLOSE ${label} code=${e.code} clean=${e.wasClean} reason=${e.reason || "-"}`),
    );
    ws.addEventListener("error", () => say(`WS ERROR ${label}`));
    return ws;
  } as unknown as typeof WebSocket;

  PatchedWS.prototype = RealWS.prototype;
  // Статические константы (CONNECTING и пр.) — некоторые либы их читают.
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(PatchedWS, k, { value: RealWS[k] });
  }
  window.WebSocket = PatchedWS;

  /**
   * ГЛАВНЫЙ перехват — на ПРОТОТИПЕ, а не на конструкторе.
   *
   * Подмены window.WebSocket недостаточно: engine.io-client (socket.io v2,
   * на нём работает очередь поиска) сохраняет ссылку на конструктор в момент
   * ВЫЧИСЛЕНИЯ СВОЕГО МОДУЛЯ — `if (typeof WebSocket != "undefined") a =
   * WebSocket; ... var u = a || r` (game-search.js, модуль 46855). Это
   * происходит при загрузке бандла сайта, то есть заведомо раньше, чем
   * content-скрипт успевает инжектить зонд. Сокет очереди создавался мимо
   * подменённого конструктора — в логе была только Яндекс-метрика, которая
   * берёт WebSocket в момент вызова.
   *
   * Прототип общий для ЛЮБОГО экземпляра, кем бы он ни был создан, поэтому
   * обёртки ниже ловят и «ранние» сокеты. URL берём из самого экземпляра.
   */
  const proto = RealWS.prototype;

  const nativeSend = proto.send;
  proto.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    const s = String(data);
    const label = shortUrl(this.url);
    if (s === "2") say(`WS ping-> ${label}`);
    else if (s.length <= 64) say(`WS send ${s} ${label}`);
    else say(`WS send(${s.length}) ${s.slice(0, 32)}… ${label}`);
    return nativeSend.call(this, data);
  };

  const describe = (ws: WebSocket, type: string, e: Event): void => {
    const label = shortUrl(ws.url);
    if (type === "message") {
      const d = String((e as MessageEvent).data);
      if (d[0] === "0") say(`WS HANDSHAKE ${label} ${d.slice(0, 200)}`);
      else if (d === "3") say(`WS pong<- ${label}`);
      else if (d.length <= 48) say(`WS msg ${d} ${label}`);
      else say(`WS msg(${d.length}) ${d.slice(0, 32)}… ${label}`);
      return;
    }
    if (type === "close") {
      const c = e as CloseEvent;
      say(`WS CLOSE ${label} code=${c.code} clean=${c.wasClean} reason=${c.reason || "-"}`);
      return;
    }
    say(`WS ${type.toUpperCase()} ${label}`);
  };

  // 1. Свойства-обработчики (engine.io ставит именно их: ws.onmessage = ...).
  for (const prop of ["onopen", "onmessage", "onclose", "onerror"] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.set || !desc.get) continue;
    const type = prop.slice(2);
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: WebSocket) {
        return desc.get!.call(this);
      },
      set(this: WebSocket, fn: unknown) {
        const wrapped =
          typeof fn === "function"
            ? function (this: WebSocket, e: Event) {
                describe(this, type, e);
                return (fn as (ev: Event) => unknown).call(this, e);
              }
            : fn;
        return desc.set!.call(this, wrapped);
      },
    });
  }

  // 2. addEventListener — на случай, если библиотека подпишется так.
  const nativeAdd = proto.addEventListener;
  proto.addEventListener = function (
    this: WebSocket,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (["open", "message", "close", "error"].includes(type) && typeof listener === "function") {
      const wrapped = (e: Event) => {
        describe(this, type, e);
        return (listener as EventListener).call(this, e);
      };
      return nativeAdd.call(this, type, wrapped, options);
    }
    return nativeAdd.call(this, type, listener, options);
  };

  say("page probe installed (prototype hooks active)");
})();
