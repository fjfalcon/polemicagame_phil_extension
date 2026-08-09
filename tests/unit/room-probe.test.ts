// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Зонд комнаты: перехват сокета и гейт раннего инжекта.
 *
 * Ревью 08.08.2026 показало, что вся эта часть была не покрыта вовсе —
 * выживали мутанты «убрать оба хука», «targetOrigin: *», «снять антиспуф».
 * Здесь исполняется САМ модуль зонда (его IIFE патчит прототип), а не только
 * чистая функция разбора.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PROBE_FLAG_KEY, WS_LOG_FLAG_KEY, injectProbe, probeAllowed } from "@content/page/room-probe-inject";
import { findInitiator, isEnvelopeFrame, pausedTimer, readPauseFrame } from "@content/page/room-probe-parse";

/** Оригинальный дескриптор — вернём после каждого теста. */
const originalOnMessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
const originalAdd = WebSocket.prototype.addEventListener;

async function installProbe(): Promise<void> {
  vi.resetModules();
  (window as { __pnRoomProbeInstalled?: boolean }).__pnRoomProbeInstalled = false;
  await import("@content/page/room-probe-page");
}

/** Кадр socket.io с паузой (движок шлёт их с префиксом «42»). */
const pauseFrame = `42${JSON.stringify(["on_start_pause", { time: 60, initiatorId: 3 }])}`;

/**
 * Конверт нового протокола — то, что реально приезжает в живой комнате
 * (лог владельца 09.08.2026). Пауза здесь — замороженный таймер (`passed`),
 * отдельного события паузы сервер не шлёт вовсе.
 */
function envelope(state: Record<string, unknown>, type = "roomState"): string {
  return `42${JSON.stringify(["events", { type, data: state }])}`;
}

const runningState = {
  stage: { type: "speech", day: 1, player: 3 },
  timer: { duration: 60000, passed: null },
  players: [{ position: 1, username: "СекретныйНик", timer: null, actions: ["vote"] }],
  actions: ["pause"],
};
const pausedState = {
  ...runningState,
  timer: { duration: 60000, passed: 12000, tillEnd: 48000, initiatorId: 4 },
};
const runningFrame = envelope(runningState);
const pausedFrame = envelope(pausedState);

/**
 * Команда «писать кадры», какую шлёт content-скрипт. Событие доставляем
 * синхронно: postMessage в jsdom асинхронный, а слушатель зонда нам нужен
 * прямо сейчас.
 */
function startFrameLog(): void {
  window.dispatchEvent(
    new MessageEvent("message", { data: { source: "pn-ws-log-cmd", on: true }, source: window }),
  );
}

/**
 * Настоящий WebSocket: подделка объекта с подменённым прототипом не годится
 * — нативный сеттер `onmessage` требует внутренний слот и бросает на чужом
 * объекте. Соединение никуда не идёт, ошибки подключения гасим.
 */
function makeSocket(): WebSocket {
  const ws = new WebSocket("ws://127.0.0.1:1/probe-test");
  ws.onerror = () => {};
  return ws;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // В jsdom нет расширенческого API — инжектору нужен только getURL.
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { getURL: (p: string) => `moz-extension://test/${p}` },
  };
  // …и нет localStorage (нужен ключ запуска ноды), а гейт читает именно его.
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

afterEach(() => {
  if (originalOnMessage) {
    Object.defineProperty(WebSocket.prototype, "onmessage", originalOnMessage);
  }
  WebSocket.prototype.addEventListener = originalAdd;
  (window as { __pnRoomProbeInstalled?: boolean }).__pnRoomProbeInstalled = false;
});

