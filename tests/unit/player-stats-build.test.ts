/**
 * Сборка статистики игрока из ответов API.
 *
 * Это ЧИСЛА, которые расширение утверждает про человека: «винрейт 63.2%»,
 * «первым убивали в 12% игр». До выделения слоя (арх-ревью 28.08.2026)
 * проверить деление на ноль и мусор из API можно было только через живой
 * стол — то есть на практике никак.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() } }, runtime: { id: "x" } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildStatsEntry,
  calcWinrate,
  unavailablePlayerStats,
} from "@content/features/player-notes/player-stats";

const meta = { userId: 42, mmr: 1500, fromRating: false };

describe("процент побед", () => {
  test.each([
    [7, 10, "70.0"],
    [1, 3, "33.3"],
    [0, 0, "0.0"],
    [5, 0, "0.0"],
    [undefined, undefined, "0.0"],
    ["12", "20", "60.0"],
    ["мусор", 10, "0.0"],
  ])("%p из %p → %s", (wins, total, expected) => {
    expect(calcWinrate(wins, total)).toBe(expected);
  });

  test("ноль игр НЕ даёт NaN — иначе в тултипе висело бы «NaN%»", () => {
    expect(calcWinrate(0, 0)).not.toContain("NaN");
  });
});

describe("сборка записи", () => {
  const payload = {
    general: [{ games_count: 200, wins_count: 126 }],
    roles: {
      civilian: { wins_count: 60, games_count: 100 },
      sheriff: { wins_count: 12, games_count: 20 },
      mafia: { wins_count: 40, games_count: 60 },
      godfather: { wins_count: 14, games_count: 20 },
    },
    killcount: [{ first_killed_count: 24, games_count: 120 }],
  };

  test("считает общий винрейт и процент «первым убили»", () => {
    const e = buildStatsEntry(payload, meta);
    expect(e.generalStats.winrate).toBe("63.0");
    expect(e.generalStats.killpercent).toBe(20);
    expect(e.totalGames).toBe(200);
    expect(e.id).toBe(42);
    expect(e.mmr).toBe(1500);
  });

  test("винрейты по ролям — каждая своя", () => {
    const e = buildStatsEntry(payload, meta);
    expect(e.roleStats.civilian.winrate).toBe("60.0");
    expect(e.roleStats.sheriff.winrate).toBe("60.0");
    expect(e.roleStats.mafia.winrate).toBe("66.7");
    expect(e.roleStats.godfather.winrate).toBe("70.0");
  });

  test("пустые ответы API не дают NaN и Infinity", () => {
    // Сайт отдаёт [] на игроке без игр — раньше деление на ноль давало NaN,
    // а Math.trunc(Infinity) — Infinity в проценте «ПУ».
    const e = buildStatsEntry({ general: [], roles: {}, killcount: [] }, meta);
    expect(e.generalStats.killpercent).toBe(0);
    expect(e.generalStats.gamesCount).toBe(0);
    expect(e.generalStats.winrate).toBe("0.0");
    expect(Object.values(e.roleStats).every((r) => r.winrate === "0.0")).toBe(true);
    // «?» вместо 0: «игр нет» и «не знаем» — разные утверждения.
    expect(e.totalGames).toBe("?");
  });

  test("роль, которой нет в ответе, не выдумывается", () => {
    const e = buildStatsEntry(
      { general: [{ games_count: 10, wins_count: 5 }], roles: { mafia: undefined }, killcount: [] },
      meta,
    );
    expect(e.roleStats.mafia.winrate).toBe("0.0");
  });

  test("fromRating доезжает до записи: по нему решают, перепроверять ли «в игре»", () => {
    expect(buildStatsEntry(payload, { ...meta, fromRating: true }).fromRating).toBe(true);
    expect(buildStatsEntry(payload, meta).fromRating).toBe(false);
  });
});

describe("заглушка «рейтинг недоступен»", () => {
  test("цифр не выдумывает — везде прочерк, а не нули", () => {
    const e = unavailablePlayerStats();
    expect(e.ratingUnavailable).toBe(true);
    expect(e.mmr).toBe("—");
    expect(e.totalGames).toBe("—");
    expect(e.generalStats.winrate).toBe("—");
    expect(Object.values(e.roleStats).every((r) => r.winrate === "—")).toBe(true);
  });

  test("id — прочерк, и он НЕ годится в ключ заметки (блокер 8.1.29)", () => {
    // Ключ u:— собрал бы заметки всех недоступных игроков в одну запись.
    expect(unavailablePlayerStats().id).toBe("—");
  });
});
