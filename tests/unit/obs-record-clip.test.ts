/**
 * Автозапись игр и клипы (стримерский пакет 26.08.2026).
 *
 * Запись — ЧУЖОЙ ресурс стримера, поэтому стражи жёсткие:
 *  • чужую (ручную) запись не присваиваем и не останавливаем;
 *  • свою останавливаем только когда игровых вкладок больше нет;
 *  • сохранение клипа при незапущенном буфере — честная ошибка, не тишина.
 *
 * Импортируется НАСТОЯЩИЙ background/index.ts с настоящим ObsClient
 * (двойник сокета по образцу obs-reconcile-budget.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const wiring = vi.hoisted(() => ({
  onMessage: [] as ((msg: unknown, sender: unknown) => unknown)[],
  roomTabs: [] as { id: number }[],
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, unknown> | string[] | string) => {
          if (typeof defaults === "string") {
            return defaults in store.data ? { [defaults]: store.data[defaults] } : {};
          }
          if (Array.isArray(defaults)) {
            const out: Record<string, unknown> = {};
            for (const key of defaults) if (key in store.data) out[key] = store.data[key];
            return out;
          }
          const out: Record<string, unknown> = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            out[key] = key in store.data ? store.data[key] : fallback;
          }
          return out;
        }),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store.data, patch);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store.data[key];
        }),
      },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    },
    alarms: {
      get: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      getAll: vi.fn(async () => []),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getURL: vi.fn(() => ""),
      sendMessage: vi.fn(async () => undefined),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async (q: { url?: string }) =>
        q.url === "*://*.polemicagame.com/game/*" ? wiring.roomTabs : [],
      ),
      sendMessage: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setPersist: vi.fn() },
}));
vi.mock("@core/errors", () => ({ installErrorCapture: vi.fn() }));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn((fn: (typeof wiring.onMessage)[number]) => {
    wiring.onMessage.push(fn);
    return () => undefined;
  }),
  sendToTab: vi.fn(async () => undefined),
  sendRuntime: vi.fn(async () => undefined),
  broadcastToGameTabs: vi.fn(async () => undefined),
}));
vi.mock("@core/settings", () => ({
  getSettings: vi.fn(async () => settings.current),
  getSetting: vi.fn(async (key: string) => settings.current[key]),
  onSettingsChanged: vi.fn(() => () => undefined),
}));
vi.mock("../../src/background/onboarding", () => ({ handleInstalled: vi.fn() }));
vi.mock("../../src/background/notes-coordinator", () => ({
  applyNoteOps: vi.fn(async () => undefined),
  mergeNotesViaCoordinator: vi.fn(async () => undefined),
}));

/** Двойник OBS: хендшейк + стейт записи/буфера/параметров профиля. */
class FakeObs {
  static last: FakeObs | null = null;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  recording = false;
  replayActive = false;
  /** Replay Buffer выключен в настройках OBS → StartReplayBuffer отказывает. */
  replayAllowed = true;
  params = new Map<string, string>([["Output/Mode", "Simple"]]);
  readonly requests: string[] = [];

  constructor(public readonly url: string) {
    FakeObs.last = this;
  }

  send(data: string): void {
    const msg = JSON.parse(data) as {
      op: number;
      d?: { requestType?: string; requestId?: number; requestData?: Record<string, unknown> };
    };
    if (msg.op === 1) {
      this.onmessage?.({ data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) });
      return;
    }
    if (msg.op !== 6) return;
    const type = msg.d?.requestType ?? "";
    const rd = msg.d?.requestData ?? {};
    this.requests.push(type);
    let result = true;
    let responseData: Record<string, unknown> = {};
    switch (type) {
      case "GetSceneList":
        responseData = { scenes: [], currentProgramSceneName: "Сцена" };
        break;
      case "GetRecordStatus":
        responseData = { outputActive: this.recording };
        break;
      case "StartRecord":
        this.recording = true;
        break;
      case "StopRecord":
        this.recording = false;
        responseData = { outputPath: "/rec/игра.mkv" };
        break;
      case "GetReplayBufferStatus":
        responseData = { outputActive: this.replayActive };
        break;
      case "StartReplayBuffer":
        if (this.replayAllowed) this.replayActive = true;
        else result = false;
        break;
      case "StopReplayBuffer":
        this.replayActive = false;
        break;
      case "SaveReplayBuffer":
        result = this.replayActive;
        break;
      case "GetProfileParameter":
        responseData = {
          parameterValue:
            this.params.get(`${rd.parameterCategory}/${rd.parameterName}`) ?? null,
        };
        break;
      case "SetProfileParameter":
        this.params.set(`${rd.parameterCategory}/${rd.parameterName}`, String(rd.parameterValue));
        break;
      default:
        break;
    }
    this.onmessage?.({
      data: JSON.stringify({
        op: 7,
        d: {
          requestId: msg.d?.requestId,
          requestStatus: { result, comment: result ? undefined : "отказ OBS" },
          responseData,
        },
      }),
    });
  }

  close(code = 1000, reason = ""): void {
    this.onclose?.({ code, reason });
  }

  hello(): void {
    this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
  }
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function bootConnected(): Promise<FakeObs> {
  vi.resetModules();
  await import("../../src/background/index");
  await flush();
  const socket = FakeObs.last;
  if (!socket) throw new Error("background не открыл сокет OBS");
  socket.hello();
  await flush();
  return socket;
}

