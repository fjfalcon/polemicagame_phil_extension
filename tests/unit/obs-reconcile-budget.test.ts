/**
 * Каденс OBS-части background (перф-аудит 06.08.2026, PERF-8):
 *  - alarm-проба watchdog'а не дублирует живой heartbeat (бюджет ≤3 проб/мин);
 *  - исчерпанный бюджет попыток — ОБЩИЙ: watchdog/restore не создают новых
 *    подключений, пока бюджет не сброшен легитимным событием;
 *  - один reconcile на пробуждение service worker;
 *  - ручное подключение сбрасывает бюджет и подключается.
 *
 * Импортируется НАСТОЯЩИЙ src/background/index.ts с настоящим ObsClient;
 * подменены только браузерные API, настройки и соседние модули background.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const wiring = vi.hoisted(() => ({
  onAlarm: [] as ((a: { name: string; scheduledTime: number }) => void)[],
  onMessage: [] as ((msg: unknown, sender: unknown) => unknown)[],
  onSettings: [] as ((patch: Record<string, unknown>) => void)[],
  alarms: new Map<string, { name: string; periodInMinutes?: number }>(),
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
      sync: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    alarms: {
      get: vi.fn(async (name: string) => wiring.alarms.get(name) ?? null),
      create: vi.fn(async (name: string, info: Record<string, unknown>) => {
        wiring.alarms.set(name, { name, ...info });
      }),
      clear: vi.fn(async (name: string) => wiring.alarms.delete(name)),
      getAll: vi.fn(async () => [...wiring.alarms.values()]),
      onAlarm: { addListener: (fn: (typeof wiring.onAlarm)[number]) => wiring.onAlarm.push(fn) },
    },
    runtime: {
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getURL: vi.fn(() => ""),
      sendMessage: vi.fn(async () => undefined),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async () => []),
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
  // Хендлер СОХРАНЯЕМ: блок реакции на смену настроек OBS не покрывался ни
  // одним тестом (adversarial 27.08, №5 — «зелёные тесты» о нём молчали).
  onSettingsChanged: vi.fn((fn: (patch: Record<string, unknown>) => void) => {
    wiring.onSettings.push(fn);
    return () => undefined;
  }),
}));
vi.mock("../../src/background/onboarding", () => ({ handleInstalled: vi.fn() }));
vi.mock("../../src/background/notes-coordinator", () => ({
  applyNoteOps: vi.fn(async () => undefined),
  mergeNotesViaCoordinator: vi.fn(async () => undefined),
}));

import { log } from "@core/log";
import { OBS_RECONNECT_ATTEMPTS_KEY } from "../../src/background/obs-client";

const OBS_WATCHDOG_ALARM = "polemica:obs-watchdog";

/** Двойник сокета OBS, сам отвечающий на op:6 (heartbeat остаётся живым). */
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
  hello(): void {
    this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
  }
  identified(): void {
    this.onmessage?.({ data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) });
  }
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Пробуждение по watchdog-будильнику: то, что делает браузер раз в минуту. */
async function fireWatchdogAlarm(): Promise<void> {
  for (const fn of wiring.onAlarm) fn({ name: OBS_WATCHDOG_ALARM, scheduledTime: Date.now() });
  await flushMicrotasks();
}

function degradedAttempts(): number {
  return vi
    .mocked(log.info)
    .mock.calls.filter((args) => args.join(" ").includes("редком режиме")).length;
}

function getVersionProbes(socket: FakeSocket): number {
  return socket.sent.filter((raw) => {
    const msg = JSON.parse(raw) as { op: number; d?: { requestType?: string } };
    return msg.op === 6 && msg.d?.requestType === "GetVersion";
  }).length;
}

/** Свежая инкарнация service worker: чистые модули + top-level side effects. */
async function bootBackground(): Promise<void> {
  vi.resetModules();
  await import("../../src/background/index");
  await flushMicrotasks();
}

