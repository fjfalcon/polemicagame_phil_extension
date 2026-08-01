// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), safeClick: vi.fn(), isVisible: () => true }));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { shouldSwallowRoleKey } from "@content/features/role-faker";

function keydown(init: KeyboardEventInit & { code: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shouldSwallowRoleKey (§4.5 gates of the D blocker)", () => {
  test("swallows the configured hide key", () => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD" }), "KeyD")).toBe(true);
  });

  test("matches by physical key, not by layout (KeyD is «в» in Russian)", () => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD", key: "в" }), "KeyD")).toBe(true);
    expect(shouldSwallowRoleKey(keydown({ code: "KeyV", key: "d" }), "KeyD")).toBe(false);
  });

  test("keeps swallowing an auto-repeating key", () => {
    // Инвертированный гейт §4.5: пропустив повтор, мы отдали бы D сайту, и он
    // показал бы настоящую роль посреди подмены. Тест держит это решение.
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD", repeat: true }), "KeyD")).toBe(true);
  });

  test.each(["KeyF", "KeyE", "Space"])("ignores unrelated key %s", (code) => {
    expect(shouldSwallowRoleKey(keydown({ code }), "KeyD")).toBe(false);
  });

  test("follows the rebound hide key, not the literal D", () => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD" }), "KeyG")).toBe(false);
    expect(shouldSwallowRoleKey(keydown({ code: "KeyG" }), "KeyG")).toBe(true);
  });

  test.each([
    ["ctrlKey", { ctrlKey: true }],
    ["metaKey", { metaKey: true }],
    ["altKey", { altKey: true }],
  ])("does not swallow a %s combination", (_name, modifier) => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD", ...modifier }), "KeyD")).toBe(false);
  });

  test("does not swallow while the user is typing (KeyD is «в» in Russian)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const event = keydown({ code: "KeyD" });
    input.dispatchEvent(event);
    expect(shouldSwallowRoleKey(event, "KeyD")).toBe(false);
  });
});
