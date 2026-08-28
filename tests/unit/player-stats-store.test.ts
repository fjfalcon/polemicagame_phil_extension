/**
 * Кэш статистики игрока: TTL, дедуп, бэкофф и гейт живости.
 *
 * Слой выделили ради «пяти карт состояния», а тестами закрыли только чистую
 * сборку цифр — то есть ровно то, что и раньше было чистой функцией
 * (adversarial 28.08.2026). Здесь проверяется сама механика.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  games: [] as unknown[],
  gamesFails: false,
  rating: [] as Array<{ username?: string; user_id: number | string }>,
  profileCalls: 0,
  profileFails: false,
}));

vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/polemica-api", () => ({
  ACTIVE_GAMES_TTL_MS: 15_000,
  fetchActiveGames: vi.fn(async () => {
    if (h.gamesFails) throw new Error("сеть");
    return h.games;
  }),
  findRatingPlayer: vi.fn(async (username: string) =>
    h.rating.find((p) => p.username?.toLowerCase() === username.toLowerCase()),
  ),
}));

import { PlayerStatsStore, STATS_ERROR_BACKOFF_MS, STATS_TTL_MS } from "@content/features/player-notes/player-stats";

/** Профильные ответы: три запроса на игрока. */
function serveProfile(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      h.profileCalls++;
      if (h.profileFails) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        json: async () => [{ games_count: 10, wins_count: 5, first_killed_count: 1 }],
      };
    }),
  );
}

function make(alive = { v: true }, enabled = { v: true }) {
  const loaded: string[] = [];
  const store = new PlayerStatsStore({
    isActive: () => alive.v,
    isEnabled: () => enabled.v,
    onLoaded: (u) => loaded.push(u),
  });
  return { store, loaded };
}

beforeEach(() => {
  h.games = [];
  h.gamesFails = false;
  h.rating = [{ username: "Аня", user_id: 42 }];
  h.profileCalls = 0;
  h.profileFails = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 28, 20, 0, 0));
  serveProfile();
  vi.clearAllMocks();
});

describe("кэш и дедуп", () => {
  test("второе наведение в пределах TTL сети не касается", async () => {
    const { store } = make();
    await store.load("Аня");
    const after = h.profileCalls;
    expect(after).toBeGreaterThan(0);
    await store.load("Аня");
    expect(h.profileCalls, "повторный запрос не ушёл").toBe(after);
  });

  test("после TTL данные перезапрашиваются: MMR за вечер меняется", async () => {
    const { store } = make();
    await store.load("Аня");
    const after = h.profileCalls;
    vi.setSystemTime(new Date(Date.now() + STATS_TTL_MS + 1000));
    await store.load("Аня");
    expect(h.profileCalls).toBeGreaterThan(after);
  });

  test("две плитки одного игрока не гонят два запроса", async () => {
    // Дедуп по ключу: пересборка плитки при мутациях DOM иначе дублировала
    // три профильных запроса (аудит 01.08.2026, находка 7).
    const { store } = make();
    await Promise.all([store.load("Аня"), store.load("аня"), store.load("АНЯ")]);
    expect(h.profileCalls).toBe(3); // ровно один заход = три профильных ответа
  });
});

describe("бэкофф после ошибки", () => {
  test("упавший API не долбится на каждый hover", async () => {
    h.profileFails = true;
    const { store } = make();
    await store.load("Аня");
    const afterFail = h.profileCalls;
    await store.load("Аня");
    expect(h.profileCalls, "повтор заблокирован бэкоффом").toBe(afterFail);
  });

  test("после паузы попытка повторяется", async () => {
    h.profileFails = true;
    const { store } = make();
    await store.load("Аня");
    const afterFail = h.profileCalls;
    h.profileFails = false;
    vi.setSystemTime(new Date(Date.now() + STATS_ERROR_BACKOFF_MS + 1000));
    await store.load("Аня");
    expect(h.profileCalls).toBeGreaterThan(afterFail);
  });
});

describe("гейты", () => {
  test("выключенная настройка не ходит в сеть вовсе", async () => {
    const { store } = make({ v: true }, { v: false });
    await store.load("Аня");
    expect(h.profileCalls).toBe(0);
  });

  test("мёртвая фича не пишет в кэш и не зовёт перерисовку", async () => {
    const alive = { v: true };
    const { store, loaded } = make(alive);
    const p = store.load("Аня");
    alive.v = false; // фичу выключили, пока ехали ответы
    await p;
    expect(loaded, "перерисовку мёртвой фичи не заказываем").toEqual([]);
    expect(store.get("Аня"), "в кэш мёртвой жизни не пишем").toBeUndefined();
  });

  test("игрока нет в рейтинге — запись «данных нет», а не выдуманные нули", async () => {
    h.rating = [];
    const { store, loaded } = make();
    await store.load("Некто");
    expect(store.get("Некто")?.ratingUnavailable).toBe(true);
    expect(store.get("Некто")?.mmr).toBe("—");
    expect(loaded, "тултипы всё равно обновляем: заглушка тоже ответ").toEqual(["Некто"]);
  });
});

describe("сброс", () => {
  test("reset() чистит и кэш, и бэкофф", async () => {
    h.profileFails = true;
    const { store } = make();
    await store.load("Аня");
    store.reset();
    h.profileFails = false;
    const before = h.profileCalls;
    await store.load("Аня");
    expect(h.profileCalls, "бэкофф сброшен вместе с кэшем").toBeGreaterThan(before);
    expect(store.get("Аня")).toBeDefined();
  });

  test("idOf отдаёт id для резолва ключа заметки", async () => {
    const { store } = make();
    await store.load("Аня");
    expect(store.idOf("аня")).toBe(42);
  });
});
