// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { formatKeyCode, isModifierCode, keyboard, producesText } from "@core/keyboard";

afterEach(() => {
  document.body.replaceChildren();
});

describe("keyboard helpers and router gates", () => {
  test.each([
    ["KeyF", true],
    ["Digit1", true],
    ["Space", true],
    ["F8", false],
    ["ArrowUp", false],
  ] as const)("producesText(%s) -> %s", (code, expected) => {
    expect(producesText(code)).toBe(expected);
  });

  test.each([
    ["ShiftLeft", true],
    ["ControlRight", true],
    ["KeyF", false],
  ] as const)("isModifierCode(%s) -> %s", (code, expected) => {
    expect(isModifierCode(code)).toBe(expected);
  });

  test.each([
    ["KeyP", "P"],
    ["Digit5", "5"],
    ["ArrowUp", "Up"],
    ["Escape", "Esc"],
  ] as const)("formatKeyCode(%s) -> %s", (code, expected) => {
    expect(formatKeyCode(code)).toBe(expected);
  });

  test("blocks text-producing hotkeys while typing and allows F-keys", () => {
    const textHandler = vi.fn();
    const fHandler = vi.fn();
    const offText = keyboard.register("KeyQ", textHandler);
    const offF = keyboard.register("F9", fHandler);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "F9", bubbles: true }));
    expect(textHandler).not.toHaveBeenCalled();
    expect(fHandler).toHaveBeenCalledTimes(1);
    offText();
    offF();
  });

  test.each([
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { repeat: true },
  ])("blocks modifiers/repeat: $ctrlKey$metaKey$altKey$repeat", (init) => {
    const handler = vi.fn();
    const off = keyboard.register("KeyZ", handler);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", bubbles: true, ...init }));
    expect(handler).not.toHaveBeenCalled();
    off();
  });
});
