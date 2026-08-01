import { describe, expect, test } from "vitest";

import {
  OWNER_TTL_MS,
  decideSceneOwnership,
  type OwnerTabState,
  type SceneOwnerRecord,
} from "../../src/background/scene-owner";

const NOW = 1_800_000_000_000;
const OWNER = 7;
const OTHER = 9;

function decide(
  current: SceneOwnerRecord | null,
  ownerTab: OwnerTabState | null = { kind: "in-game" },
  opts: { tabId?: number; manual?: boolean; now?: number } = {},
) {
  return decideSceneOwnership({
    current,
    tabId: opts.tabId ?? OTHER,
    manual: opts.manual ?? false,
    now: opts.now ?? NOW,
    ownerTab,
  });
}

const fresh: SceneOwnerRecord = { tabId: OWNER, ts: NOW - 1000 };

describe("владение автосценой OBS", () => {
  test("владельца нет — первая же вкладка забирает сцену", () => {
    expect(decide(null)).toEqual({ allow: true, claim: true, reason: "no-owner" });
  });

  test("одна вкладка играет — она же владелец, отказов быть не может", () => {
    // Самый частый случай: у большинства пользователей вкладка ровно одна.
    expect(decide(fresh, { kind: "in-game" }, { tabId: OWNER })).toEqual({
      allow: true,
      claim: true,
      reason: "same-tab",
    });
  });

  test("вторая вкладка не перебивает сцену активной трансляции", () => {
    // Ради этого владение и вводилось: чужая игра, открытая посмотреть,
    // переключала сцену стримеру посреди эфира.
    expect(decide(fresh, { kind: "in-game" })).toEqual({
      allow: false,
      claim: false,
      reason: "owner-alive",
    });
  });

  test("ручной клик в панели проходит всегда и забирает владение", () => {
    expect(decide(fresh, { kind: "in-game" }, { manual: true })).toEqual({
      allow: true,
      claim: true,
      reason: "manual",
    });
  });

  test("вкладку владельца закрыли — владение свободно сразу", () => {
    expect(decide(fresh, { kind: "gone" })).toEqual({
      allow: true,
      claim: true,
      reason: "owner-gone",
    });
  });

  test("владелец жив, но ушёл со страницы игры — владение переходит", () => {
    // Человек закрыл матч и открыл в той же вкладке что-то другое. Раньше эта
    // вкладка держала сцену ещё до 20 минут, и автосмена в настоящей игровой
    // вкладке всё это время молча не работала (жалоба 02.08.2026).
    expect(decide(fresh, { kind: "left-game" })).toEqual({
      allow: true,
      claim: true,
      reason: "owner-left-game",
    });
  });

  test("владелец молчит дольше TTL — вкладку даже не опрашиваем", () => {
    const stale: SceneOwnerRecord = { tabId: OWNER, ts: NOW - OWNER_TTL_MS - 1 };
    expect(decide(stale, { kind: "in-game" })).toEqual({
      allow: true,
      claim: true,
      reason: "owner-stale",
    });
  });

  test("на границе TTL владение ещё за прежней вкладкой", () => {
    const edge: SceneOwnerRecord = { tabId: OWNER, ts: NOW - OWNER_TTL_MS };
    expect(decide(edge, { kind: "in-game" }).allow).toBe(false);
  });

  test.each([
    ["запись без времени", { tabId: OWNER } as SceneOwnerRecord],
    ["запись без вкладки", { ts: NOW } as SceneOwnerRecord],
    ["мусор вместо записи", { tabId: "7" } as unknown as SceneOwnerRecord],
  ])("битое владение (%s) не блокирует автоматику", (_name, record) => {
    expect(decide(record, { kind: "in-game" }).allow).toBe(true);
  });

  test("F5 в игровой вкладке не отнимает у неё владение", () => {
    // id вкладки переживает перезагрузку страницы — владелец тот же.
    expect(decide(fresh, { kind: "in-game" }, { tabId: OWNER }).allow).toBe(true);
  });

  test("владельца не спрашивали — сцену не раздаём", () => {
    // null означает «решение принято раньше, ответа нет». Заглушка «свободно»
    // на этом месте молча раздавала бы владение при любой перестановке
    // проверок внутри функции (ревью 02.08.2026).
    expect(decide(fresh, null)).toEqual({ allow: false, claim: false, reason: "owner-alive" });
  });

  test("после перехвата владения прежний владелец получает отказ", () => {
    // Проверяем полный цикл: вторая вкладка забрала сцену (владелец ушёл с
    // игры), и теперь уже ПЕРВАЯ не должна перебивать её вслепую.
    const afterClaim: SceneOwnerRecord = { tabId: OTHER, ts: NOW };
    expect(decide(afterClaim, { kind: "in-game" }, { tabId: OWNER }).allow).toBe(false);
  });
});
