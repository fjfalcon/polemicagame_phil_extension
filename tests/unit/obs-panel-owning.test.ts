// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), safeClick: vi.fn(), isVisible: () => true }));
vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() } }, runtime: { id: "x" } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({ onMessage: vi.fn(), sendRuntime: vi.fn() }));

import { drivesAutoScene } from "@content/panels/obs-panel";

const running = {
  autoModeOn: true,
  pathname: "/game",
  phaseKnown: true,
  phaseSeenLive: true,
  pregameVisible: false,
  matchFinished: false,
};

describe("ведёт ли вкладка автосцену (ответ на пинг владения)", () => {
  test("идущий матч с включённым авто-режимом — ведём", () => {
    expect(drivesAutoScene(running)).toBe(true);
  });

  test("матч доигран — владение отдаём", () => {
    // Самый частый бытовой случай: доиграл, вкладку не закрыл, следующая игра
    // в новой вкладке. Раньше эта вкладка держала сцену до 20 минут.
    expect(drivesAutoScene({ ...running, matchFinished: true })).toBe(false);
  });

  test("авто-режим выключен — не ведём", () => {
    expect(drivesAutoScene({ ...running, autoModeOn: false })).toBe(false);
  });

  test.each(["/game-search", "/", "/profile/13509"])("ушли на %s — не ведём", (pathname) => {
    expect(drivesAutoScene({ ...running, pathname })).toBe(false);
  });

  test("фазу в этой вкладке ещё ни разу не определяли — не ведём", () => {
    // Вкладка только открылась: сцену она пока не переключала, и держать
    // владение ей не за что.
    expect(drivesAutoScene({ ...running, phaseKnown: false })).toBe(false);
  });

  test("виден экран набора игроков — матч не идёт, не ведём", () => {
    // Прямой сигнал для «та же комната, новая игра» (лог 05.08.2026):
    // .new-stage сайт рисует ровно при voting_for_game_start — владение
    // отдаётся сразу, не дожидаясь протухания по непониманию.
    expect(drivesAutoScene({ ...running, pregameVisible: true })).toBe(false);
  });

  test("фаза лишь ВОССТАНОВЛЕНА из общего storage — не ведём", () => {
    // Жалоба 04.08.2026: restorePersistedAutoState читает obs_auto_scene_state,
    // записанный ДРУГОЙ вкладкой в ПРОШЛОЙ игре, — currentTimeOfDay становится
    // непустым без единой живой детекции. Такая вкладка отвечала «автосцену
    // веду я» и весь вечер блокировала смену ночей у живого матча
    // (owner=…220 в логе — ни одной строки «фаза подтверждена»).
    expect(drivesAutoScene({ ...running, phaseSeenLive: false })).toBe(false);
  });
});
