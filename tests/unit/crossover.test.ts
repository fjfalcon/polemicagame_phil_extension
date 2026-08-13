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
  MAX_PAGES,
  PAGE_SIZE,
  RECENT_LIMIT,
  crossGames,
  fetchHistory,
  isBlackRole,
  oldestDate,
  parseGameRows,
  type GameRow,
} from "@core/crossover";
import { ownIdFromHref, ownNameFromTable, readOwnIdFromDom } from "@core/own-user";

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
    expect(x.sameTeam.games).toBe(2);
    expect(x.sameRed.games, "шериф+мирный — оба красные").toBe(1);
    expect(x.sameBlack.games, "мафия+дон — оба чёрные").toBe(1);

    const y = crossGames([g(1, "sheriff", true)], [g(1, "don", false)]);
    expect(y.sameTeam.games).toBe(0);
    expect(y.versusMyRed.games, "я красный против чёрного").toBe(1);
  });

  test("разрезы складываются в целое — иначе сводка врёт сама себе", () => {
    // Именно так читают такую таблицу: одноцвет + разноцвет = все игры, а
    // подстроки складываются в свою строку. Расхождение сразу видно глазом.
    const mine = [g(1, "civilian", true), g(2, "mafia", false), g(3, "sheriff", false), g(4, "don", true)];
    const theirs = [g(1, "sheriff", true), g(2, "don", false), g(3, "mafia", true), g(4, "civilian", false)];
    const x = crossGames(mine, theirs);
    expect(x.sameTeam.games + x.versus.games).toBe(x.together);
    expect(x.sameRed.games + x.sameBlack.games).toBe(x.sameTeam.games);
    expect(x.versusMyRed.games + x.versusMyBlack.games).toBe(x.versus.games);
    expect(x.sameTeam.wins + x.versus.wins, "победы тоже обязаны сойтись").toBe(
      mine.filter((m) => m.win).length,
    );
  });

  test("чёрные роли: дон тоже чёрный", () => {
    expect(isBlackRole("mafia")).toBe(true);
    expect(isBlackRole("don")).toBe(true);
    expect(isBlackRole("sheriff"), "шериф — красный").toBe(false);
    expect(isBlackRole("civilian")).toBe(false);
  });

  test("победы считаются МОИ, а не его", () => {
    // В общей игре роли разные: победил он — не я. Колонка «победы» обязана
    // означать одно и то же во всех строках таблицы.
    const x = crossGames([g(1, "civilian", false)], [g(1, "mafia", true)]);
    expect(x.versus.wins).toBe(0);
    expect(x.versusMyRed.games).toBe(1);
    expect(x.theirBlack).toBe(1);

    const y = crossGames([g(1, "mafia", true)], [g(1, "don", false)]);
    expect(y.sameBlack, "в одноцвете моя победа — она же общая").toEqual({ games: 1, wins: 1 });

    // Обе половины разноцвета обязаны различаться: иначе строки «ты красный»
    // и «ты чёрный» показывали бы одно и то же.
    const z = crossGames([g(1, "don", true)], [g(1, "sheriff", false)]);
    expect(z.versusMyBlack).toEqual({ games: 1, wins: 1 });
    expect(z.versusMyRed).toEqual({ games: 0, wins: 0 });
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

  test("в комнате id берётся окольно — со своей плитки за столом", () => {
    // Шапки сайта в игре нет, а кнопка пересечений живёт именно там: первая
    // версия молча отвечала «не знаю твой id» всю игру (жалоба 09.08.2026).
    document.body.innerHTML = `
      <div class="player desktop-version"><div class="player__info"><span class="info__name">Чужой</span></div></div>
      <div class="player my-player"><div class="player__info"><span class="info__name"> fj </span></div></div>`;
    expect(readOwnIdFromDom(document), "шапки в комнате нет").toBeNull();
    expect(ownNameFromTable(document)).toBe("fj");
  });

  test("без своей плитки (зритель) ник не выдумывается", () => {
    document.body.innerHTML = `<div class="player"><span class="info__name">Чужой</span></div>`;
    expect(ownNameFromTable(document)).toBeNull();
  });

  test("мусорный адрес не превращается в id", () => {
    expect(ownIdFromHref("/profile/abc")).toBeNull();
    expect(ownIdFromHref("/profile/")).toBeNull();
    expect(ownIdFromHref(null)).toBeNull();
    expect(ownIdFromHref("/profile/13509?tab=games")).toBe(13509);
  });
});

