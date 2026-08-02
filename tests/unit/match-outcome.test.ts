import { describe, expect, test } from "vitest";

import match314446 from "../../legacy/match_314446.json";
import match598995 from "../../docs/fixtures/match_598995.json";
import match610180 from "../../docs/fixtures/match_610180.json";
import { actionTip, isLiftBallot, resolveDayOutcome, type MatchVote } from "@content/match-outcome";

/**
 * Исход дня — единственное место, где расширение делает ВЫВОД о матче, а не
 * пересказывает данные сайта. Ошибка здесь означает, что мы показали игроку
 * неправду о его игре, и заметить это по интерфейсу почти невозможно.
 *
 * Ожидания ниже НЕ выдуманы: они сняты с трёх настоящих матчей, а день 4
 * матча 598995 владелец сверял руками с сайтом (ничья 3:3 → «попил» → ушли
 * ДВОЕ). Именно он и задаёт правило про массив, а не одного игрока.
 */
const votesOf = (m: unknown): MatchVote[] => (m as { data: { votes: MatchVote[] } }).data.votes;

describe("isLiftBallot", () => {
  test("бюллетень «поднимаем всех?» — запись БЕЗ поля num", () => {
    expect(isLiftBallot({ day: 1, candidate: 1 })).toBe(true);
    expect(isLiftBallot({ day: 1, num: null, candidate: 1 })).toBe(true);
  });

  test("тур выставления (num 0) бюллетенем НЕ считается", () => {
    // Проверка на ложность (`!vote.num`) сложила бы выставление с бюллетенем:
    // у выставления num === 0. Это меняло бы исход каждого дня.
    expect(isLiftBallot({ day: 1, num: 0, candidate: 3 })).toBe(false);
  });

  test.each([1, 2])("тур голосования (num %d) — не бюллетень", (num) => {
    expect(isLiftBallot({ day: 1, num, candidate: 3 })).toBe(false);
  });
});

describe("resolveDayOutcome на реальных матчах", () => {
  test.each([
    // [матч, день, финальный тур, кто ушёл]
    ["314446", votesOf(match314446), 1, 0, []],
    ["314446", votesOf(match314446), 2, 2, [9]],
    ["314446", votesOf(match314446), 3, 1, [6]],
    ["314446", votesOf(match314446), 4, 1, [1]],
    ["314446", votesOf(match314446), 5, 1, [7]],
    ["598995", votesOf(match598995), 1, 0, []],
    ["598995", votesOf(match598995), 2, 1, [8]],
    ["598995", votesOf(match598995), 3, 1, [2]],
    // День, сверенный владельцем вручную: ничья 3:3 в подъёме, бюллетень «за»
    // → стол покидают ОБА кандидата.
    ["598995", votesOf(match598995), 4, 2, [5, 4]],
    ["598995", votesOf(match598995), 5, 1, [3]],
    ["610180", votesOf(match610180), 1, 0, []],
    ["610180", votesOf(match610180), 2, 1, [3]],
    ["610180", votesOf(match610180), 3, 1, [8]],
    ["610180", votesOf(match610180), 4, 1, [9]],
  ] as const)("матч %s, день %d: финальный тур %d, ушли %j", (_m, votes, day, finalNum, departed) => {
    const outcome = resolveDayOutcome(votes as MatchVote[], day);
    expect(outcome.finalNum).toBe(finalNum);
    expect(outcome.departed).toEqual(departed);
  });

  test("день выставления никого не уводит со стола", () => {
    // Первый день матча 314446: три кандидатуры по одному голосу. Это
    // ЗАЯВКИ в речах, а не голосование — уход отсюда был бы выдумкой.
    const outcome = resolveDayOutcome(votesOf(match314446), 1);
    expect(outcome.finalNum).toBe(0);
    expect(outcome.tied).toBe(true);
    expect(outcome.departed).toEqual([]);
  });
});

