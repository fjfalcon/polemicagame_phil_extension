/**
 * Псевдонимизация ника для журнала (ревью 26.08.2026): «ники в файл не
 * пишем» — глобальное правило, а не точечный фикс camera-health.
 */
import { describe, expect, test } from "vitest";
import { redactNick } from "@shared/redact";

describe("redactNick", () => {
  test("ник не восстановим из результата, но коррелируем внутри сессии", () => {
    const a = redactNick("Иван Бездопный");
    expect(a).not.toContain("Иван");
    expect(redactNick("Иван Бездопный")).toBe(a); // стабильность = корреляция
    expect(redactNick("Пешка")).not.toBe(a);
  });
  test("длина — в кодовых точках (эмодзи не двоятся)", () => {
    expect(redactNick("ab🎥")).toContain("·3с");
  });
});

describe("персистентный журнал без сырых ников", () => {
  test("строки player-notes с ником идут через redactNick", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/features/player-notes.ts", "utf8");
    // Страж-грep: интерполяция сырого username в log.* — регресс правила.
    const raw = src.match(/log\.(warn|error|info)\([^)]*\$\{username\}/g) ?? [];
    expect(raw, "сырой ник в persistent-логе — верни redactNick").toEqual([]);
  });
});
