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

  /**
   * Структурное описание фрейма БЕЗ его содержимого.
   *
   * Раньше сюда уезжали куски тел («WS send <первые 64 символа>»), а лог
   * потом уходит в файл, который пользователь шлёт в поддержку: в кадре
   * `40/search?userId=…&authKey=…` это прямая утечка ключа сессии, в кадре
   * handshake — sid (аудит безопасности 01.08.2026, находка 9). Для
   * диагностики хватает кода engine.io, имени события и длины.
   */
  const frame = (raw: unknown): string => {
    const s = String(raw);
    if (s === "2") return "ping->";
    if (s === "3") return "pong<-";
    const code = /^\d{1,2}/.exec(s)?.[0] ?? "?";
    // 42["event"] и 42/search,["event"] — имя события не секрет и очень
    // помогает в разборе; очередь работает именно в неймспейсе /search,
    // поэтому вариант с ним обязателен.
    const evt = /^\d{1,2}(?:\/[A-Za-z0-9_/-]{0,40})?,?\["([A-Za-z0-9_.:-]{1,40})"/.exec(s)?.[1];
    // Неймспейс без query: «40/search?userId=…&authKey=…» → «40/search».
    const ns = /^\d{1,2}(\/[A-Za-z0-9_/-]{0,40})/.exec(s)?.[1];
    const kind =
      code === "0" ? "handshake" : code === "40" ? "ns-connect" : code === "42" ? "event" : code;
    return `${kind}${ns ? ` ${ns}` : ""}${evt ? ` ${evt}` : ""} len=${s.length}`;
  };

  const PatchedWS = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const ws = protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
    const label = shortUrl(url);
    say(`WS OPEN-ATTEMPT ${label}`);

    ws.addEventListener("open", () => say(`WS OPEN ${label}`));
    // engine.io v3: "0{handshake}", "3" — pong сервера, "40…" — connect
    // неймспейса, "42[…]" — событие. Пишем только структуру (см. frame()).
    ws.addEventListener("message", (e: MessageEvent) => say(`WS msg ${frame(e.data)}`));
    const realSend = ws.send.bind(ws);
    ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
      say(`WS send ${frame(data)}`);
      return realSend(data);
    };
    ws.addEventListener("close", (e: CloseEvent) =>
      say(
        `WS CLOSE ${label} code=${e.code} clean=${e.wasClean} reasonLen=${(e.reason || "").length}`,
      ),
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
    say(`WS send ${frame(data)} ${shortUrl(this.url)}`);
    return nativeSend.call(this, data);
  };

  const describe = (ws: WebSocket, type: string, e: Event): void => {
    const label = shortUrl(ws.url);
    if (type === "message") {
      say(`WS msg ${frame((e as MessageEvent).data)} ${label}`);
      return;
    }
    if (type === "close") {
      const c = e as CloseEvent;
      // reason — строка от сервера; в лог идёт только её длина.
      say(
        `WS CLOSE ${label} code=${c.code} clean=${c.wasClean} reasonLen=${(c.reason || "").length}`,
      );
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

  /**
   * ЧЕСТНО об ограничении охвата.
   *
   * Зонд инжектится контент-скриптом на document_end, а обёртки свойств
   * (onopen/onmessage/…) перехватывают только БУДУЩИЕ присваивания: у сокета,
   * созданного и подписанного раньше нас, входящие события останутся
   * невидимыми — в логе будут только его исходящие кадры (их ловит обёртка
   * prototype.send, общая для всех экземпляров). Без этой строки отчёт
   * «почему выкинуло из очереди» можно было принять за полный, хотя половины
   * событий в нём нет (аудит устойчивости 01.08.2026, находка 16).
   *
   * Полный охват потребовал бы инжекта на document_start у ВСЕХ, кто открыл
   * страницу поиска, — цена, несоразмерная выключенной по умолчанию
   * диагностике. Практически сокет очереди создаётся при клике «Играть», то
   * есть заведомо позже нас; риск неполноты касается реконнекта и
   * восстановления сессии.
   */
  // ВНИМАНИЕ на имя: late === «мы поздно». В текущей схеме зонд ставится из
  // enable() фичи (после асинхронного чтения настроек), то есть заведомо
  // позже document_end — метка всегда new-sockets-only. Ветка full — задел
  // на случай, если инжект когда-нибудь переедет на document_start.
  const late = document.readyState !== "loading";
  say(
    `page probe installed (prototype hooks active, inboundHooked=${late ? "new-sockets-only" : "full"})`,
  );
})();
