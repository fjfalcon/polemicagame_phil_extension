// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Зонд комнаты: перехват сокета и гейт раннего инжекта.
 *
 * Зонд отдаёт кадры игрового сокета полному логу общения с сервером — и
 * больше ничего (фича «кто поставил паузу» убрана 09.08.2026: сервер
 * инициатора не присылает, доказано этим же логом).
 *
 * Здесь исполняется САМ модуль зонда — его IIFE патчит прототип WebSocket.
 * Ревью 08.08.2026 показало, что эта часть была не покрыта вовсе: выживали
 * мутанты «убрать хук», «targetOrigin: *», «снять антиспуф».
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { WS_LOG_FLAG_KEY, injectProbe, probeAllowed } from "@content/page/room-probe-inject";

/** Оригинальные ссылки — вернём после каждого теста. */
const originalOnMessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
const originalAdd = WebSocket.prototype.addEventListener;
const originalSend = WebSocket.prototype.send;

async function installProbe(): Promise<void> {
  vi.resetModules();
  (window as { __pnRoomProbeInstalled?: boolean }).__pnRoomProbeInstalled = false;
  await import("@content/page/room-probe-page");
}

/** Кадр socket.io: движок шлёт их с цифровым префиксом (тип пакета). */
const frame = `42${JSON.stringify(["on_start_stage", { type: "day" }])}`;

/**
 * Команда «писать кадры», какую шлёт content-скрипт. Событие доставляем
 * синхронно: postMessage в jsdom асинхронный, а слушатель зонда нужен сразу.
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

/** Доставить кадр так, как это делает браузер. */
function deliver(ws: WebSocket, data: string): void {
  (ws.onmessage as (e: MessageEvent) => void).call(ws, new MessageEvent("message", { data }));
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
  WebSocket.prototype.send = originalSend;
  (window as { __pnRoomProbeInstalled?: boolean }).__pnRoomProbeInstalled = false;
});

describe("гейт раннего инжекта", () => {
  test("по умолчанию зонда НЕТ: ключа нет — настройка выключена", () => {
    // Главный предохранитель приватности: подмена WebSocket у всех подряд —
    // решение, которое проект уже отвергал (аудит устойчивости 01.08.2026,
    // находка 16). Сокет сайта не трогаем, пока человек не попросит.
    expect(probeAllowed({ getItem: () => null })).toBe(false);
    expect(probeAllowed({ getItem: () => "0" })).toBe(false);
    expect(probeAllowed({ getItem: () => "1" })).toBe(true);
  });

  test("недоступное хранилище не роняет инжектор и не поднимает зонд", () => {
    // Приватный режим запрещает localStorage целиком: падать нельзя, но и
    // считать это разрешением — тоже.
    const throwing = {
      getItem() {
        throw new Error("SecurityError");
      },
    };
    expect(() => probeAllowed(throwing)).not.toThrow();
    expect(probeAllowed(throwing)).toBe(false);
    expect(probeAllowed(null)).toBe(false);
  });

  test("выключённая настройка — тега зонда на странице НЕ появляется", () => {
    document.head.innerHTML = "";
    injectProbe();
    expect(document.querySelector("script[data-pn-room-probe]")).toBeNull();
  });

  test("включённая настройка — тег ставится, повторный вызов не дублирует", () => {
    document.head.innerHTML = "";
    localStorage.setItem(WS_LOG_FLAG_KEY, "1");
    injectProbe();
    injectProbe();
    expect(document.querySelectorAll("script[data-pn-room-probe]")).toHaveLength(1);
    // Порядок исполнения важен: динамический скрипт по умолчанию async, а
    // зонд обязан встать ДО бандла сайта.
    expect(document.querySelector<HTMLScriptElement>("script[data-pn-room-probe]")?.async).toBe(
      false,
    );
  });

  test("ключ зеркала совпадает с тем, что пишет content-скрипт", async () => {
    // Разъедься они — выключатель молча перестанет действовать.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/index.ts", "utf8");
    expect(src).toContain("WS_LOG_FLAG_KEY");
    expect(WS_LOG_FLAG_KEY).toBe("pn_ws_log");
  });
});

