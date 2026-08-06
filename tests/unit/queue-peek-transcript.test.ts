// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game-search" }
/**
 * Fake-транскрипт-тест протокола разведки очереди (peekOnce).
 *
 * Это ЕДИНСТВЕННОЕ место, где расширение говорит с сервером от имени
 * аккаунта игрока (start/stop_game_search). Живой мутирующий тест на
 * аккаунте запрещён, поэтому весь диалог проигрывается через FakeWebSocket:
 * Engine.IO 3 (handshake "0{...}", ping "2"/pong "3") + Socket.IO parser 4,
 * неймспейс /search. Формы кадров сверены с бандлом сайта (см. шапку
 * src/content/features/queue-peek.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn(() => () => {}),
  safeClick: vi.fn(() => true),
  isVisible: vi.fn(() => true),
}));
vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: { id: "x", getManifest: () => ({ version: "9.3.2" }) },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn(() => () => {}),
  sendRuntime: vi.fn(async () => ({ success: true })),
  broadcastToGameTabs: vi.fn(),
  sendToActiveTabStrict: vi.fn(),
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { peekOnce } from "@content/features/queue-peek";

const NS = "/search";
const HARD_TIMEOUT_MS = 8000;
const STOP_CONFIRM_MS = 1500;

/** Креды с URL-безопасным authKey: CONNECT-кадр сверяется точной строкой. */
const CREDS = { id: 777001, authKey: "test-auth-key", pro: true, prime: false };

type Listener = (e: unknown) => void;

/**
 * Фейковый WebSocket: записывает url и все send(), события эмулируются
 * вручную. Констант­ы состояний обязаны совпадать с настоящими — peekOnce
 * сравнивает `ws.readyState !== WebSocket.OPEN`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners.get(type) || [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, cb: Listener): void {
    const list = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      list.filter((l) => l !== cb),
    );
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  /** Как у настоящего: close() НЕ рассылает событие close синхронно. */
  close(): void {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSED;
  }

  private dispatch(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) || []) cb(event);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  emitMessage(data: string): void {
    this.dispatch("message", { data });
  }

  emitClose(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }

  emitError(): void {
    this.dispatch("error", {});
  }
}

const realWebSocket = globalThis.WebSocket;

function socket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error("peekOnce не открыл сокет");
  return ws;
}

/** Engine.IO-рукопожатие: открытие транспорта + пакет "0{...}" от сервера. */
function handshake(ws: FakeWebSocket): void {
  ws.emitOpen();
  ws.emitMessage('0{"sid":"abc123","pingInterval":25000,"pingTimeout":5000,"upgrades":[]}');
}

/** Событие сервера в неймспейсе /search. */
function serverEvent(ws: FakeWebSocket, name: string, body?: unknown): void {
  const payload = body === undefined ? [name] : [name, body];
  ws.emitMessage(`42${NS},${JSON.stringify(payload)}`);
}

/** Довести диалог до отправленной заявки start_game_search. */
function driveToSearchStarted(ws: FakeWebSocket): void {
  handshake(ws);
  serverEvent(ws, "session_initialized", {});
}

const QUEUES = {
  standard: { players: [{ id: 1, username: "alpha", mmr: 1500 }] },
  polite: { players: 3 },
  prime: { players: [] },
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  // Не с нуля: код сравнивает отметки времени с реальными эпохами.
  vi.setSystemTime(new Date(1_800_000_000_000));
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  vi.useRealTimers();
});

