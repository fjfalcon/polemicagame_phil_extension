// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game/123" }
/**
 * Бюджет «Twitch connect» (перф-аудит 06.08.2026, PERF-7):
 *  • не больше ОДНОГО сокета в состоянии CONNECTING/OPEN — enable раньше
 *    создавал два initial-сокета (гейт смотрел на isConnected, который
 *    становится true только в асинхронном onopen);
 *  • уход с игрового маршрута (isGameRoomPath) останавливает сокет и
 *    watchdog-таймеры;
 *  • disable() симметричен — ни таймеров, ни сокетов после него;
 *  • подписчик видимости: attr-only батчи не доходят до QSA-сверки,
 *    полная сверка дебаунсится до ≤2/с.
 *
 * WebSocket фейковый (по образцу queue-peek-transcript.test.ts), но с
 * on*-свойствами: twitch-panel вешает обработчики присваиванием, а не
 * addEventListener.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  domSub: null as null | ((mutations: MutationRecord[]) => void),
  msgHandler: null as null | ((msg: unknown) => void),
}));

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((fn: (mutations: MutationRecord[]) => void) => {
    h.domSub = fn;
    return () => {
      h.domSub = null;
    };
  }),
}));
vi.mock("@core/env", () => ({
  browser: {
    storage: { sync: { set: vi.fn(async () => {}) } },
    runtime: { id: "x" },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn((fn: (msg: unknown) => void) => {
    h.msgHandler = fn;
    return () => {
      h.msgHandler = null;
    };
  }),
  sendRuntime: vi.fn(async () => ({ success: true })),
}));
// Селекторы короткие, чтобы фикстуры игрового UI были очевидны.
vi.mock("@core/selectors", () => ({
  SITE: { playerDesktop: ".pd", playerVideo: ".pv", obsGameControls: ".gc" },
}));
// Панель — вне предмета теста: минимальный каркас с show/hide/unmount.
vi.mock("@core/FloatingPanel", () => ({
  FloatingPanel: class {
    root = document.createElement("div");
    header = document.createElement("div");
    isMounted = false;
    constructor(_opts: unknown) {}
    show(): void {
      this.isMounted = true;
      this.root.style.display = "";
    }
    hide(): void {
      this.root.style.display = "none";
    }
    unmount(): void {
      this.isMounted = false;
    }
    protected addHeaderButton(): HTMLButtonElement {
      return document.createElement("button");
    }
    protected enableDrag(): void {}
  },
}));

import type { FeatureContext } from "@core/feature";
import { twitchPanelFeature } from "@content/panels/twitch-panel";

type Handler = ((e: unknown) => void) | null;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  /** Как у настоящего: close() НЕ рассылает событие close синхронно. */
  close(): void {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  emitClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const realWebSocket = globalThis.WebSocket;

function liveSockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter(
    (ws) =>
      ws.readyState === FakeWebSocket.CONNECTING || ws.readyState === FakeWebSocket.OPEN,
  );
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error("панель не открыла сокет");
  return ws;
}

/** 10 плиток игроков + игровые контролы: hasActiveGameInterface() === true. */
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

function enableFeature(over: Record<string, unknown> = {}): void {
  twitchPanelFeature.enable({
    settings: { twitch_chat_enabled: true, twitch_channel_name: "streamer", ...over },
  } as unknown as FeatureContext);
}

