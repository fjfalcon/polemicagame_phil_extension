// @vitest-environment jsdom
/**
 * Статистика пересечений.
 *
 * Фича утверждает факты о конкретном человеке («он был мафией 5 раз из 12»),
 * поэтому проверяем прежде всего то, чем она может НАВРАТЬ: спутать команды,
 * посчитать чужую победу за свою, выдать обрезанную историю за полную.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } } },
}));

import {
  RECENT_LIMIT,
  crossGames,
  isBlackRole,
  parseGameRows,
  type GameRow,
} from "@core/crossover";
import { ownIdFromHref, readOwnIdFromDom } from "@core/own-user";

const g = (id: number, role: string, win: boolean): GameRow => ({ id, role, win });

describe("счёт пересечений", () => {
  test("считает только ОБЩИЕ игры", () => {
    const mine = [g(1, "civilian", true), g(2, "mafia", false), g(3, "sheriff", true)];
    const theirs = [g(2, "civilian", true), g(3, "don", false), g(9, "mafia", true)];
    const x = crossGames(mine, theirs);
    expect(x.together, "игры 1 и 9 общими не являются").toBe(2);
  });

  test("команды считаются по цвету роли, а не по совпадению названия", () => {
    // Шериф с мирным — одна команда; мафия с доном — тоже. Наивное сравнение
    // строк дало бы «разные команды» в обоих случаях.
    const x = crossGames(
      [g(1, "sheriff", true), g(2, "mafia", true)],
      [g(1, "civilian", true), g(2, "don", true)],
    );
    expect(x.sameTeam).toBe(2);

    const y = crossGames([g(1, "sheriff", true)], [g(1, "don", false)]);
    expect(y.sameTeam).toBe(0);
  });

  test("чёрные роли: дон тоже чёрный", () => {
    expect(isBlackRole("mafia")).toBe(true);
    expect(isBlackRole("don")).toBe(true);
    expect(isBlackRole("sheriff"), "шериф — красный").toBe(false);
    expect(isBlackRole("civilian")).toBe(false);
  });

  test("победы считаются МОИ, а не его", () => {
    // В общей игре роли разные: победил он — не я.
    const x = crossGames([g(1, "civilian", false)], [g(1, "mafia", true)]);
    expect(x.myWins).toBe(0);
    expect(x.theirBlack).toBe(1);
  });

  test("последние общие игры — свежие первыми и не длиннее предела", () => {
    // На порядок выдачи сайта не полагаемся: сортируем по номеру матча.
    const mine = Array.from({ length: 9 }, (_, i) => g(i + 1, "civilian", true));
    const theirs = Array.from({ length: 9 }, (_, i) => g(i + 1, "mafia", false));
    const x = crossGames(mine, theirs);
    expect(x.recent).toHaveLength(RECENT_LIMIT);
    expect(x.recent[0].id).toBe(9);
    expect(x.recent.map(r => r.id)).toEqual([9, 8, 7, 6, 5]);
  });

  test("обрезанная история помечается честно", () => {
    // «Вместе 3 игры» и «3 за последние 200 его игр» — разные утверждения.
    expect(crossGames([g(1, "civilian", true)], [g(1, "mafia", false)], true).capped).toBe(true);
    expect(crossGames([], []).capped).toBe(false);
  });
});

describe("разбор ответа истории игр", () => {
  test("живой формат сайта читается", () => {
    // Форма снята с настоящего ответа 09.08.2026.
    const parsed = parseGameRows({
      totalCount: 373,
      rows: [
        {
          id: 617158,
          role: { type: "civilian", title: "Мирный" },
          result: { title: "Победа", code: "success" },
          date_start: "2026-08-09 13:25:20",
          mmr: { mmr_diff: 36 },
        },
      ],
    });
    expect(parsed?.rows[0]).toEqual({
      id: 617158,
      role: "civilian",
      win: true,
      date: "2026-08-09 13:25:20",
    });
    expect(parsed?.total).toBe(373);
  });

  test("поражение — это НЕ победа", () => {
    const parsed = parseGameRows({ rows: [{ id: 1, role: { type: "mafia" }, result: { code: "fail" } }] });
    expect(parsed?.rows[0].win).toBe(false);
  });

  test("мусор вместо ответа не роняет и не превращается в игры", () => {
    expect(parseGameRows(null)).toBeNull();
    expect(parseGameRows({ rows: "нет" })).toBeNull();
    // Строки без номера матча пересекать не с чем — выкидываем.
    expect(parseGameRows({ rows: [{ role: { type: "mafia" } }, { id: 0 }] })?.rows).toEqual([]);
  });
});

describe("свой id", () => {
  test("читается из ссылки профиля в шапке", () => {
    document.body.innerHTML = `
      <div class="p-header__userCont">
        <div class="p-header__userCont-dropdown"><a href="/profile/13509">Профиль</a></div>
      </div>`;
    expect(readOwnIdFromDom(document)).toBe(13509);
  });

  test("чужие ссылки на профили за свой id не принимаются", () => {
    // На странице разбора матча ссылок на профили много — своя только в шапке.
    document.body.innerHTML = `<main><a href="/profile/999">Игрок</a></main>`;
    expect(readOwnIdFromDom(document)).toBeNull();
  });

  test("мусорный адрес не превращается в id", () => {
    expect(ownIdFromHref("/profile/abc")).toBeNull();
    expect(ownIdFromHref("/profile/")).toBeNull();
    expect(ownIdFromHref(null)).toBeNull();
    expect(ownIdFromHref("/profile/13509?tab=games")).toBe(13509);
  });
});
