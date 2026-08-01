import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  listener: null as null | ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void),
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(), set: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn() },
      onChanged: {
        addListener: vi.fn((listener) => {
          state.listener = listener;
        }),
        removeListener: vi.fn(),
      },
    },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DEFAULT_SETTINGS, onSettingsChanged } from "@core/settings";

beforeEach(() => {
  state.listener = null;
});

describe("дефолты, от которых зависит поддержка", () => {
  test("запись логов включена по умолчанию", () => {
    // Решение владельца (02.08.2026): лог — единственный способ разобрать
    // жалобу «перестало работать», а просить пользователя включить запись и
    // ВОСПРОИЗВЕСТИ проблему заново получается далеко не всегда. Буфер
    // кольцевой (600 записей на контекст), секреты вычищаются redactSecrets.
    expect(DEFAULT_SETTINGS.debug_logging_enabled).toBe(true);
  });

  test("диагностика соединения остаётся выключенной по умолчанию", () => {
    // Она подменяет WebSocket в мире страницы — это осознанно opt-in.
    expect(DEFAULT_SETTINGS.connection_diag_enabled).toBe(false);
  });
});

describe("Firefox-compatible settings changes", () => {
  test("ignores unchanged keys sent by Firefox", () => {
    const handler = vi.fn();
    onSettingsChanged(handler);
    state.listener?.({ obs_enabled: { oldValue: true, newValue: true } }, "sync");
    expect(handler).not.toHaveBeenCalled();
  });

  test("normalizes a removed key back to its default", () => {
    const handler = vi.fn();
    onSettingsChanged(handler);
    state.listener?.(
      { queue_background_warning_enabled: { oldValue: false, newValue: undefined } },
      "sync",
    );
    expect(handler).toHaveBeenCalledWith({
      queue_background_warning_enabled: DEFAULT_SETTINGS.queue_background_warning_enabled,
    });
  });

  test("ignores unknown keys and unrelated storage areas", () => {
    const handler = vi.fn();
    onSettingsChanged(handler);
    state.listener?.({ playerNotes: { oldValue: {}, newValue: { Alice: "x" } } }, "local");
    state.listener?.({ obs_enabled: { oldValue: false, newValue: true } }, "managed");
    expect(handler).not.toHaveBeenCalled();
  });
});
