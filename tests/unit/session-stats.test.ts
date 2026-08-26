/**
 * «Мой вечер» (просьба владельца 26.08.2026): сессия, её якорь и сводка.
 *
 * Мутационные стражи: перепутанная граница суток рвёт вечер на два в
 * полночь; перепутанный знак дельты врёт про итог; ручной сброс, который
 * не побеждает границу (или побеждает вчерашний), ломает «начать с нуля».
 */
import { describe, expect, test } from "vitest";

import type { GameRow } from "@core/crossover";
import {
  SESSION_DAY_START_HOUR,
  parseGameDate,
  pickSessionGames,
  sessionAnchor,
  summarizeSession,
} from "@core/session-stats";

/** Локальные миллисекунды без парсинга строк — тесты не зависят от TZ раннера. */
const at = (d: number, h: number, mi = 0) => new Date(2026, 7, d, h, mi).getTime();

describe("parseGameDate", () => {
  test("формат сайта «YYYY-MM-DD HH:MM:SS» разбирается как UTC (замер 26.08.2026)", () => {
    // Разбор как локального уводил игры на смещение пояса в прошлое, и
    // «начать заново» терял свежие игры (adversarial №1 по «Моему вечеру»).
    expect(parseGameDate("2026-08-26 21:30:00")).toBe(Date.UTC(2026, 7, 26, 21, 30, 0));
  });
  test("T-разделитель тоже понимается", () => {
    expect(parseGameDate("2026-08-26T04:00:00")).toBe(Date.UTC(2026, 7, 26, 4));
  });
  test("мусор и пустота — null, не Invalid Date", () => {
    expect(parseGameDate("вчера")).toBeNull();
    expect(parseGameDate(undefined)).toBeNull();
    expect(parseGameDate("2026-08-26")).toBeNull();
  });
  test("переполнение полей — null, а не «месяц 19 = следующий год»", () => {
    // Date молча перекатывает переполнение; битой метке место в null, иначе
    // она становилась «будущим» и затаскивала игру в сессию (adversarial №7).
    expect(parseGameDate("2026-19-40 27:70:70")).toBeNull();
    expect(parseGameDate("2026-00-10 10:00:00")).toBeNull();
  });
});

describe("якорь сессии", () => {
  test("вечером якорь — сегодняшние 04:00", () => {
    expect(sessionAnchor(at(26, 20), null)).toBe(at(26, SESSION_DAY_START_HOUR));
  });
  test("за полночь (01:30) вечер НЕ рвётся: якорь — вчерашние 04:00", () => {
    expect(sessionAnchor(at(27, 1, 30), null)).toBe(at(26, SESSION_DAY_START_HOUR));
  });
  test("ровно в 04:00 начинаются новые сутки", () => {
    expect(sessionAnchor(at(27, 4), null)).toBe(at(27, SESSION_DAY_START_HOUR));
  });
  test("ручной сброс позже границы — побеждает («всё с нуля»)", () => {
    expect(sessionAnchor(at(26, 22), at(26, 21))).toBe(at(26, 21));
  });
  test("вчерашний сброс не тащит вчерашние игры в сегодня", () => {
    expect(sessionAnchor(at(27, 20), at(26, 21))).toBe(at(27, SESSION_DAY_START_HOUR));
  });
});

const row = (over: Partial<GameRow> & { id: number }): GameRow => ({
  role: "civilian",
  win: false,
  ...over,
});

/** Метка сайта (UTC) из epoch-миллисекунд — тесты не зависят от TZ раннера. */
const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

describe("игры сессии", () => {
  test("до якоря и без даты — не сессия; свежие первыми", () => {
    const anchor = at(26, 20); // локальный вечерний якорь
    const rows = [
      row({ id: 1, date: utcStamp(anchor - 3600_000) }), // за час до якоря
      row({ id: 3, date: utcStamp(anchor + 2 * 3600_000) }),
      row({ id: 2, date: utcStamp(anchor + 3600_000) }),
      row({ id: 4 }), // даты нет
    ];
    expect(pickSessionGames(rows, anchor).map((r) => r.id)).toEqual([3, 2]);
  });
});

describe("сводка сессии", () => {
  test("дельта суммируется со знаком, победы считаются", () => {
    const s = summarizeSession([
      row({ id: 3, win: true, mmrAfter: 12890, mmrDiff: 56 }),
      row({ id: 2, win: false, mmrAfter: 12834, mmrDiff: -58 }),
      row({ id: 1, win: true, mmrAfter: 12892, mmrDiff: 42 }),
    ]);
    expect(s.games).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.delta).toBe(40);
    // Старт — MMR ДО самой старой рейтинговой игры.
    expect(s.startMmr).toBe(12850);
    // Текущий — после самой свежей.
    expect(s.currentMmr).toBe(12890);
  });

  test("игры без MMR (не лига) видны в счёте, но не в дельте", () => {
    const s = summarizeSession([
      row({ id: 2, win: true }),
      row({ id: 1, win: false, mmrAfter: 100, mmrDiff: -5 }),
    ]);
    expect(s.games).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.delta).toBe(-5);
    expect(s.startMmr).toBe(105);
    expect(s.currentMmr).toBe(100);
  });

  test("пустая сессия — нули и null, не NaN", () => {
    expect(summarizeSession([])).toEqual({
      games: 0,
      wins: 0,
      delta: 0,
      startMmr: null,
      currentMmr: null,
    });
  });
});
