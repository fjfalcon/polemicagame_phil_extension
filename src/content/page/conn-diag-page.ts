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

  say("page probe installed");
})();