/** Команда из вкладки: как её доставил бы content-скрипт. */
async function command(
  cmd: string,
  data?: Record<string, unknown>,
  tabId = 5,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  for (const fn of wiring.onMessage) {
    const res = fn({ type: "obs_command", command: cmd, data }, { tab: { id: tabId } });
    if (res !== undefined) return (await res) as never;
  }
  throw new Error("обработчик obs_command не найден");
}

beforeEach(() => {
  store.data = {};
  wiring.onMessage.length = 0;
  wiring.roomTabs = [];
  settings.current = {
    extension_enabled: true,
    obs_enabled: true,
    obs_host: "ws://localhost:4455",
    obs_password: "",
    debug_logging_enabled: false,
  };
  FakeObs.last = null;
  vi.stubGlobal("WebSocket", FakeObs as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("автозапись игр", () => {
  test("старт при простое: запись пошла и помечена НАШЕЙ", async () => {
    const obs = await bootConnected();
    const res = await command("record_start");
    expect(res.success).toBe(true);
    expect(res.data?.started).toBe(true);
    expect(obs.recording).toBe(true);
    expect(store.data.obs_auto_record_started).toBe(true);
  });

  test("стример уже пишет сам — не присваиваем и потом НЕ останавливаем", async () => {
    const obs = await bootConnected();
    obs.recording = true; // запись включена руками до игры
    const start = await command("record_start");
    expect(start.data?.already).toBe(true);
    expect(store.data.obs_auto_record_started).toBeUndefined();

    const stop = await command("record_stop");
    expect(stop.data?.ignored).toBe("not_ours");
    expect(obs.recording, "ручная запись стримера жива").toBe(true);
    expect(obs.requests).not.toContain("StopRecord");
  });

  test("своя запись останавливается на выходе из комнаты", async () => {
    const obs = await bootConnected();
    await command("record_start");
    const stop = await command("record_stop");
    expect(stop.data?.stopped).toBe(true);
    expect(stop.data?.path).toBe("/rec/игра.mkv");
    expect(obs.recording).toBe(false);
    expect(store.data.obs_auto_record_started).toBeUndefined();
  });

  test("вторая игровая вкладка держит запись живой", async () => {
    const obs = await bootConnected();
    await command("record_start", undefined, 5);
    wiring.roomTabs = [{ id: 9 }]; // другая вкладка всё ещё в комнате
    const stop = await command("record_stop", undefined, 5);
    expect(stop.data?.ignored).toBe("other_room_tabs");
    expect(obs.recording, "запись продолжается для второй вкладки").toBe(true);
    expect(store.data.obs_auto_record_started, "флаг не потерян").toBe(true);
  });
});

describe("клипы (Replay Buffer)", () => {
  test("настройка: длина буфера в профиль (Simple) и старт буфера", async () => {
    const obs = await bootConnected();
    const res = await command("replay_setup", { seconds: 120 });
    expect(res.success).toBe(true);
    expect(obs.params.get("SimpleOutput/RecRBTime")).toBe("120");
    expect(obs.replayActive).toBe(true);
  });

  test("режим Advanced пишет параметр в свою категорию", async () => {
    const obs = await bootConnected();
    obs.params.set("Output/Mode", "Advanced");
    await command("replay_setup", { seconds: 300 });
    expect(obs.params.get("AdvOut/RecRBTime")).toBe("300");
    expect(obs.params.has("SimpleOutput/RecRBTime")).toBe(false);
  });

  test("смена длины при живом буфере перезапускает его", async () => {
    const obs = await bootConnected();
    await command("replay_setup", { seconds: 60 });
    obs.requests.length = 0;
    await command("replay_setup", { seconds: 180 });
    expect(obs.requests).toContain("StopReplayBuffer");
    expect(obs.requests).toContain("StartReplayBuffer");
    expect(obs.replayActive).toBe(true);
  });

  test("та же длина повторно — буфер НЕ перезапускается (хвост не теряем зря)", async () => {
    const obs = await bootConnected();
    await command("replay_setup", { seconds: 60 });
    obs.requests.length = 0;
    await command("replay_setup", { seconds: 60 });
    expect(obs.requests).not.toContain("StopReplayBuffer");
  });

  test("сохранение клипа при незапущенном буфере — честная ошибка про OBS", async () => {
    await bootConnected();
    const res = await command("replay_save");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Replay Buffer");
  });

  test("буфер запущен — клип сохраняется", async () => {
    const obs = await bootConnected();
    await command("replay_setup", { seconds: 60 });
    const res = await command("replay_save");
    expect(res.success).toBe(true);
    expect(obs.requests).toContain("SaveReplayBuffer");
  });
});
