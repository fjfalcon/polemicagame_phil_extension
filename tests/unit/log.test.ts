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

  // Все три — с подчёркиванием: именно на нём ломался \b и секрет уезжал
  // в лог целиком. Дефис давал границу слова и чистился всегда.
  test.each(["obs_password=abcdef123", "pn_session_id: abcdef123", "x_api_key=abcdef123"])(
    "redacts a prefixed secret key %s",
    (input) => {
      const result = redactSecrets(input);
      expect(result).toContain("…");
      expect(result).not.toContain("abcdef123");
    },
  );

  test.each(["considered safe", "resident player", "presidential speech"])(
    "does not damage ordinary text: %s",
    (input) => expect(redactSecrets(input)).toBe(input),
  );

  test("applies the requested output cap after redaction", () => {
    expect(redactSecrets(`token=${"x".repeat(1000)} ${"y".repeat(1000)}`, 32)).toHaveLength(32);
  });

  test.each([
    '"token" : "abcdef123"',
    '{\n  "authKey" :  "abcdef123"\n}',
    JSON.stringify({ obs_password: "abcdef123", session_id: "abcdef123" }, null, 2),
  ])("redacts pretty-printed JSON secret %j", (input) => {
    const result = redactSecrets(input, 4000);
    expect(result).toContain("…");
    expect(result).not.toContain("abcdef123");
  });

  test("does not swallow the next line of the log as a value", () => {
    // \n не входит в разделители: иначе слово со следующей строки вырезалось
    // как «значение» ключевого слова с предыдущей (ревью 02.08.2026, №11).
    expect(redactSecrets("secret\n    следующая строка")).toBe("secret\n    следующая строка");
  });
});
