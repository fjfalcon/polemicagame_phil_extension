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
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(public readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.created++;
  }
  send(data: string): void {
    this.sent.push(data);
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
});