describe("гейт раннего инжекта", () => {
  test("выключенная настройка (зеркало «0») запрещает зонд", () => {
    expect(probeAllowed({ getItem: () => "0" })).toBe(false);
  });

  test("включённая и первый заход (ключа нет) — разрешают", () => {
    expect(probeAllowed({ getItem: () => "1" })).toBe(true);
    expect(probeAllowed({ getItem: () => null }), "нет ключа — дефолт настройки").toBe(true);
  });

  test("недоступное хранилище не роняет инжектор", () => {
    // Приватный режим запрещает localStorage целиком — падать нельзя.
    const throwing = {
      getItem() {
        throw new Error("SecurityError");
      },
    };
    expect(() => probeAllowed(throwing)).not.toThrow();
    expect(probeAllowed(throwing)).toBe(true);
    expect(probeAllowed(null)).toBe(true);
  });

  test("выключённая настройка — тега зонда на странице НЕ появляется", () => {
    document.head.innerHTML = "";
    localStorage.setItem(PROBE_FLAG_KEY, "0");
    injectProbe();
    expect(document.querySelector("script[data-pn-room-probe]")).toBeNull();
  });

  test("включённая настройка — тег ставится, повторный вызов не дублирует", () => {
    document.head.innerHTML = "";
    localStorage.setItem(PROBE_FLAG_KEY, "1");
    injectProbe();
    injectProbe();
    expect(document.querySelectorAll("script[data-pn-room-probe]")).toHaveLength(1);
    // Порядок исполнения важен: динамический скрипт по умолчанию async, а
    // зонд обязан встать ДО бандла сайта.
    expect(document.querySelector<HTMLScriptElement>("script[data-pn-room-probe]")?.async).toBe(
      false,
    );
  });

  test("полный лог поднимает зонд даже при выключенной подписи паузы", () => {
    // У двух потребителей зонда разные дефолты. Выключив подпись, человек не
    // должен незаметно лишиться лога, который сам только что включил.
    const store = new Map([
      [PROBE_FLAG_KEY, "0"],
      [WS_LOG_FLAG_KEY, "1"],
    ]);
    expect(probeAllowed({ getItem: (k: string) => store.get(k) ?? null })).toBe(true);
    store.set(WS_LOG_FLAG_KEY, "0");
    expect(
      probeAllowed({ getItem: (k: string) => store.get(k) ?? null }),
      "обе настройки выключены — зонда быть не должно",
    ).toBe(false);
  });

  test("ключ зеркала совпадает с тем, что пишет content-скрипт", async () => {
    // Разъедься они — выключатель молча перестанет действовать.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/index.ts", "utf8");
    expect(src).toContain("PROBE_FLAG_KEY");
    expect(PROBE_FLAG_KEY).toBe("pn_room_probe");
  });
});