describe("resolveDayOutcome: ничья и бюллетень", () => {
  const tie: MatchVote[] = [
    { day: 3, num: 2, voter: 1, candidate: 4 },
    { day: 3, num: 2, voter: 2, candidate: 4 },
    { day: 3, num: 2, voter: 3, candidate: 5 },
    { day: 3, num: 2, voter: 4, candidate: 5 },
  ];

  test("бюллетень «за» большинством — уходят ВСЕ ничейные", () => {
    const ballot: MatchVote[] = [
      { day: 3, voter: 1, candidate: 1 },
      { day: 3, voter: 2, candidate: 1 },
      { day: 3, voter: 3, candidate: 0 },
    ];
    expect(resolveDayOutcome([...tie, ...ballot], 3).departed).toEqual([4, 5]);
  });

  test("бюллетень «против» — за столом остаются все", () => {
    const ballot: MatchVote[] = [
      { day: 3, voter: 1, candidate: 0 },
      { day: 3, voter: 2, candidate: 0 },
      { day: 3, voter: 3, candidate: 1 },
    ];
    expect(resolveDayOutcome([...tie, ...ballot], 3).departed).toEqual([]);
  });

  test("поровну «за» и «против» — никто не уходит", () => {
    // Правило подтверждено владельцем: «если нет или поровну — начинается
    // ночь и все остаются за столом». СТРОГОЕ большинство, а не >=.
    const ballot: MatchVote[] = [
      { day: 3, voter: 1, candidate: 1 },
      { day: 3, voter: 2, candidate: 0 },
    ];
    expect(resolveDayOutcome([...tie, ...ballot], 3).departed).toEqual([]);
  });

  test("бюллетеня нет вовсе — допущение «попил состоялся»", () => {
    // Осознанное допущение для матчей старого формата: маркер «против» в
    // данных не встречался.
    expect(resolveDayOutcome(tie, 3).departed).toEqual([4, 5]);
  });

  test("ничья в ПЕРВОМ туре голосования уходом не заканчивается", () => {
    // Ничья на num 1 переводит день в подъём (num 2), а не уводит со стола.
    const firstRoundTie: MatchVote[] = [
      { day: 2, num: 1, voter: 1, candidate: 4 },
      { day: 2, num: 1, voter: 2, candidate: 5 },
    ];
    const outcome = resolveDayOutcome(firstRoundTie, 2);
    expect(outcome.tied).toBe(true);
    expect(outcome.departed).toEqual([]);
  });
});

describe("resolveDayOutcome: пустые и вырожденные входы", () => {
  test("голосов за день нет — пустой исход, без падения", () => {
    const outcome = resolveDayOutcome([], 1);
    expect(outcome).toEqual({ finalNum: 0, counts: [], tied: false, departed: [] });
  });

  test("голоса других дней не учитываются", () => {
    const votes: MatchVote[] = [
      { day: 1, num: 1, voter: 1, candidate: 7 },
      { day: 2, num: 1, voter: 1, candidate: 9 },
    ];
    expect(resolveDayOutcome(votes, 2).departed).toEqual([9]);
  });

  test("единственный кандидат финального тура уходит", () => {
    const votes: MatchVote[] = [{ day: 4, num: 1, voter: 1, candidate: 6 }];
    expect(resolveDayOutcome(votes, 4).departed).toEqual([6]);
  });

  test("считается ТОЛЬКО финальный тур, а не сумма всех", () => {
    // Иначе проигравший в первом туре мог бы «победить» по сумме и уйти
    // вместо настоящего кандидата.
    const votes: MatchVote[] = [
      { day: 2, num: 1, voter: 1, candidate: 3 },
      { day: 2, num: 1, voter: 2, candidate: 3 },
      { day: 2, num: 1, voter: 3, candidate: 3 },
      { day: 2, num: 2, voter: 1, candidate: 8 },
    ];
    const outcome = resolveDayOutcome(votes, 2);
    expect(outcome.finalNum).toBe(2);
    expect(outcome.departed).toEqual([8]);
  });
});

describe("actionTip — подписи ночных действий", () => {
  test.each([
    ["kill", "Выстрел мафии → №2"],
    ["check", "Проверка шерифа → №2"],
    ["don_check", "Проверка дона → №2"],
    ["vote", "Голос → №2"],
    ["что-то новое", "Действие → №2"],
  ])("%s", (type, expected) => {
    expect(actionTip(type, 2)).toBe(expected);
  });
});
