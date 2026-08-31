// @vitest-environment node
/**
 * Анализ ночной стрельбы мафии (значок «пистолет» в разборе, 31.08.2026).
 *
 * Правило вины — дословно от владельца: «если двое стреляли в одного, а
 * игрок промахнулся — значок ему. Если за столом двое чёрных — промах
 * обоим. Если все трое промазали — всем промах». Формализация: виновен
 * уведший от большинства; нет большинства — виновны все стрелявшие.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { analyzeMafiaShots } from "@content/mafia-shots";

const shot = (night: number, shooter: number, victim: number) => ({ night, shooter, victim });
const tenPlayers = Array.from({ length: 10 }, (_, i) => ({ position: i + 1 }));

describe("правило вины владельца", () => {
  test("двое в одного, третий увёл — виновен только уведший", () => {
    const [n] = analyzeMafiaShots({
      players: tenPlayers,
      shots: [shot(1, 2, 7), shot(1, 5, 7), shot(1, 10, 3)],
    });
    expect(n.missed).toBe(true);
    expect(n.blamed).toEqual([10]);
    expect(n.victim, "промах — никто не умер").toBeNull();
  });

  test("двое чёрных врозь (1-1) — виновны оба", () => {
    const [n] = analyzeMafiaShots({
      players: tenPlayers,
      shots: [shot(2, 5, 7), shot(2, 10, 3)],
    });
    expect(n.missed).toBe(true);
    expect(n.blamed.sort()).toEqual([10, 5].sort());
  });

  test("все трое врозь (1-1-1) — виновны все", () => {
    const [n] = analyzeMafiaShots({
      players: tenPlayers,
      shots: [shot(1, 2, 3), shot(1, 5, 7), shot(1, 10, 9)],
    });
    expect(n.blamed.sort()).toEqual([2, 5, 10].sort());
  });

  test("сведённая стрельба — не промах, виновных нет", () => {
    const [n] = analyzeMafiaShots({
      players: tenPlayers,
      shots: [shot(1, 2, 7), shot(1, 5, 7), shot(1, 10, 7)],
    });
    expect(n.missed).toBe(false);
    expect(n.blamed).toEqual([]);
    expect(n.victim).toBe(7);
  });

  test("один стрелявший всегда сведён", () => {
    const [n] = analyzeMafiaShots({ players: tenPlayers, shots: [shot(4, 10, 4)] });
    expect(n.missed).toBe(false);
  });
});

describe("«в скольких»: живые на момент ночи (реальный матч)", () => {
  test("таймлайн фикстуры: убийства ночей + выбывшие голосованиями", () => {
    // legacy/match_314446.json: ночи 1-4 сведены (жертвы 2, 8, 5, 4);
    // дни: 1 — ничья (никто), 2 — ушёл 9, 3 — ушёл 6 (сверено прогоном
    // resolveDayOutcome при написании теста). Живых: 10, 9, 7, 5.
    const d = JSON.parse(readFileSync("legacy/match_314446.json", "utf8"));
    const nights = analyzeMafiaShots(d.data);
    expect(nights.map((n) => n.night)).toEqual([1, 2, 3, 4]);
    expect(nights.map((n) => n.alive)).toEqual([10, 9, 7, 5]);
    expect(nights.every((n) => !n.missed), "в этой игре промахов не было").toBe(true);
    expect(nights.map((n) => n.victim)).toEqual([2, 8, 5, 4]);
  });

  test("мусор в shots не роняет и не считается", () => {
    const nights = analyzeMafiaShots({
      players: tenPlayers,
      shots: [shot(1, 2, 7), { night: "x", shooter: 5 }, null, shot(1, 5, 7)],
    } as never);
    expect(nights).toHaveLength(1);
    expect(nights[0].shots).toHaveLength(2);
  });
});