describe("QP-T: транскрипт протокола разведки", () => {
  test("happy path: точные кадры от подключения до подтверждённого выхода", async () => {
    const promise = peekOnce(CREDS, "standard");
    const ws = socket();

    // URL подключения: engine.io v3 и креды в query (без них сервер рвёт
    // соединение сразу после установки — см. socketUrl).
    expect(ws.url.startsWith("wss://game.polemicagame.com/socket.io/?")).toBe(true);
    expect(ws.url).toContain("EIO=3&transport=websocket");
    expect(ws.url).toContain("userId=777001");
    expect(ws.url).toContain("authKey=test-auth-key");
    expect(ws.url).toContain("intention=game_search");

    handshake(ws);
    // CONNECT-кадр неймспейса — точная строка, креды приклеены второй раз.
    expect(ws.sent[0]).toBe(
      "40/search?userId=777001&authKey=test-auth-key&intention=game_search",
    );

    serverEvent(ws, "session_initialized", {});
    // Заявка на поиск: сравниваем распарсенным (порядок полей не важен).
    const startFrame = ws.sent[1];
    expect(startFrame.startsWith(`42${NS},`)).toBe(true);
    expect(JSON.parse(startFrame.slice(`42${NS},`.length))).toEqual([
      "start_game_search",
      {
        gameMode: "league",
        role: "player",
        userId: 777001,
        authKey: "test-auth-key",
        censorship: ["standard"],
      },
    ]);

    serverEvent(ws, "on_start_game_search", { success: true });
    serverEvent(ws, "on_game_search_state", { queues: QUEUES });
    // Выход: сверено с бандлом сайта — БЕЗ аргументов.
    expect(ws.sent[2]).toBe('42/search,["stop_game_search"]');
    expect(ws.sent).toHaveLength(3);

    serverEvent(ws, "on_stop_game_search", {});
    await expect(promise).resolves.toEqual(QUEUES);
    // После подтверждения выхода сокет закрыт.
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("engine.io ping \"2\" получает pong \"3\"", async () => {
    const promise = peekOnce(CREDS, "standard");
    const ws = socket();
    driveToSearchStarted(ws);

    ws.emitMessage("2");
    expect(ws.sent).toContain("3");

    // Штатно завершаем, чтобы не оставить висящий промис.
    serverEvent(ws, "on_start_game_search", { success: true });
    serverEvent(ws, "on_game_search_state", { queues: QUEUES });
    serverEvent(ws, "on_stop_game_search", {});
    await expect(promise).resolves.toEqual(QUEUES);
  });

  test("отказ illegalState=game_search: шлём stop_game_search и НЕ повторяем", async () => {
    const promise = peekOnce(CREDS, "standard");
    const caught = promise.catch((e: Error) => e);
    const ws = socket();
    driveToSearchStarted(ws);

    serverEvent(ws, "on_start_game_search", {
      success: false,
      illegalState: "game_search",
    });
    // Аккаунт завис в поиске с прошлого захода — просим выйти.
    expect(ws.sent).toContain('42/search,["stop_game_search"]');

    const err = (await caught) as Error & { retryable?: boolean };
    expect(err.name).toBe("PeekError");
    expect(err.message).toContain("уже числится в поиске");
    // Запрет уровня аккаунта: повтор в другой очереди снял бы игрока с его
    // собственного поиска.
    expect(err.retryable).toBe(false);
  });

  test("отказ ban_is_still_active — не повторяем; прочий отказ без illegalState — повторяем", async () => {
    // Бан: запрет уровня аккаунта.
    {
      const promise = peekOnce(CREDS, "standard");
      const caught = promise.catch((e: Error) => e);
      const ws = socket();
      driveToSearchStarted(ws);
      serverEvent(ws, "on_start_game_search", {
        success: false,
        message: "ban_is_still_active",
      });
      const err = (await caught) as Error & { retryable?: boolean };
      expect(err.name).toBe("PeekError");
      expect(err.message).toContain("ограничение на поиск");
      expect(err.retryable).toBe(false);
      // Это НЕ illegalState=game_search: лишний stop_game_search запрещён.
      expect(err && socket().sent).not.toContain('42/search,["stop_game_search"]');
    }
    // bad_request на недоступный режим: виновата очередь, можно другую.
    {
      const promise = peekOnce(CREDS, "polite");
      const caught = promise.catch((e: Error) => e);
      const ws = socket();
      driveToSearchStarted(ws);
      serverEvent(ws, "on_start_game_search", { success: false, message: "bad_request" });
      const err = (await caught) as Error & { retryable?: boolean };
      expect(err.name).toBe("PeekError");
      expect(err.retryable).toBe(true);
    }
  });

  test("подтверждение выхода не пришло — через STOP_CONFIRM_MS рвём сокет", async () => {
    const promise = peekOnce(CREDS, "standard");
    const ws = socket();
    driveToSearchStarted(ws);
    serverEvent(ws, "on_start_game_search", { success: true });
    serverEvent(ws, "on_game_search_state", { queues: QUEUES });
    expect(ws.sent).toContain('42/search,["stop_game_search"]');

    // Сервер молчит: до порога сокет жив, на пороге — разрыв (обрыв сессии
    // сервер тоже трактует как выход, см. queue-timeout-report.md).
    vi.advanceTimersByTime(STOP_CONFIRM_MS - 1);
    expect(ws.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ws.closeCalls).toBeGreaterThan(0);
    // Состояние очередей уже получено — результат отдаём.
    await expect(promise).resolves.toEqual(QUEUES);
  });

  test("тишина после handshake — HARD_TIMEOUT_MS и диагностируемый отказ", async () => {
    const promise = peekOnce(CREDS, "standard");
    const caught = promise.catch((e: Error) => e);
    const ws = socket();
    driveToSearchStarted(ws);
    // Сервер принял сессию и замолчал: ни ответа на заявку, ни состояния.

    vi.advanceTimersByTime(HARD_TIMEOUT_MS - 1);
    expect(ws.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    // Заявка ушла — выход обязателен даже по таймауту.
    expect(ws.sent).toContain('42/search,["stop_game_search"]');
    // Подтверждения тоже нет — добиваем по стоп-таймеру.
    vi.advanceTimersByTime(STOP_CONFIRM_MS);

    const err = (await caught) as Error & { retryable?: boolean };
    expect(err.name).toBe("PeekError");
    expect(err.message).toContain("сервер не ответил вовремя");
    // Перечень полученных событий — единственная диагностика таймаута.
    expect(err.message).toContain("session_initialized");
    expect(ws.closeCalls).toBeGreaterThan(0);
  });

  test("on_game_found во время разведки: выходим и честно говорим про игру", async () => {
    const promise = peekOnce(CREDS, "standard");
    const caught = promise.catch((e: Error) => e);
    const ws = socket();
    driveToSearchStarted(ws);
    serverEvent(ws, "on_start_game_search", { success: true });

    serverEvent(ws, "on_game_found", { gameId: 42 });
    // Не мешаем: выходим из очереди штатно.
    expect(ws.sent).toContain('42/search,["stop_game_search"]');

    serverEvent(ws, "on_stop_game_search", {});
    const err = (await caught) as Error;
    expect(err.name).toBe("PeekError");
    expect(err.message).toContain("собралась игра");
  });
});
