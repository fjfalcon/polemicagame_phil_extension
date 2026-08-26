/** SEC26-1: креды/query в obs_host не переживают сохранение. */
import { describe, expect, test } from "vitest";
import { sanitizeObsHost } from "@shared/safe-endpoint";

describe("sanitizeObsHost", () => {
  test("userinfo и query отрезаются, хост/порт остаются", () => {
    expect(sanitizeObsHost("ws://admin:hunter2@10.0.0.5:4455/?token=SECRET")).toBe(
      "ws://10.0.0.5:4455",
    );
  });
  test("чистый адрес не меняется по смыслу", () => {
    expect(sanitizeObsHost("ws://localhost:4455")).toBe("ws://localhost:4455");
  });
  test("пустое/пробельное — пустое", () => {
    expect(sanitizeObsHost("   ")).toBe("");
  });
  test("непарсибельное: userinfo и query всё равно срезаны руками", () => {
    const out = sanitizeObsHost("ws://user:pass@[битый/?token=x");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("token");
  });
});