const attrRecord = (): MutationRecord =>
  ({ type: "attributes", addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;
const childRecord = (): MutationRecord =>
  ({ type: "childList", addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;

/** Счётчик document-wide QSA (сверка видимости делает до 3 на проход). */
function spyDocQsa(): { n: number } {
  const counter = { n: 0 };
  const orig = Document.prototype.querySelectorAll;
  vi.spyOn(document, "querySelectorAll").mockImplementation(function (
    this: Document,
    selector: string,
  ) {
    counter.n++;
    return orig.call(this, selector);
  } as typeof document.querySelectorAll);
  return counter;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  window.history.replaceState(null, "", "/game/123");
  mountGameUi();
});

afterEach(() => {
  twitchPanelFeature.disable();
  document.body.innerHTML = "";
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  vi.useRealTimers();
});

describe("TW-P7: жизненный цикл сокета Twitch", () => {
  test("enable создаёт ровно один сокет — двойного initial connect нет", () => {
    enableFeature();

    // Гейт одного сокета: второй безусловный connect из enable() раньше
    // убивал CONNECTING-сокет showPanel'а и открывал новый (2 аллокации).
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(liveSockets()).toHaveLength(1);

    // И после открытия + очередной сверки видимости сокет остаётся тем же.
    lastSocket().emitOpen();
    h.domSub?.([childRecord()]);
    vi.advanceTimersByTime(600);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(liveSockets()).toHaveLength(1);
  });

  test("панель мигнула при CONNECTING-сокете — второй сокет не создаётся (W5)", () => {
    // Ревью 07.08: мутант hasLiveSocket→isConnected в showPanel-путе проходил
    // сюиту. Гейт исполняется на переходе «скрыта→показана»: игровой UI
    // мигнул (перерисовка), панель спряталась и вернулась, а сокет всё ещё
    // CONNECTING — isConnected здесь открывал бы второй connect.
    enableFeature(); // сокет CONNECTING, панель показана
    expect(FakeWebSocket.instances).toHaveLength(1);

    document.body.innerHTML = ""; // UI исчез — панель прячется, сокет живёт
    h.domSub?.([childRecord()]);
    vi.advanceTimersByTime(600);
    expect(liveSockets(), "скрытие панели не трогает сокет").toHaveLength(1);

    mountGameUi(); // UI вернулся — showPanel при всё ещё CONNECTING-сокете
    h.domSub?.([childRecord()]);
    vi.advanceTimersByTime(600);
    expect(FakeWebSocket.instances, "второй аллокации быть не должно").toHaveLength(1);
    expect(liveSockets()).toHaveLength(1);
  });

  test("повторный connect из попапа заменяет сокет, не плодя живых", () => {
    enableFeature();
    const first = lastSocket();

    h.msgHandler?.({ type: "twitch_connect", channel: "streamer" });
    expect(first.closeCalls).toBeGreaterThan(0);
    expect(liveSockets()).toHaveLength(1);

    const second = lastSocket();
    second.emitOpen();
    h.msgHandler?.({ type: "twitch_connect", channel: "streamer" });
    expect(second.closeCalls).toBeGreaterThan(0);
    expect(liveSockets()).toHaveLength(1);
  });

  test("режим «только в игре»: уход с игрового маршрута закрывает сокет и все таймеры", () => {
    // Прежний контракт PERF-7 живёт в режиме «только в игре». В режиме
    // «везде» (дефолт с 9.28.0) чат вне игры нужен стримеру — см. тест ниже.
    enableFeature({ twitch_chat_everywhere: false });
    const ws = lastSocket();
    ws.emitOpen(); // запускает idle- и join-watchdog'и
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    window.history.replaceState(null, "", "/game-search");
    h.domSub?.([childRecord()]);
    vi.advanceTimersByTime(600); // дебаунс сверки видимости

    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(liveSockets()).toHaveLength(0);
    // Симметрия: ни watchdog'ов, ни реконнектов, ни отложенной сверки.
    expect(vi.getTimerCount()).toBe(0);

    // И спустя долгое время никто не переподключается втихую.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("режим «везде» (дефолт): уход в поиск НЕ рвёт сокет — чат нужен и там", () => {
    // Просьба владельца 16.08.2026: стример вне игры (поиск, лобби) чата не
    // видел. Переход по сайту — SPA, соединение одно на вкладку.
    enableFeature();
    const ws = lastSocket();
    ws.emitOpen();
    const before = ws.closeCalls;

    window.history.replaceState(null, "", "/game-search");
    h.domSub?.([childRecord()]);
    vi.advanceTimersByTime(600);

    expect(ws.closeCalls, "сокет жив на поиске").toBe(before);
    expect(liveSockets()).toHaveLength(1);
    expect(FakeWebSocket.instances, "и новых подключений не плодим").toHaveLength(1);
  });

  test("disable() не оставляет ни сокетов, ни таймеров, ни реконнекта", () => {
    enableFeature();
    const ws = lastSocket();
    ws.emitOpen();

    twitchPanelFeature.disable();
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(liveSockets()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    // Обработчики отвязаны: посмертный close старого сокета не планирует
    // переподключение.
    ws.emitClose();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("TW-P7: бюджет подписчика видимости", () => {
  test("100 attribute-only батчей — 0 QSA и ни одного таймера сверки", () => {
    enableFeature();
    const qsa = spyDocQsa();

    for (let i = 0; i < 100; i++) h.domSub?.([attrRecord()]);
    vi.advanceTimersByTime(2000);
    expect(qsa.n).toBe(0);

    // Санити: childList-батч сверку по-прежнему запускает.
    h.domSub?.([childRecord()]);
    vi.advanceTimersByTime(600);
    expect(qsa.n).toBeGreaterThanOrEqual(3);
  });

  test("шквал childList-батчей дебаунсится до ≤2 полных сверок в секунду", () => {
    enableFeature();
    const qsa = spyDocQsa();

    // 100 батчей за секунду + хвост дебаунса: допустимо ≤4 сверок × 3 QSA.
    for (let i = 0; i < 100; i++) {
      h.domSub?.([childRecord()]);
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(600);

    expect(qsa.n).toBeGreaterThanOrEqual(3);
    expect(qsa.n).toBeLessThanOrEqual(12);
  });
});
