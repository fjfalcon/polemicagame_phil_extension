import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
  },
}));

import { redactSecrets } from "@core/log";

describe("redactSecrets", () => {
  test.each([
    "authKey=abcdef123",
    "token: abcdef123",
    "password='abcdef123'",
    "sid=abcdef123",
    "Authorization: Bearer abc.def.ghi",
    "refresh_token=abcdef123",
  ])("redacts %s", (input) => {
    const result = redactSecrets(input);
    expect(result).toContain("…");
    expect(result).not.toMatch(/abcdef123|abc\.def\.ghi/);
  });

  test.each(["considered safe", "resident player", "presidential speech"])(
    "does not damage ordinary text: %s",
    (input) => expect(redactSecrets(input)).toBe(input),
  );

  test("applies the requested output cap after redaction", () => {
    expect(redactSecrets(`token=${"x".repeat(1000)} ${"y".repeat(1000)}`, 32)).toHaveLength(32);
  });

  test.todo("BUG: redact pretty-printed JSON secrets such as `\"token\" : \"abcdef\"`");
});