beforeEach(() => {
  vi.useFakeTimers();
  store.data = {};
  settings.current = {
    extension_enabled: true,
    obs_enabled: true,
    obs_host: "ws://localhost:4455",
    obs_password: "",
    debug_logging_enabled: false,
  };
  wiring.onAlarm.length = 0;
  wiring.onMessage.length = 0;
  wiring.onSettings.length = 0;
  wiring.alarms.clear();
  FakeSocket.last = null;
  FakeSocket.created = 0;
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("общий бюджет попыток подключения (PERF-8)", () => {
  test("исчерпанный бюджет — РЕДКИЙ режим: ≤1 попытки в 5 минут, но не стоп", async () => {
    // Контрольное ревью 07.08.2026 (блокер): полная остановка watchdog'а
    // отнимала самовосстановление — стример перезапустил OBS посреди эфира,
    // и подключение не возвращалось до ручных действий. Редкий режим держит
    // и бюджет (~12 наборов/час вместо 60), и самовосстановление ≤5 минут.
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 10;
    await bootBackground();

    // Пробуждение — первая редкая попытка; будильник ЖИВ.
    expect(FakeSocket.created).toBe(1);
    expect(degradedAttempts()).toBe(1);
    expect(wiring.alarms.has(OBS_WATCHDOG_ALARM)).toBe(true);

    // Ближайшие минуты будильник просыпается, но НЕ набирает OBS.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(61_000);
      await fireWatchdogAlarm();
    }
    expect(FakeSocket.created, "внутри 5-минутного окна попыток нет").toBe(1);
    expect(wiring.alarms.has(OBS_WATCHDOG_ALARM), "будильник обязан жить").toBe(true);

    // Окно вышло — следующая редкая попытка.
    await vi.advanceTimersByTimeAsync(61_000);
    await fireWatchdogAlarm();
    expect(FakeSocket.created).toBe(2);
    expect(degradedAttempts()).toBe(2);
  });

  test("успешный Identify возвращает бюджет: второй обрыв чинится плотно", async () => {
    // Ревью 07.08 предлагало добавить сброс — оказалось, семантика УЖЕ есть
    // (инлайн-обнуление в connect-флоу на Identified, obs-client ~203), но
    // нигде не сторожилась. Пригвождаем: успешно восстановленная редким
    // режимом связь обязана вернуть плотный бюджет на следующий обрыв.
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 10;
    await bootBackground(); // редкая попытка → сокет 1
    expect(FakeSocket.created).toBe(1);

    FakeSocket.last!.hello();
    await flushMicrotasks();
    FakeSocket.last!.identified();
    await flushMicrotasks();
    expect(store.data[OBS_RECONNECT_ATTEMPTS_KEY], "Identify заслуживает бюджет заново").toBe(0);
  });

  test("ручное подключение сбрасывает бюджет и подключается плотно", async () => {
    store.data[OBS_RECONNECT_ATTEMPTS_KEY] = 10;
    // Свежая метка редкого режима: boot не должен тратить редкую попытку —
    // здесь проверяется именно РУЧНОЙ путь.
    store.data["obs_degraded_attempt_at"] = Date.now();
    await bootBackground();
    expect(FakeSocket.created).toBe(0);

    const handler = wiring.onMessage[0];
    expect(handler).toBeDefined();
    const reply = handler(
      {
        type: "obs_command",
        command: "connect",
        data: { url: "ws://localhost:4455", password: "" },
      },
      {},
    ) as Promise<{ success: boolean }>;
    await flushMicrotasks();
    FakeSocket.last!.hello();
    await flushMicrotasks();
    FakeSocket.last!.identified();
    await expect(reply).resolves.toMatchObject({ success: true });

    expect(FakeSocket.created).toBe(1);
    expect(store.data[OBS_RECONNECT_ATTEMPTS_KEY]).toBe(0);
    expect(wiring.alarms.has(OBS_WATCHDOG_ALARM)).toBe(true);
  });
});

describe("alarm-проба не дублирует живой heartbeat (PERF-8)", () => {
  test("в connected-состоянии минутный alarm не добавляет 4-ю GetVersion-пробу", async () => {
    await bootBackground();
    // Restore при загрузке модуля подключается сам (бюджет свеж).
    expect(FakeSocket.last).not.toBeNull();
    FakeSocket.last!.hello();
    await flushMicrotasks();
    FakeSocket.last!.identified();
    await flushMicrotasks();
    const socket = FakeSocket.last!;
    expect(getVersionProbes(socket)).toBe(0);

    // За минуту heartbeat даёт свои 3 пробы (шаг 20с)…
    await vi.advanceTimersByTimeAsync(61_000);
    expect(getVersionProbes(socket)).toBe(3);

    // …а watchdog-будильник поверх живого heartbeat пробу НЕ добавляет —
    // раньше это была 4-я в минуту (бюджет ≤3/мин).
    await fireWatchdogAlarm();
    expect(getVersionProbes(socket)).toBe(3);
    expect(FakeSocket.created).toBe(1);
  });
});

describe("смена OBS-настроек: один упорядоченный переход (ревью 27.08.2026)", () => {
  test("host (sync) и пароль (local) приходят порознь — реагируем ОДИН раз", async () => {
    // Раньше реакция на первое событие подключалась к новому endpoint со
    // старым паролем: события разных областей приходят по очереди.
    await bootBackground();
    FakeSocket.last?.hello();
    await flushMicrotasks();
    FakeSocket.last?.identified(); // иначе connect висит и держит очередь OBS
    await flushMicrotasks();
    FakeSocket.created = 0;

    const emit = (patch: Record<string, unknown>) => {
      for (const fn of wiring.onSettings) fn(patch);
    };
    emit({ obs_host: "ws://new-host:4455" });
    emit({ obs_password: "свежий" });
    // До окна коалесценции реакции нет вовсе.
    expect(FakeSocket.created, "не дёргаемся на первом же событии").toBe(0);

    settings.current.obs_host = "ws://new-host:4455";
    settings.current.obs_password = "свежий";
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    // Ровно одно переподключение — по СОБРАННОМУ намерению.
    // Ровно ОДИН переход по собранному намерению — вместо двух подряд.
    const transitions = vi
      .mocked(log.info)
      .mock.calls.filter((c) => String(c[1]).includes("переход настроек OBS"));
    expect(transitions, "один переход, а не два").toHaveLength(1);
    expect(String(transitions[0][2]), "и адрес, и пароль в одном переходе").toBe("адрес+пароль");
  });

  test("прицепное событие без реального перехода не рождает подключений", async () => {
    await bootBackground();
    FakeSocket.last?.hello();
    await flushMicrotasks();
    FakeSocket.last?.identified();
    await flushMicrotasks();
    FakeSocket.created = 0;
    for (const fn of wiring.onSettings) fn({ obs_host: settings.current.obs_host });
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(
      vi.mocked(log.info).mock.calls.filter((c) => String(c[1]).includes("переход настроек OBS")),
      "прицепное событие переходом не считается",
    ).toHaveLength(0);
  });
});
