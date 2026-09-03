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
  test("таймлайн фикстуры: ДЕНЬ ИДЁТ ПЕРЕД НОЧЬЮ того же номера", () => {
    // НЕЗАВИСИМОЕ обоснование (не прогон кода — первый вариант теста был
    // циркулярным и закрепил сдвиг на день, adversarial 03.09.2026, Н1):
    // жертва ночи k ещё ГОЛОСУЕТ днём k — №2 голосует в дне 1 и убит в
    // ночь 1, №8 голосует в дне 2, №5 — в дне 3, №4 — в дне 4. Контроль:
    // в дне 4 ровно 5 голосующих = 10 − 3 убийства − двое выбывших (9 в
    // дне 2, 6 в дне 3). Значит перед ночью k учтены дни 1..k:
    // живых по ночам — 10, 8, 6, 4.
    const d = JSON.parse(readFileSync("legacy/match_314446.json", "utf8"));
    const night1victimVotesDay1 = (d.data.votes as Array<{ day: number; voter: number }>).some(
      (v) => v.day === 1 && v.voter === 2,
    );
    expect(night1victimVotesDay1, "хронология: жертва ночи 1 голосует днём 1").toBe(true);
    const nights = analyzeMafiaShots(d.data);
    expect(nights.map((n) => n.night)).toEqual([1, 2, 3, 4]);
    expect(nights.map((n) => n.alive)).toEqual([10, 8, 6, 4]);
    expect(nights.every((n) => !n.missed), "в этой игре промахов не было").toBe(true);
    expect(nights.map((n) => n.victim)).toEqual([2, 8, 5, 4]);
  });

  test("выбывший в ПЕРВЫЙ день учтён уже в ночи 1 (граница day >= 1)", () => {
    // num: 1 — тур голосования (num 0 — выставления, исход дня не решают).
    const votes = [
      { day: 1, num: 1, voter: 1, candidate: 4 },
      { day: 1, num: 1, voter: 2, candidate: 4 },
      { day: 1, num: 1, voter: 3, candidate: 4 },
    ];
    const [n1] = analyzeMafiaShots({ players: tenPlayers, votes, shots: [shot(1, 2, 7)] });
    expect(n1.alive, "день 1 унёс одного ДО ночи 1").toBe(9);
  });

  test("Н4: дубль записи одного стрелка не искажает большинство и вину", () => {
    // (5→7)×2 + (10→3): по записям это 2:1 и виновен только 10, а по
    // правилу «один стрелок — один голос» это 1-1 — виновны ОБА.
    const [n] = analyzeMafiaShots({
      players: tenPlayers,
      shots: [shot(2, 5, 7), shot(2, 5, 7), shot(2, 10, 3)],
    });
    expect(n.shots, "у стрелка один голос").toHaveLength(2);
    expect(n.blamed.sort()).toEqual([10, 5].sort());
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
