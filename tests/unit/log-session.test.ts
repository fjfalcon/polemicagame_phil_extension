// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  },
}));

import { log } from "@core/log";

describe("метка документа в строках content (LOG-2)", () => {
  test("контекст строки — content#<сессия>, а не просто content", () => {
    // Строки двух одновременно открытых игр иначе неразличимы в экспорте:
    // «одна вкладка владеет сценой, вторая получает отказ» выглядело кашей.
    // Проверять это можно ТОЛЬКО в окружении страницы сайта — в node-контексте
    // логгер считает себя фоном, и прежний тест проходил при любой реализации.
    log.info("test", "строка");
    const entry = log.getBuffer().at(-1)!;
    expect(entry.c).toMatch(/^content#[0-9a-z-]{1,8}$/i);
  });

  test("все строки одного документа помечены одинаково", () => {
    log.info("test", "первая");
    log.info("test", "вторая");
    const [a, b] = log.getBuffer().slice(-2);
    expect(a.c).toBe(b.c);
  });
});
