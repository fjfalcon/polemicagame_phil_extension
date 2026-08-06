import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, unknown>) => {
          const out: Record<string, unknown> = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            out[key] = key in store.data ? store.data[key] : fallback;
          }
          return out;
        }),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store.data, patch);
        }),
      },
    },
    runtime: { sendMessage: vi.fn(async () => undefined) },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(async () => undefined),
  broadcastToGameTabs: vi.fn(async () => undefined),
}));

import { browser } from "@core/env";
import { log } from "@core/log";
import {
  OBS_RECONNECT_ATTEMPTS_KEY,
  OBS_RETRY_BLOCKED_KEY,
  OBS_RETRY_BLOCK_REASON_KEY,
  ObsClient,
} from "../../src/background/obs-client";

/** Минимальный двойник сокета OBS: им управляет сам тест. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static created = 0;
  /** Отвечать ли на op:6 самим (для тестов heartbeat-каденса на фейковых таймерах). */
  static autoRespondAll = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: string[] = [];
  autoRespond = FakeSocket.autoRespondAll;

  constructor(public readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.created++;
  }
  send(data: string): void {
    this.sent.push(data);
    if (!this.autoRespond) return;
    const msg = JSON.parse(data) as { op: number; d?: { requestType?: string; requestId?: number } };
    if (msg.op !== 6) return;
    this.onmessage?.({
      data: JSON.stringify({
        op: 7,
        d: {
          requestId: msg.d?.requestId,
          requestStatus: { result: true },
          responseData:
            msg.d?.requestType === "GetSceneList"
              ? { scenes: [], currentProgramSceneName: "Сцена" }
              : {},
        },
      }),
    });
  }
  close(code = 1000, reason = ""): void {
    this.onclose?.({ code, reason });
  }
  /** Hello (op:0) → клиент отвечает Identify. */
  hello(): void {
    this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
  }
  /** Identified (op:2) — соединение готово. */
  identified(): void {
    this.onmessage?.({ data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) });
  }
}

/** Довести клиент до состояния «подключено». */
async function connectOk(client: ObsClient): Promise<void> {
  const promise = client.connect("ws://localhost:4455");
  await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
  FakeSocket.last!.hello();
  await Promise.resolve();
  FakeSocket.last!.identified();
  await promise;
}

function infoLines(): string {
  return vi
    .mocked(log.info)
    .mock.calls.map((args) => args.join(" "))
    .join("\n");
}