describe("загрузка истории страницами", () => {
  /** Дата n-й по свежести игры: строго убывает, сравнивается как строка. */
  const day = (n: number): string =>
    `${new Date(Date.UTC(2026, 11, 31) - n * 86_400_000).toISOString().slice(0, 10)} 10:00:00`;

  /** Сервер с заданным числом игр: страница отдаёт PAGE_SIZE, даты убывают. */
  function serve(total: number): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const size = Number(new URL(url).searchParams.get("limit") ?? PAGE_SIZE);
      const from = (page - 1) * size;
      const rows = Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => {
        const n = from + i;
        return {
          id: total - n,
          role: { type: "civilian" },
          result: { code: "success" },
          // Свежие первыми: чем дальше по списку, тем старше дата.
          date_start: day(n),
        };
      });
      return { ok: true, json: async () => ({ rows, totalCount: total }) };
    });
  }

  test("забирает ВСЮ историю, а не первую страницу", async () => {
    // Потолок в 200 игр недосчитывал общие игры до полутора раз на живых
    // данных 09.08.2026 — ради этого страницы и появились.
    vi.stubGlobal("fetch", serve(PAGE_SIZE + 450));
    const h = await fetchHistory(1);
    expect(h?.rows).toHaveLength(PAGE_SIZE + 450);
    expect(h?.truncated).toBe(false);
    vi.unstubAllGlobals();
  });

  test("обычная история — ОДИН запрос, а не восемь (жалоба 13.08.2026)", async () => {
    // Сервер отдаёт столько строк, сколько попросишь, и тратит на это одно и
    // то же время: 200 строк — 1.98 с, 6000 строк — 2.38 с (замер 13.08.2026).
    // Значит цена сводки — это ЧИСЛО запросов, и просить по 200 было платой
    // ни за что: восемь ожиданий вместо одного.
    const fetchMock = serve(1500);
    vi.stubGlobal("fetch", fetchMock);
    const h = await fetchHistory(1);
    expect(fetchMock.mock.calls.length, "полторы тысячи игр обязаны уместиться в один запрос").toBe(
      1,
    );
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("limit")).toBe(
      String(PAGE_SIZE),
    );
    expect(h?.rows).toHaveLength(1500);
    vi.unstubAllGlobals();
  });

  test("остальные страницы едут ОДНОВРЕМЕННО, а не одна за другой", async () => {
    // Число страниц известно из totalCount уже с первой — ждать каждую по
    // очереди незачем. Именно эта очередь и делала первую сводку получасовой
    // на глазок: две истории по восемь ожиданий.
    let live = 0;
    let peak = 0;
    const inner = serve(PAGE_SIZE * 3);
    const fetchMock = vi.fn(async (url: string) => {
      live++;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live--;
      return inner(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = await fetchHistory(1);
    expect(h?.rows).toHaveLength(PAGE_SIZE * 3);
    expect(peak, "вторая и третья страницы обязаны лететь вместе").toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });

  test("чужую историю не копает глубже своей самой старой игры", async () => {
    // Раньше самой старой своей игры пересекаться нечему по определению:
    // лишние страницы — это лишние запросы на одно наведение мыши.
    const fetchMock = serve(PAGE_SIZE * 3);
    vi.stubGlobal("fetch", fetchMock);
    const h = await fetchHistory(1, day(PAGE_SIZE - 100));
    expect(fetchMock.mock.calls.length, "первой страницы уже хватило").toBe(1);
    expect(h?.rows).toHaveLength(PAGE_SIZE);
    expect(h?.truncated, "это не обрыв: глубже просто нечего искать").toBe(false);
    vi.unstubAllGlobals();
  });

  test("строка без даты не обрывает листание и не выдаётся за полноту", async () => {
    // Пустая дата меньше любой границы: раньше один такой ответ и
    // останавливал загрузку, и помечал историю ПОЛНОЙ — недобор выглядел бы
    // точным итогом (находка самопроверки 09.08.2026).
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({
        id: page * 1000 + i,
        role: { type: "civilian" },
        result: { code: "success" },
        // У последней строки страницы даты нет — так бывает у битой записи.
        date_start: i === PAGE_SIZE - 1 ? null : "2026-12-01 10:00:00",
      }));
      return { ok: true, json: async () => ({ rows, totalCount: PAGE_SIZE * 3 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = await fetchHistory(1, "2020-01-01 00:00:00");
    expect(h?.rows, "листание продолжилось").toHaveLength(PAGE_SIZE * 3);
    vi.unstubAllGlobals();
  });

  test("упёрлись в предел страниц — говорим об этом честно", async () => {
    vi.stubGlobal("fetch", serve(PAGE_SIZE * (MAX_PAGES + 5)));
    const h = await fetchHistory(1);
    expect(h?.rows).toHaveLength(PAGE_SIZE * MAX_PAGES);
    expect(h?.truncated, "иначе число читается как полный итог").toBe(true);
    vi.unstubAllGlobals();
  });

  test("обрыв посреди листания не выдаёт огрызок за полную историю", async () => {
    const full = serve(PAGE_SIZE * 2);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return page === 1 ? full(url) : { ok: false, status: 500 };
    }));
    const h = await fetchHistory(1);
    expect(h?.rows).toHaveLength(PAGE_SIZE);
    expect(h?.truncated).toBe(true);
    vi.unstubAllGlobals();
  });

  test("выпавшая страница не сшивается через дыру", async () => {
    // Страницы теперь едут разом, и уцелевшая четвёртая соблазнительно
    // «дополняет» историю без третьей. Так делать нельзя: самая старая игра
    // такой истории — ложная граница для ЧУЖОЙ (её копали бы вглубь зря), а
    // число совместных игр молча недобирает середину.
    const full = serve(PAGE_SIZE * 4);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return page === 3 ? { ok: false, status: 500 } : full(url);
    }));
    const h = await fetchHistory(1);
    expect(h?.rows, "остановились на дыре, а не сшили четвёртую со второй").toHaveLength(
      PAGE_SIZE * 2,
    );
    expect(h?.truncated).toBe(true);
    vi.unstubAllGlobals();
  });

  test("первая страница не пришла — это НЕ «игр нет»", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    expect(await fetchHistory(1)).toBeNull();
    vi.unstubAllGlobals();
  });

  test("самая старая дата ищется, а не берётся с конца списка", () => {
    // Порядок выдачи сайта — не контракт.
    // Самая старая НЕ последняя в списке — «взять с конца» дало бы 2026-05
    // и чужая история копалась бы вглубь напрасно (или наоборот, недобрала).
    expect(
      oldestDate([
        { id: 1, role: "civilian", win: true, date: "2026-05-01 00:00:00" },
        { id: 2, role: "civilian", win: true, date: "2025-01-01 00:00:00" },
        { id: 3, role: "civilian", win: true },
        { id: 4, role: "civilian", win: true, date: "2026-07-01 00:00:00" },
      ]),
    ).toBe("2025-01-01 00:00:00");
  });
});
