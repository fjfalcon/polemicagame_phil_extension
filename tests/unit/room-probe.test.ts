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

import { PROBE_FLAG_KEY, injectProbe, probeAllowed } from "@content/page/room-probe-inject";

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

  test("ключ зеркала совпадает с тем, что пишет content-скрипт", async () => {
    // Разъедься они — выключатель молча перестанет действовать.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/index.ts", "utf8");
    expect(src).toContain("PROBE_FLAG_KEY");
    expect(PROBE_FLAG_KEY).toBe("pn_room_probe");
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

  test("повторный инжект не ставит второй слой обёрток", async () => {
    await installProbe();
    const afterFirst = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    // Второй импорт при уже поднятом флаге — обязан выйти молча.
    vi.resetModules();
    await import("@content/page/room-probe-page");
    expect(Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage")).toEqual(afterFirst);
  });
});