describe("конверт нового протокола", () => {
  test("пауза в состоянии комнаты распознаётся, место приводится к 0-based", () => {
    // Сайт сам пишет `v.player - 1` — ссылки на игрока здесь единичные.
    const signal = readPauseFrame(pausedFrame);
    expect(signal).toMatchObject({ initiatorId: 3, finished: false, event: "events/roomState" });
    expect(signal?.raw, "сырое значение — чтобы промах на единицу был виден в логе").toBe(
      "initiatorId=4",
    );
  });

  test("состояние без паузы — сигнал «паузу сняли»", () => {
    expect(readPauseFrame(runningFrame)).toMatchObject({ finished: true, initiatorId: null });
  });

  test("чужой тип конверта без паузы подпись не гасит", () => {
    // Иначе любой посторонний кадр стирал бы подпись посреди паузы.
    expect(readPauseFrame(envelope(runningState, "chatMessage"))).toBeNull();
  });

  test("пауза есть, инициатора нет — отдаём ИМЕНА полей, без значений", () => {
    const noInitiator = {
      ...runningState,
      timer: { duration: 60000, passed: 12000, tillEnd: 48000 },
    };
    const signal = readPauseFrame(envelope(noInitiator));
    expect(signal).toMatchObject({ initiatorId: null, finished: false });
    expect(signal?.schema).toContain("passed");
    expect(signal?.schema, "ник игрока наружу уходить не должен").not.toContain("СекретныйНик");
    expect(signal?.schema).toContain("username");
  });

  test("инициатор ищется по имени поля на любой глубине", () => {
    // Жёсткий путь уже дважды промахнулся — сервер волен переложить поле.
    expect(findInitiator({ a: { b: { pauseInitiator: 7 } } })).toEqual({
      key: "pauseInitiator",
      value: 7,
    });
    expect(findInitiator({ initiatorId: -1 }), "«никого» — не игрок").toBeNull();
    expect(findInitiator({ initiatorId: "4" }), "строка — не место за столом").toBeNull();
    expect(findInitiator({ playerId: 4 }), "чужое поле не подходит").toBeNull();
  });

  test("правило паузы повторяет сайт: замороженный таймер", () => {
    expect(pausedTimer({ timer: { passed: 0 }, players: [] }), "passed=0 — тоже пауза").toEqual({
      passed: 0,
    });
    expect(pausedTimer({ timer: { duration: 60000 }, players: [] })).toBeNull();
    // Единственный игрок с таймером — тоже пауза (функция LA сайта).
    expect(pausedTimer({ players: [{ timer: { passed: 5 } }, { timer: null }] })).toEqual({
      passed: 5,
    });
    // …а двое одновременно — это уже не пауза, а обычный ход.
    expect(pausedTimer({ players: [{ timer: { passed: 5 } }, { timer: { passed: 7 } }] })).toBeNull();
  });

  test("конверт узнаётся по началу кадра, а не по всему телу", () => {
    // Массив, который НАЧИНАЕТСЯ со строки "events", в теле чужого кадра —
    // совершенно законный JSON и никакого экранирования не получает. Ищи мы
    // подстроку по всему кадру, такой кадр притворился бы конвертом; заодно
    // поиск гонялся бы по десяткам килобайт на каждом сообщении сокета.
    expect(isEnvelopeFrame(runningFrame)).toBe(true);
    const foreign = `42["on_message",{"messageTags":["events","chat"]}]`;
    expect(foreign.indexOf('["events"'), "подстрока в теле есть — важно, что не в начале").toBeGreaterThan(
      24,
    );
    expect(isEnvelopeFrame(foreign)).toBe(false);
  });

  test("ЖИВЫЕ кадры комнаты: пауза, речь и выкрик различаются", async () => {
    // Кадры сняты полным логом в настоящей игре 09.08.2026 (обезличены).
    // Три предыдущие версии фичи молчали в бою при зелёных тестах — эта
    // фикстура и есть то, чего им не хватало.
    const fs = await import("node:fs");
    const real = JSON.parse(fs.readFileSync("tests/fixtures/room-frames.json", "utf8")) as
      Record<"speech" | "outcry" | "pause", string>;

    expect(readPauseFrame(real.pause), "пауза обязана распознаться").toMatchObject({
      finished: false,
      event: "events/roomState",
    });
    // Выкрик: речь тоже заморожена, но это НЕ пауза — иначе подпись
    // выскакивала бы посреди игры по нескольку раз за круг.
    expect(readPauseFrame(real.outcry)).toBeNull();
    expect(readPauseFrame(real.speech)).toMatchObject({ finished: true });

    // И главный факт, ради которого лог снимался: инициатора на проводе нет.
    expect(real.pause, "появится поле — фича сразу оживёт").not.toMatch(/initiator/i);
  });

  test("системная заморозка таймера паузой не считается", () => {
    // Тот же выкрик, но если бы игрок с таймером остался один.
    const system = {
      players: [{ position: 6, timer: { duration: 60000, passed: 13320, isSystem: true } }],
    };
    expect(pausedTimer(system)).toBeNull();
  });

  test("старый протокол по-прежнему понимается", () => {
    // Обе ветки живут одновременно: какая работает — зависит от версии комнаты.
    expect(readPauseFrame(pauseFrame)).toMatchObject({ initiatorId: 3, event: "on_start_pause" });
  });
});

