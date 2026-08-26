// @vitest-environment jsdom
/** Клипы: перевод настройки-минут в секунды OBS с защитой от мусора. */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({ sendRuntime: vi.fn(async () => ({ success: true })) }));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));
vi.mock("@core/keyboard", () => ({ keyboard: { register: vi.fn(() => () => undefined) } }));

import { clipSeconds } from "@content/features/obs-clip";

describe("длина буфера", () => {
  test("минуты настроек — в секунды OBS", () => {
    expect(clipSeconds(1)).toBe(60);
    expect(clipSeconds(5)).toBe(300);
  });
  test("границы: не короче минуты, не длиннее 20", () => {
    expect(clipSeconds(0)).toBe(60);
    expect(clipSeconds(999)).toBe(1200);
  });
  test("мусор из хранилища — дефолтная минута, не NaN-секунды", () => {
    expect(clipSeconds("три")).toBe(60);
    expect(clipSeconds(undefined)).toBe(60);
    expect(clipSeconds(Number.NaN)).toBe(60);
  });
});