describe("перехват сокета", () => {
  test("без команды расширения кадры наружу НЕ уходят", async () => {
    // Через комнатный сокет идут роли и ночные ходы: зонд не имеет права
    // пересылать их «на всякий случай», даже будучи установленным.
    await installProbe();
    const posted: unknown[] = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: unknown) => {
      posted.push(m);
    }) as typeof window.postMessage);
    const ws = makeSocket();
    const gameHandler = vi.fn();
    ws.onmessage = gameHandler;
    deliver(ws, frame);

    expect(gameHandler, "кадр обязан дойти до игры").toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
    postSpy.mockRestore();
  });

  test("по команде кадры идут в обе стороны", async () => {
    // Исходящие важны не меньше входящих: по ним видно, что именно сайт и
    // расширение просят у сервера.
    const sendStub = vi.fn();
    // Подменяем ДО установки зонда: в jsdom настоящий send на неоткрытом
    // сокете бросает, и обёртка до копии кадра просто не доходит.
    WebSocket.prototype.send = sendStub as unknown as WebSocket["send"];
    await installProbe();
    startFrameLog();
    const posted: Array<Record<string, unknown>> = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => {
      posted.push(m);
    }) as unknown as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    deliver(ws, frame);
    ws.send('42["run_action",{"action":"pause"}]');

    expect(sendStub, "кадр обязан дойти до сокета").toHaveBeenCalledTimes(1);
    const frames = posted.map(m => m.frame as Record<string, unknown>);
    expect(frames.map(f => f.dir)).toEqual(["in", "out"]);
    expect(frames[1].raw).toContain("run_action");
    postSpy.mockRestore();
  });

  test("чужая команда лог не включает", async () => {
    // Страница шлёт себе сообщения постоянно. Без проверки источника любое
    // из них с полем on:true открывало бы кран с кадрами комнаты.
    await installProbe();
    const posted: unknown[] = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((m: unknown) => {
      posted.push(m);
    }) as typeof window.postMessage);
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "аналитика сайта", on: true }, source: window }),
    );
    const ws = makeSocket();
    ws.onmessage = () => {};
    deliver(ws, frame);
    expect(posted).toEqual([]);
    postSpy.mockRestore();
  });

  test("сообщение адресуется своему origin, а не всем подряд", async () => {
    await installProbe();
    startFrameLog();
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation((() => {}) as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => {};
    deliver(ws, frame);
    expect(postSpy).toHaveBeenCalledWith(expect.anything(), location.origin);
    postSpy.mockRestore();
  });

  test("игра получает кадр ПЕРВОЙ, копия идёт следом", async () => {
    // Порядок — часть предохранителя «не ломать сайт»: пока мы не отдали
    // кадр игре, любая наша задержка или ошибка задевала бы саму игру.
    await installProbe();
    startFrameLog();
    const order: string[] = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation(((() => {
      order.push("probe");
    }) as unknown) as typeof window.postMessage);
    const ws = makeSocket();
    ws.onmessage = () => order.push("game");
    deliver(ws, frame);
    expect(order).toEqual(["game", "probe"]);
    postSpy.mockRestore();
  });

  test("наша ошибка не мешает игре получить кадр", async () => {
    await installProbe();
    startFrameLog();
    // postMessage бросает (как DataCloneError в жизни) — игра не должна
    // потерять сообщение из-за нас.
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation((() => {
      throw new Error("DataCloneError");
    }) as typeof window.postMessage);
    const ws = makeSocket();
    const gameHandler = vi.fn();
    ws.onmessage = gameHandler;
    expect(() => deliver(ws, frame)).not.toThrow();
    expect(gameHandler).toHaveBeenCalledTimes(1);
    postSpy.mockRestore();
  });

  test("зонд оставляет метку на <html>: по логу видно, что он встал", async () => {
    // Без метки «лог пуст, потому что зонд не встал» неотличимо от «настройку
    // включили уже после игры» — тупик разбора 09.08.2026.
    document.documentElement.removeAttribute("data-pn-room-probe-ready");
    await installProbe();
    expect(document.documentElement.getAttribute("data-pn-room-probe-ready")).toBe("1");
  });

  test("addEventListener НЕ трогаем: иначе сайт не снимет свой слушатель", async () => {
    // В комнате так подписан сигнальный сокет медиа (Janus) и он свои
    // слушатели снимает при разрушении сессии. Обёртка ломала бы teardown
    // (ревью 08.08.2026, блокер).
    const before = WebSocket.prototype.addEventListener;
    await installProbe();
    expect(WebSocket.prototype.addEventListener).toBe(before);

    const target = new EventTarget();
    const handler = vi.fn();
    target.addEventListener("message", handler);
    target.removeEventListener("message", handler);
    target.dispatchEvent(new MessageEvent("message", { data: frame }));
    expect(handler, "снятый слушатель не должен вызываться").not.toHaveBeenCalled();
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
