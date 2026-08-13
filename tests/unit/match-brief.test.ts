// @vitest-environment jsdom
/**
 * Первый убитый («ПУ») из разбора матча.
 *
 * Фича делает УТВЕРЖДЕНИЕ о человеке — «в той игре его убили первым», — и
 * цена ошибки тут выше, чем польза от пометки. Поэтому сторожим прежде всего
 * границу между «знаем» и «не знаем», и только потом экономию запросов.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  CACHE_LIMIT,
  fetchFirstKilled,
  parseFirstKilled,
  resetMatchBriefCache,
} from "@core/match-brief";

/** Страница матча в том виде, в каком её отдаёт сайт (проверено живьём). */
const page = (body: string): string =>
  `<!doctype html><html><body><div id="app"><Gamestats :game-data='${body}'></Gamestats></div></body></html>`;

const data = (firstKilled: string, extra = ""): string =>
  `{"id": 618850, "winnerCode": 1${extra}, "firstKilled": ${firstKilled}, "bestPlayer": {"id": 45931}}`;

beforeEach(() => {
  resetMatchBriefCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("разбор страницы матча", () => {
  test("достаёт id первого убитого", () => {
    expect(parseFirstKilled(page(data("65012")))).toBe(65012);
  });

  test("кавычки-энтити понимаются так же", () => {
    // Сайт отдаёт payload то в чистом JSON, то с &quot; — разбор обязан
    // пережить обе формы (тот же урок, что у match-data).
    const html = page(data("65012")).replace(/"/g, "&quot;");
    expect(parseFirstKilled(html)).toBe(65012);
  });

  test("первого убитого в матче не было — это НЕ «не знаем»", () => {
    // null в данных = игра кончилась без ночного отстрела. Такой матч
    // разобран, и повторно спрашивать про него незачем.
    expect(parseFirstKilled(page(data("null")))).toBeNull();
  });

  test("чужая или сломанная страница — undefined, а не догадка", () => {
    expect(parseFirstKilled("<html><body>Ошибка 500</body></html>")).toBeUndefined();
    expect(parseFirstKilled(page('{"id": 1}'))).toBeUndefined();
  });

  test("не путает соседнее поле с нужным", () => {
    // В payload есть и bestPlayer, и players — «первое число рядом» брать
    // нельзя: пометка уехала бы не на того игрока.
    const html = page(data("65012", ', "players": [{"id": 43206}, {"id": 71659}]'));
    expect(parseFirstKilled(html)).toBe(65012);
  });
});

describe("запрос и кэш", () => {
  function serve(html: string, ok = true): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () => ({ ok, status: ok ? 200 : 500, text: async () => html }));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  test("разобранный матч больше не запрашивается", async () => {
    // Результат сыгранного матча не меняется — второй запрос был бы платой
    // ни за что (а платим мы запросом на каждую игру в окне).
    const mock = serve(page(data("65012")));
    expect(await fetchFirstKilled(618850)).toBe(65012);
    expect(await fetchFirstKilled(618850)).toBe(65012);
    expect(mock.mock.calls.length).toBe(1);
  });

  test("одну игру у двух игроков спрашиваем один раз", async () => {
    // За столом у соседей общие последние игры — типичный случай.
    const mock = serve(page(data("65012")));
    const [a, b] = await Promise.all([fetchFirstKilled(618850), fetchFirstKilled(618850)]);
    expect([a, b]).toEqual([65012, 65012]);
    expect(mock.mock.calls.length, "второй запрос присоединяется к первому").toBe(1);
  });

  test("неудачу сети НЕ кэшируем", async () => {
    // Иначе одна сетевая икота убирала бы ПУ у игрока до конца сессии.
    const failing = serve("", false);
    expect(await fetchFirstKilled(1)).toBeUndefined();
    expect(failing.mock.calls.length).toBe(1);

    serve(page(data("77")));
    expect(await fetchFirstKilled(1), "следующая попытка обязана пойти в сеть").toBe(77);
  });

  test("НЕРАЗОБРАННУЮ страницу тоже не кэшируем", async () => {
    // Ответ 200, но разметка не та (сайт перерисовал страницу, отдал заглушку
    // или капчу). Запомнить такое как «первого убитого нет» значило бы врать
    // до конца сессии — и молча, потому что 200 выглядит как успех.
    serve("<html><body>ой</body></html>");
    expect(await fetchFirstKilled(2)).toBeUndefined();

    const good = serve(page(data("31")));
    expect(await fetchFirstKilled(2)).toBe(31);
    expect(good.mock.calls.length).toBe(1);
  });

  test("кэш не растёт бесконечно", async () => {
    serve(page(data("5")));
    for (let i = 1; i <= CACHE_LIMIT + 5; i++) await fetchFirstKilled(i);
    const mock = serve(page(data("5")));
    // Самые старые вытеснены — за ними придётся сходить снова.
    expect(await fetchFirstKilled(1)).toBe(5);
    expect(mock.mock.calls.length, "первый матч вытеснен из кэша").toBe(1);
    // А недавние на месте.
    await fetchFirstKilled(CACHE_LIMIT + 5);
    expect(mock.mock.calls.length, "недавний матч всё ещё в кэше").toBe(1);
  });
});
