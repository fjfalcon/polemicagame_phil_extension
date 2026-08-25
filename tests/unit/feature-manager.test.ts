import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: { extension_enabled: true, auto_accept_enabled: true } as Record<string, unknown>,
  onChange: null as null | ((patch: Record<string, unknown>) => void),
}));

vi.mock("@core/settings", () => ({
  getSettings: vi.fn(async () => state.settings),
  onSettingsChanged: vi.fn((handler) => {
    state.onChange = handler;
    return vi.fn();
  }),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FeatureManager, type Feature } from "@core/feature";
import { log } from "@core/log";

beforeEach(() => {
  vi.useFakeTimers();
  state.settings = { extension_enabled: true, auto_accept_enabled: true };
  state.onChange = null;
});

describe("FeatureManager lifecycle", () => {
  test("rolls back partial resources when enable throws", async () => {
    const feature: Feature = {
      id: "broken",
      settingKey: "auto_accept_enabled",
      enable: vi.fn(async () => {
        throw new Error("partial setup failed");
      }),
      disable: vi.fn(),
    };
    await new FeatureManager().register(feature).start();
    expect(feature.enable).toHaveBeenCalledTimes(1);
    expect(feature.disable).toHaveBeenCalledTimes(1);
  });

  test("master switch disables even an always-on feature", async () => {
    const feature: Feature = {
      id: "always",
      settingKey: null,
      enable: vi.fn(),
      disable: vi.fn(),
    };
    await new FeatureManager().register(feature).start();
    state.onChange?.({ extension_enabled: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(feature.disable).toHaveBeenCalledTimes(1);
  });

  test("coalesces split sync/local storage events into one update pass", async () => {
    const feature: Feature = {
      id: "updatable",
      settingKey: null,
      enable: vi.fn(),
      disable: vi.fn(),
      update: vi.fn(),
    };
    await new FeatureManager().register(feature).start();
    state.onChange?.({ auto_accept_enabled: false });
    state.onChange?.({ extension_enabled: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(feature.update).toHaveBeenCalledTimes(1);
  });
});

describe("бут-лог пропущенных фич (жалоба 25.08.2026: «кнопок нет», а журнал молчал)", () => {
  const gated = (): Feature => ({
    id: "stats-like",
    settingKey: "statistics_enabled",
    enable: vi.fn(),
    disable: vi.fn(),
  });

  test("truthy-мусор в хранилище: фича пропущена И журнал называет виновника с типом", async () => {
    // Строка "true" — попап раньше рисовал галочку, гейт фичу не включал.
    state.settings = { extension_enabled: true, statistics_enabled: "true" };
    const f = gated();
    await new FeatureManager().register(f).start();
    // Гейт обязан быть строгим === true: мутант «!== false» включил бы фичу
    // от мусорного значения — и молча разошёлся бы с журналом.
    expect(f.enable).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "feature",
      "пропущены настройками:",
      'stats-like(statistics_enabled="true")',
    );
  });

  test("выключено честным false — тоже в журнале, булев тип виден без кавычек", async () => {
    state.settings = { extension_enabled: true, statistics_enabled: false };
    await new FeatureManager().register(gated()).start();
    expect(log.info).toHaveBeenCalledWith(
      "feature",
      "пропущены настройками:",
      "stats-like(statistics_enabled=false)",
    );
  });

  test("все гейтовые фичи включены — строки про пропуски нет", async () => {
    state.settings = { extension_enabled: true, statistics_enabled: true };
    await new FeatureManager().register(gated()).start();
    const calls = (log.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => c.includes("пропущены настройками:"))).toBe(false);
  });

  test("мастер-выключатель — не «пропуск»: списка нет, чтобы не пугать полным перечнем", async () => {
    state.settings = { extension_enabled: false, statistics_enabled: true };
    await new FeatureManager().register(gated()).start();
    const calls = (log.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => c.includes("пропущены настройками:"))).toBe(false);
  });
});