describe("перехват сокета", () => {
  test("сеттер onmessage обёрнут: игра получает кадр, мы — сигнал", async () => {
    await installProbe();
    const posted: unknown[] = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      posted.push(msg);
    }) as typeof window.postMessage);

    const ws = makeSocket();
    const gameHandler = vi.fn();
    ws.onmessage = gameHandler;
    // Вызываем так, как это делает браузер.
    (ws.onmessage as (e: MessageEvent) => void).call(
      ws,
      new MessageEvent("message", { data: pauseFrame }),
    );

    expect(gameHandler, "кадр обязан дойти до игры").toHaveBeenCalledTimes(1);
    expect(posted).toEqual([
      { source: "pn-room-probe", initiatorId: 3, finished: false, event: "on_start_pause" },
    ]);
    postSpy.mockRestore();
  });

  test("сообщение адресуется своему origin, а не всем подряд", async () => {
    await installProbe();
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation((() => {}) as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    (ws.onmessage as (e: MessageEvent) => void).call(
      ws,
      new MessageEvent("message", { data: pauseFrame }),
    );
    expect(postSpy).toHaveBeenCalledWith(expect.anything(), location.origin);
    postSpy.mockRestore();
  });

  test("игра получает кадр ПЕРВОЙ, наш разбор идёт следом", async () => {
    // Порядок — часть предохранителя «не ломать сайт»: пока мы не отдали
    // кадр игре, любая наша задержка или ошибка задевала бы саму игру.
    await installProbe();
    const order: string[] = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((() => {
      order.push("probe");
    }) as unknown) as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => order.push("game");
    (ws.onmessage as (e: MessageEvent) => void).call(
      ws,
      new MessageEvent("message", { data: pauseFrame }),
    );
    expect(order).toEqual(["game", "probe"]);
    postSpy.mockRestore();
  });

  test("наша ошибка не мешает игре получить кадр", async () => {
    await installProbe();
    // postMessage бросает (как DataCloneError в жизни) — игра не должна
    // потерять сообщение из-за нас.
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation((() => {
      throw new Error("DataCloneError");
    }) as typeof window.postMessage);
    const ws = makeSocket();
    const gameHandler = vi.fn();
    ws.onmessage = gameHandler;
    expect(() =>
      (ws.onmessage as (e: MessageEvent) => void).call(
        ws,
        new MessageEvent("message", { data: pauseFrame }),
      ),
    ).not.toThrow();
    expect(gameHandler).toHaveBeenCalledTimes(1);
    postSpy.mockRestore();
  });

  test("зонд оставляет метку на <html>: по логу видно, что он встал", async () => {
    // Без метки разбор жалобы «пауза была, подписи нет» упирается в
    // догадки: «зонд не встал» и «сервер молчит» выглядят одинаково
    // (разбор 09.08.2026).
    document.documentElement.removeAttribute("data-pn-room-probe-ready");
    await installProbe();
    expect(document.documentElement.getAttribute("data-pn-room-probe-ready")).toBe("1");
  });

  test("кадр про паузу с незнакомым именем — сообщаем имя, не тело", async () => {
    await installProbe();
    const posted: Array<Record<string, unknown>> = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => {
      posted.push(m);
    }) as unknown as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    (ws.onmessage as (e: MessageEvent) => void).call(
      ws,
      new MessageEvent("message", {
        data: `42${JSON.stringify(["on_pause_changed", { initiatorId: 4, secret: "роль" }])}`,
      }),
    );
    expect(posted).toEqual([{ source: "pn-room-probe", unrecognized: "on_pause_changed" }]);
    expect(JSON.stringify(posted), "тело кадра наружу не уходит").not.toContain("роль");
    postSpy.mockRestore();
  });

  test("addEventListener НЕ трогаем: иначе сайт не снимет свой слушатель", async () => {
    // В комнате так подписан сигнальный сокет медиа (Janus) и он свои
    // слушатели снимает при разрушении сессии. Обёртка ломала бы teardown
    // ради нуля кадров паузы (ревью 08.08.2026, блокер).
    const before = WebSocket.prototype.addEventListener;
    await installProbe();
    expect(WebSocket.prototype.addEventListener).toBe(before);

    const target = new EventTarget();
    const handler = vi.fn();
    target.addEventListener("message", handler);
    target.removeEventListener("message", handler);
    target.dispatchEvent(new MessageEvent("message", { data: pauseFrame }));
    expect(handler, "снятый слушатель не должен вызываться").not.toHaveBeenCalled();
  });

  test("состояние без паузы молчит, пока паузы не было (иначе шум весь матч)", async () => {
    // Кадр «паузы нет» приезжает с каждым действием за столом. Слать его
    // всегда — значит будить перерисовку сотни раз за игру.
    await installProbe();
    const posted: Array<Record<string, unknown>> = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => {
      posted.push(m);
    }) as unknown as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    const fire = (frame: string): void =>
      (ws.onmessage as (e: MessageEvent) => void).call(ws, new MessageEvent("message", { data: frame }));

    fire(runningFrame);
    fire(runningFrame);
    expect(posted, "паузы не было — говорить не о чем").toEqual([]);
    fire(pausedFrame);
    expect(posted).toHaveLength(1);
    fire(runningFrame);
    expect(posted[1], "переход «пауза кончилась» обязан дойти").toMatchObject({ finished: true });
    fire(runningFrame);
    expect(posted, "а повторы — уже нет").toHaveLength(2);
    postSpy.mockRestore();
  });

  test("конверт не попадает в диагностику «незнакомого события»", async () => {
    // Именно это и сгубило разбор 09.08.2026: у ВСЕХ кадров конверта одно
    // имя — «events», строка про него пишется раз на имя, и первый же кадр
    // при входе в комнату съедал диагностику на весь матч.
    await installProbe();
    const posted: Array<Record<string, unknown>> = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => {
      posted.push(m);
    }) as unknown as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    // Кадр конверта, который мы намеренно не разбираем, — и слово «pause» в
    // нём есть (список доступных действий стола).
    const foreign = envelope(runningState, "chatMessage");
    expect(foreign, "иначе тест ничего не проверяет").toContain("pause");
    (ws.onmessage as (e: MessageEvent) => void).call(ws, new MessageEvent("message", { data: foreign }));
    expect(posted).toEqual([]);
    postSpy.mockRestore();
  });

  test("полный лог кадров молчит, пока расширение его не попросит", async () => {
    // Настройка выключена по умолчанию: в кадрах комнаты роли и ночные ходы.
    // Зонд не имеет права начать их пересылать «на всякий случай».
    await installProbe();
    const posted: Array<Record<string, unknown>> = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => {
      posted.push(m);
    }) as unknown as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    (ws.onmessage as (e: MessageEvent) => void).call(
      ws,
      new MessageEvent("message", { data: pauseFrame }),
    );
    expect(posted.some(m => "frame" in m), "кадры наружу без команды не уходят").toBe(false);
    postSpy.mockRestore();
  });

  test("по команде расширения кадры идут в обе стороны", async () => {
    // Исходящие важны не меньше входящих: по ним видно, что именно сайт и
    // расширение просят у сервера.
    const nativeSend = WebSocket.prototype.send;
    const sendStub = vi.fn();
    // Подменяем ДО установки зонда: в jsdom настоящий send на неоткрытом
    // сокете бросает, и обёртка до копии кадра просто не доходит.
    WebSocket.prototype.send = sendStub as unknown as WebSocket["send"];
    try {
      await installProbe();
      startFrameLog();
      const posted: Array<Record<string, unknown>> = [];
      const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => {
        posted.push(m);
      }) as unknown as typeof window.postMessage);
      const ws = makeSocket();
      ws.onmessage = () => {};
      (ws.onmessage as (e: MessageEvent) => void).call(
        ws,
        new MessageEvent("message", { data: pauseFrame }),
      );
      ws.send('42["run_action",{"action":"pause"}]');

      expect(sendStub, "кадр обязан дойти до сокета").toHaveBeenCalledTimes(1);
      const frames = posted.filter(m => "frame" in m).map(m => m.frame as Record<string, unknown>);
      expect(frames.map(f => f.dir)).toEqual(["in", "out"]);
      expect(frames[1].raw).toContain("run_action");
      postSpy.mockRestore();
    } finally {
      WebSocket.prototype.send = nativeSend;
    }
  });

  test("повторный инжект не ставит второй слой обёрток", async () => {
    await installProbe();
    const afterFirst = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    // Второй импорт при уже поднятом флаге — обязан выйти молча.
    vi.resetModules();
    await import("@content/page/room-probe-page");
    expect(Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage")).toEqual(afterFirst);
  });
});
