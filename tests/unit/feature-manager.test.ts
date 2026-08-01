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
