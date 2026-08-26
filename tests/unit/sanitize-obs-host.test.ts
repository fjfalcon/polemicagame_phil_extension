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
  test("путь сохраняется: obs-websocket за реверс-прокси легален", () => {
    expect(sanitizeObsHost("wss://obs.example.com/websocket?token=X")).toBe(
      "wss://obs.example.com/websocket",
    );
  });
  test("bare-host без схемы не «нормализуется» в мусор", () => {
    // URL-парсер увидел бы схему «localhost:» — чистим руками, не трогая вид.
    expect(sanitizeObsHost("localhost:4455")).toBe("localhost:4455");
    expect(sanitizeObsHost("user:pass@localhost:4455?t=1")).toBe("localhost:4455");
  });
  test("непарсибельное: userinfo и query всё равно срезаны руками", () => {
    const out = sanitizeObsHost("ws://user:pass@[битый/?token=x");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("token");
  });
});
