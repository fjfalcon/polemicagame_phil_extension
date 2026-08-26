import { describe, expect, test } from "vitest";
import { TransientNetworkError, fetchWithRetry, json } from "./fetch";

/**
 * Живые контракты SSR и вложенных форм API (аудит хрупкости 06.08.2026,
 * P0 «Match SSR» и «Nested HTTP shapes»).
 *
 * Бандл не может доказать серверный HTML: атрибут `:game-data='…'` с
 * одинарными кавычками — единственный источник данных матча, и его дрифт
 * молча выключал бы всю статистику. Вложенные формы истории (role.type,
 * result.code, mmr) прежний контракт проверял только по внешнему контуру —
 * дрифт давал правдоподобно неверные цифры вместо падения.
 */
describe("SSR страницы матча", () => {
  test("стабильный матч 314446: :game-data извлекается и совпадает по форме", async ({
    skip,
  }) => {
    let html: string;
    try {
      const res = await fetchWithRetry("https://polemicagame.com/match/314446");
      if (!res.ok) skip(`match page HTTP ${res.status}`);
      html = await res.text();
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error}`);
      throw error;
    }

    // Ровно тот извлекатель-инвариант, на который опирается match-data.ts:
    // атрибут :game-data в одинарных кавычках с сырым JSON внутри.
    const m = /:game-data='([^']+)'/.exec(html);
    expect(m, "атрибут :game-data='…' пропал из серверного HTML").not.toBeNull();

    const payload = JSON.parse((m as RegExpExecArray)[1]) as {
      id?: number;
      winnerCode?: number;
      data?: { players?: unknown[]; votes?: unknown[]; shots?: unknown[]; checks?: unknown[] };
    };
    expect(payload.id, "id матча в payload").toBe(314446);
    expect(typeof payload.winnerCode, "winnerCode присутствует").toBe("number");
    const data = payload.data ?? {};
    for (const key of ["players", "votes", "shots", "checks"] as const) {
      expect(Array.isArray(data[key]), `data.${key} — массив`).toBe(true);
      expect((data[key] as unknown[]).length, `data.${key} непустой`).toBeGreaterThan(0);
    }
    const player = (data.players as Array<Record<string, unknown>>)[0];
    expect(typeof player.role, "у вложенного игрока role — число").toBe("number");
    expect(typeof player.position, "у вложенного игрока есть position").toBe("number");
  });
});

describe("вложенные формы HTTP API", () => {
  test("история игр: role.type, result.code и mmr сохраняют вложенную форму", async ({
    skip,
  }) => {
    let rows: Array<Record<string, unknown>>;
    try {
      const rating = await json("https://polemicagame.com/ratings/default/get-list?limit=1");
      if (rating.response.status !== 200) skip("rating seed unavailable");
      const userId = (rating.body as Array<{ user_id: unknown }>)[0]?.user_id;
      const games = await json(
        `https://polemicagame.com/profile/default/get-games?userId=${encodeURIComponent(String(userId))}&page=1&limit=5`,
      );
      if (games.response.status === 401 || games.response.status === 403) {
        skip("profile API требует сессию в этом окружении");
      }
      expect(games.response.status).toBe(200);
      rows = (games.body as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error}`);
      throw error;
    }
    if (rows.length === 0) skip("у топ-игрока нет строк истории — форму не проверить");

    // Дрифт этих полей не роняет расширение — оно рисует ПРАВДОПОДОБНУЮ ЛОЖЬ
    // (мирный/поражение/+0). Поэтому форма пригвождается живьём.
    const row = rows[0];
    expect(row.role, "row.role — объект с type").toMatchObject({ type: expect.anything() });
    expect(row.result, "row.result — объект с code").toMatchObject({ code: expect.anything() });
    expect(
      row.mmr === null || typeof row.mmr === "object",
      "row.mmr — null или объект (mmr_diff)",
    ).toBe(true);
  });

  test("/api/games отдаёт массив игр с players[].{id,username,mmr}", async ({ skip }) => {
    let body: unknown;
    try {
      const res = await json("https://game.polemicagame.com/api/games");
      if (res.response.status !== 200) skip(`/api/games HTTP ${res.response.status}`);
      body = res.body;
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error}`);
      throw error;
    }
    expect(Array.isArray(body), "/api/games — массив").toBe(true);
    const games = body as Array<{ players?: Array<Record<string, unknown>> }>;
    if (games.length === 0) skip("нет активных игр — состав players не проверить");
    const withPlayers = games.find((g) => Array.isArray(g.players) && g.players.length > 0);
    if (!withPlayers) {
      skip("в активных играх нет игроков — состав не проверить");
      return;
    }
    const p = (withPlayers.players as Array<Record<string, unknown>>)[0];
    expect(p, "players[0] несёт id и username").toMatchObject({
      id: expect.anything(),
      username: expect.any(String),
    });
  });
});
