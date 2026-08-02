import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(), set: vi.fn() }, sync: { get: vi.fn(), set: vi.fn() } },
    runtime: { id: "x", getManifest: () => ({ version: "9.2.0" }) },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), safeClick: vi.fn(), isVisible: () => true }));
vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(),
  sendToActiveTabStrict: vi.fn(),
  broadcastToGameTabs: vi.fn(),
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { pendingIdLookups } from "@content/features/player-notes";

const never = () => false;

/**
 * Гейт частоты для резолва id игроков.
 *
 * Проход по плиткам идёт раз в две секунды. Без этого гейта резолв
 * превратился бы в фоновый поток запросов — а сам резолв понадобился потому,
 * что игрок, сменивший ник, сидел за столом «чужим» до наведения мышью
 * (жалоба с видео 02.08.2026).
 */
describe("pendingIdLookups", () => {
  test("свежий стол — резолвим всех", () => {
    const out = pendingIdLookups(["Аня", "Боря"], { attempted: new Set(), isKnown: never });
    expect(out).toEqual(["Аня", "Боря"]);
  });

  test("повторный проход ничего не запрашивает", () => {
    // Главное свойство: второй тик через две секунды обязан дать пустой список.
    const attempted = new Set(["аня", "боря"]);
    expect(pendingIdLookups(["Аня", "Боря"], { attempted, isKnown: never })).toEqual([]);
  });

  test("уже известный id не перепрашивается", () => {
    const out = pendingIdLookups(["Аня", "Боря"], {
      attempted: new Set(),
      isKnown: (u) => u === "Аня",
    });
    expect(out).toEqual(["Боря"]);
  });

  test("дубликаты плиток не дают повторных запросов", () => {
    // Сайт рисует игрока и в списке участников, и плиткой.
    const out = pendingIdLookups(["Аня", "аня", "АНЯ"], { attempted: new Set(), isKnown: never });
    expect(out).toEqual(["Аня"]);
  });

  test("пустые и пробельные имена отбрасываются", () => {
    // Плитка может быть ещё не отрисована — имени в ней нет.
    const out = pendingIdLookups(["", "   ", "Аня"], { attempted: new Set(), isKnown: never });
    expect(out).toEqual(["Аня"]);
  });

  test("имя с пробелами по краям считается тем же игроком", () => {
    const out = pendingIdLookups(["  Аня  "], { attempted: new Set(["аня"]), isKnown: never });
    expect(out).toEqual([]);
  });
});