beforeEach(() => {
  store.data = {};
  FakeSocket.last = null;
  FakeSocket.created = 0;
  FakeSocket.autoRespondAll = false;
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("подключение к OBS", () => {
  test("Identify уходит только после Hello, соединение готово по op:2", async () => {
    const client = new ObsClient();
    await connectOk(client);
    expect(client.getStatus().connected).toBe(true);
    const identify = JSON.parse(FakeSocket.last!.sent[0]) as { op: number };
    expect(identify.op).toBe(1);
    expect(infoLines()).toContain("подключено");
  });

  test("успешное подключение обнуляет бюджет попыток и на диске", async () => {
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 7;
    const client = new ObsClient();
    await connectOk(client);
    expect(store.data[OBS_RECONNECT_ATTEMPTS_KEY]).toBe(0);
    expect(store.data[OBS_RETRY_BLOCKED_KEY]).toBe(false);
  });
});

describe("политика повторов", () => {
  test.each([
    [4009, "auth"],
    [4008, "auth"],
    [4011, "protocol"],
  ])("код %d блокирует автоповторы с причиной %s и пишет это в лог", async (code, reason) => {
    const client = new ObsClient();
    const promise = client.connect("ws://localhost:4455");
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.close(code, "");
    await expect(promise).rejects.toThrow();

    expect(client.isAutoReconnectBlocked()).toBe(true);
    expect(store.data[OBS_RETRY_BLOCK_REASON_KEY]).toBe(reason);
    // Блокировка гасит и watchdog — без строки в логе это выглядит как
    // «всё внезапно перестало работать» (разбор жалобы 02.08.2026).
    expect(infoLines()).toContain("автоповторы заблокированы");
  });

  test("обычный обрыв не блокирует повторы", async () => {
    const client = new ObsClient();
    const promise = client.connect("ws://localhost:4455");
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.close(1006, "abnormal");
    await expect(promise).rejects.toThrow();
    expect(client.isAutoReconnectBlocked()).toBe(false);
  });

  test("исчерпанный бюджет попыток объявляется в логе, а не молчит", async () => {
    // Бюджет переживает выгрузку воркера: если он исчерпан, автоповторы
    // прекращаются до ручного вмешательства. Это обязано быть видно в логе —
    // иначе выглядит как «всё внезапно перестало работать».
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 10;
    const client = new ObsClient();
    const promise = client.connect("ws://localhost:4455");
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.close(1006, "abnormal");
    await expect(promise).rejects.toThrow();
    expect(infoLines()).toContain("бюджет переподключений исчерпан");
  });

  test("бюджет с диска подхватывается при следующем подключении", async () => {
    // Счётчик в памяти обнулялся выгрузкой воркера, и лимит был фиктивным.
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 4;
    const client = new ObsClient();
    const promise = client.connect("ws://localhost:4455");
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.close(1006, "abnormal");
    await expect(promise).rejects.toThrow();
    // Продолжили с пятой попытки, а не с первой.
    expect(store.data[OBS_RECONNECT_ATTEMPTS_KEY]).toBe(5);
  });

  test("ручное подключение возвращает бюджет и снимает блокировку", async () => {
    const client = new ObsClient();
    // Сначала доводим до настоящей блокировки — неверный пароль.
    const failed = client.connect("ws://localhost:4455");
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.close(4009, "");
    await expect(failed).rejects.toThrow();
    expect(client.isAutoReconnectBlocked()).toBe(true);

    await client.allowAutoReconnect();
    expect(client.isAutoReconnectBlocked()).toBe(false);
    expect(store.data[OBS_RECONNECT_ATTEMPTS_KEY]).toBe(0);
    expect(store.data[OBS_RETRY_BLOCKED_KEY]).toBe(false);
    expect(infoLines()).toContain("автоповторы разблокированы");
  });

  test("общий бюджет попыток читается с диска и оживает после сброса", async () => {
    // Гейт для watchdog/restore в background: исчерпанные 10 попыток должны
    // останавливать и их, а не только цепочку attemptReconnect (PERF-8).
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 10;
    const client = new ObsClient();
    expect(await client.isAttemptBudgetExhausted()).toBe(true);
    client.resetReconnectAttempts();
    expect(await client.isAttemptBudgetExhausted()).toBe(false);
    expect(store.data[OBS_RECONNECT_ATTEMPTS_KEY]).toBe(0);
  });
});

describe("бюджет проб и записей в connected-состоянии (PERF-8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.autoRespondAll = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushMicrotasks(times = 20): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  /** connectOk без vi.waitFor: на фейковых таймерах хватает микрозадач. */
  async function connectOkFake(client: ObsClient): Promise<void> {
    const promise = client.connect("ws://localhost:4455");
    await flushMicrotasks();
    FakeSocket.last!.hello();
    await flushMicrotasks();
    FakeSocket.last!.identified();
    await promise;
    await flushMicrotasks();
  }

  function getVersionProbes(socket: FakeSocket): number {
    return socket.sent.filter((raw) => {
      const msg = JSON.parse(raw) as { op: number; d?: { requestType?: string } };
      return msg.op === 6 && msg.d?.requestType === "GetVersion";
    }).length;
  }

  /** Timestamp'ы всех записей obs_connection_state — в порядке записи. */
  function stateWriteStamps(): number[] {
    return vi
      .mocked(browser.storage.local.set)
      .mock.calls.map((args) => args[0] as Record<string, { timestamp?: number }>)
      .filter((patch) => "obs_connection_state" in patch)
      .map((patch) => patch.obs_connection_state.timestamp ?? 0);
  }

  test("за 10 минут ≤30 GetVersion-проб и ≤10 записей state, паузы записи < 2 мин", async () => {
    const client = new ObsClient();
    await connectOkFake(client);
    const socket = FakeSocket.last!;
    const probesAtConnect = getVersionProbes(socket);
    const writesAtConnect = stateWriteStamps().length;

    await vi.advanceTimersByTimeAsync(600_000);

    // Бюджет проб: heartbeat 3/мин и НИЧЕГО сверх него (было 4/мин с alarm-пробой).
    const probes = getVersionProbes(socket) - probesAtConnect;
    expect(probes).toBeLessThanOrEqual(30);
    // Нижняя граница: «0 проб» тоже уложился бы в бюджет, но означал бы
    // мёртвый heartbeat — потерю соединения заметить некому.
    expect(probes).toBeGreaterThanOrEqual(28);

    // Бюджет записей: freshness-запись реже прежних 4/мин…
    const stamps = stateWriteStamps();
    expect(stamps.length - writesAtConnect).toBeLessThanOrEqual(10);
    // …но БЕЗ пауз ≥2 мин: getStoredConnectionState в obs-panel считает state
    // старше OBS_STATE_MAX_AGE_MS (2 мин) протухшим, и restore автосцены
    // перестал бы работать.
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i] - stamps[i - 1]).toBeLessThan(120_000);
    }
    expect(Date.now() - stamps[stamps.length - 1]).toBeLessThan(120_000);
  });

  test("hasFreshHeartbeat протухает после тишины дольше двух интервалов", async () => {
    const client = new ObsClient();
    await connectOkFake(client);
    expect(client.hasFreshHeartbeat()).toBe(true);
    // OBS замолчал: пробы уходят, ответов нет — свежесть кончается через 2×20с.
    FakeSocket.last!.autoRespond = false;
    await vi.advanceTimersByTimeAsync(41_000);
    expect(client.hasFreshHeartbeat()).toBe(false);
  });
});
