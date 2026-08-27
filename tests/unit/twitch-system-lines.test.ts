// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game/123" }
/**
 * Системные строки чата: одно событие — ОДНА строка.
 *
 * Жалоба владельца 27.08.2026 (скриншот): «Подключаемся к чату…» и
 * «Подключились к чату» занимали в узкой панели две строки подряд, хотя это
 * начало и конец одного и того же шага. Исход попытки переписывает её строку
 * на месте; события РАЗНЫЕ (отключились, ошибка на живом чате) остаются
 * отдельными — иначе лента врёт про порядок произошедшего.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn(() => () => undefined) }));
vi.mock("@core/env", () => ({
  browser: { storage: { sync: { set: vi.fn(async () => {}) } }, runtime: { id: "x" } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn(() => () => undefined),
  sendRuntime: vi.fn(async () => ({ success: true })),
}));
vi.mock("@core/selectors", () => ({
  SITE: { playerDesktop: ".pd", playerVideo: ".pv", obsGameControls: ".gc" },
}));
// Каркас панели: настоящий renderBody (его DOM — предмет теста), но без
// перетаскивания, ресайза и localStorage базовой FloatingPanel.
vi.mock("@core/FloatingPanel", () => ({
  FloatingPanel: class {
    root = document.createElement("div");
    header = document.createElement("div");
    body = document.createElement("div");
    isMounted = false;
    private built = false;
    constructor(_opts: unknown) {}
    show(): void {
      if (!this.built) {
        this.built = true;
        this.root.append(this.header, this.body);
        document.body.appendChild(this.root);
        (this as unknown as { renderBody(b: HTMLElement): void }).renderBody(this.body);
      }
      this.isMounted = true;
      this.root.style.display = "";
    }
    hide(): void {
      this.root.style.display = "none";
    }
    unmount(): void {
      this.isMounted = false;
      this.root.remove();
      this.built = false;
    }
    protected addHeaderButton(): HTMLButtonElement {
      const b = document.createElement("button");
      this.header.appendChild(b);
      return b;
    }
    protected enableDrag(): void {}
  },
}));

import type { FeatureContext } from "@core/feature";
import { twitchPanelFeature } from "@content/panels/twitch-panel";

type Handler = ((e: unknown) => void) | null;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;
  readyState = 0;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  /** Вход в канал подтверждён (366 — конец списка имён). */
  emitJoined(): void {
    this.onmessage?.({ data: ":tmi.twitch.tv 366 justinfan1 #streamer :End of /NAMES list\r\n" });
  }
}

const realWebSocket = globalThis.WebSocket;

function mountGameUi(): void {
  for (let i = 0; i < 10; i++) {
    const tile = document.createElement("div");
    tile.className = "pd";
    document.body.appendChild(tile);
  }
  const controls = document.createElement("div");
  controls.className = "gc";
  document.body.appendChild(controls);
}

const sysLines = (): string[] =>
  [...document.querySelectorAll(".twitch-system-message")].map((el) =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  );

function enableFeature(): FakeWebSocket {
  twitchPanelFeature.enable({
    settings: { twitch_chat_enabled: true, twitch_channel_name: "streamer" },
  } as unknown as FeatureContext);
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

beforeEach(() => {
  sessionStorage.clear();
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  window.history.replaceState(null, "", "/game/123");
  document.body.innerHTML = "";
  mountGameUi();
});

afterEach(() => {
  twitchPanelFeature.disable();
  document.body.innerHTML = "";
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  vi.useRealTimers();
});

describe("системные строки чата: одно событие — одна строка", () => {
  test("«подключаемся» превращается в «подключились», а не висит второй строкой", () => {
    const ws = enableFeature();
    ws.emitOpen();
    expect(sysLines().filter((t) => t.includes("Подключаемся"))).toHaveLength(1);
    ws.emitJoined();
    const lines = sysLines();
    expect(lines.some((t) => t.includes("Подключились")), "итог показан").toBe(true);
    expect(lines.some((t) => t.includes("Подключаемся")), "промежуточной строки нет").toBe(false);
    expect(lines, "и строка ровно одна").toHaveLength(1);
  });

  test("канал не ответил — та же строка становится причиной, а не третьей", () => {
    const ws = enableFeature();
    ws.emitOpen();
    // Сторож подтверждения входа (канала нет / имя с опечаткой).
    vi.advanceTimersByTime(20_000);
    const lines = sysLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Канал не отвечает");
  });

  test("разные события НЕ склеиваются: обрыв живого чата — своя строка", () => {
    const ws = enableFeature();
    ws.emitOpen();
    ws.emitJoined();
    ws.onclose?.({ code: 1006 });
    const lines = sysLines();
    expect(lines).toHaveLength(2);
    expect(lines[0], "факт «чат работал» не затёрт").toContain("Подключились");
    expect(lines[1]).toContain("Отключились");
  });

  test("новая попытка после обрыва пишет свою строку и сама себя обновляет", () => {
    const ws = enableFeature();
    ws.emitOpen();
    ws.emitJoined();
    ws.onclose?.({ code: 1006 });
    // Переподключение по расписанию: новый сокет, новая строка «подключаемся».
    vi.advanceTimersByTime(60_000);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws2, "переподключение состоялось").not.toBe(ws);
    ws2.emitOpen();
    expect(sysLines()).toHaveLength(3);
    ws2.emitJoined();
    const lines = sysLines();
    expect(lines, "итог переписал СВОЮ строку").toHaveLength(3);
    expect(lines[2]).toContain("Подключились");
  });
});
