// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Проводка дросселя PERF-1 в подписчике player-notes (ревью 07.08.2026:
 * мутанты W1 «дроссель снят» и W8 «мутации не запускают проход» проходили
 * всю сюиту — чистые функции сторожились, вызов был на честном слове).
 * Наблюдаемое — счётчик document.querySelectorAll: полный проход всегда
 * делает QSA, отфильтрованный батч — ни одного.
 */
const seam = vi.hoisted(() => ({
  subs: [] as Array<(muts: MutationRecord[]) => void>,
  /** Ворота на «узнать свой id»: тест держит их, чтобы поймать окно гонки. */
  ownIdGate: null as Promise<void> | null,
}));

// Свой id — через шов, а не через модуль own-user: у того есть кэш на уровне
// модуля, общий для всех тестов файла, и «медленный резолв» в нём не
// воспроизвести (из-за этого первая версия теста ничего не сторожила).
vi.mock("@core/own-user", () => ({
  OWN_ID_KEY: "pn_own_user_id",
  getOwnUserId: async () => {
    if (seam.ownIdGate) await seam.ownIdGate;
    return 7;
  },
  ownNameFromTable: () =>
    document.querySelector(".player.my-player .info__name")?.textContent?.trim() || null,
  rememberOwnUserId: async () => {},
}));

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: (muts: MutationRecord[]) => void) => {
    seam.subs.push(cb);
    return () => {
      seam.subs = seam.subs.filter((s) => s !== cb);
    };
  }),
  paintNickEl: vi.fn(),
  safeClick: vi.fn(),
  isVisible: vi.fn(() => true),
}));
const browserMock = vi.hoisted(() => ({
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: { id: "x", getManifest: () => ({ version: "9.5.0" }) },
}));
vi.mock("@core/env", () => ({ browser: browserMock }));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn(() => () => {}),
  sendRuntime: vi.fn(async () => ({ success: true })),
  broadcastToGameTabs: vi.fn(),
  sendToActiveTabStrict: vi.fn(),
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { playerNotesFeature,
  REBUILD_COOLDOWN_MS,
  REBUILD_LIMIT,
  isNightNow,
  throttleRebuild,
} from "@content/features/player-notes";
import { resetMatchBriefCache } from "@core/match-brief";
import type { Settings } from "@shared/types";

const ctx = {
  settings: { statistics_enabled: true, nick_colors_enabled: true } as unknown as Settings,
};

function rec(init: { target: Node; added?: Node[]; type?: string }): MutationRecord {
  return {
    type: init.type ?? "childList",
    target: init.target,
    addedNodes: (init.added ?? []) as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
  } as unknown as MutationRecord;
}

const fire = (muts: MutationRecord[]) => seam.subs.forEach((s) => s(muts));

beforeEach(async () => {
  document.body.innerHTML = `<div class="players"><div class="player" id="p1"><div class="inner"></div></div></div>`;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
  await playerNotesFeature.enable(ctx);
});

afterEach(() => {
  playerNotesFeature.disable();
  seam.subs = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("проводка PERF-1", () => {
  const qsa = () => vi.spyOn(document, "querySelectorAll");

  test("identity-мутация (новая плитка) запускает проход НЕМЕДЛЕННО (W8)", () => {
    const spy = qsa();
    const tile = document.createElement("div");
    tile.className = "player";
    fire([rec({ target: document.body, added: [tile] })]);
    expect(spy.mock.calls.length, "проход обязан пройти без ожидания интервала").toBeGreaterThan(
      0,
    );
    spy.mockRestore();
  });

  test("шквал inner-мутаций дросселируется, а через секунду проход проходит (W1)", () => {
    const inner = document.querySelector("#p1 .inner") as Element;
    // Первый inner — проход разрешён (счётчик пуст).
    fire([rec({ target: inner })]);

    const spy = qsa();
    for (let i = 0; i < 10; i++) fire([rec({ target: inner })]);
    expect(spy.mock.calls.length, "внутри секунды повторных проходов нет").toBe(0);

    vi.advanceTimersByTime(1_100);
    fire([rec({ target: inner })]);
    expect(spy.mock.calls.length, "после секунды проход обязан пройти").toBeGreaterThan(0);
    spy.mockRestore();
  });

  test("ряд кнопок встаёт в КОНТЕЙНЕР угла перед плашкой, а не внутрь плашки", () => {
    // Жалоба владельца 08.08.2026: в лобби кнопки ложились на плашку
    // рейтинга сайта — она живёт в той же колонке, а наш ряд висел над
    // плашкой ника абсолютом. В потоке колонки пересечений нет.
    document.body.innerHTML = `
      <div class="players">
        <div class="player" id="p1">
          <div class="player__botleftmenu">
            <div class="mmr-label">6821</div>
            <div class="player__info info">
              <div class="player-number player-0">1</div>
              <span class="info__name">fj</span>
            </div>
          </div>
        </div>
      </div>`;
    const tile = document.querySelector("#p1") as HTMLElement;
    fire([rec({ target: document.body, added: [tile] })]);

    const host = document.querySelector(".player__botleftmenu") as HTMLElement;
    const icons = host.querySelector(":scope > .player-icons");
    expect(icons, "ряд кнопок обязан лежать в колонке угла").not.toBeNull();
    expect(
      document.querySelector(".player__info > .player-icons"),
      "внутри плашки ряда быть не должно — он ложился на рейтинг",
    ).toBeNull();
    // Порядок: кнопки ПЕРЕД плашкой ника (привычный вид «кнопки над ником»).
    const kids = Array.from(host.children);
    expect(kids.indexOf(icons as Element)).toBeLessThan(
      kids.indexOf(host.querySelector(".player__info") as Element),
    );
  });

  test("нет контейнера угла — ряд кнопок всё равно появляется (в плашке)", () => {
    // Фолбэк: сайт может отдать плитку без колонки (другой экран, редизайн).
    document.body.innerHTML = `
      <div class="players">
        <div class="player" id="p1">
          <div class="player__info info">
            <div class="player-number player-0">1</div>
            <span class="info__name">fj</span>
          </div>
        </div>
      </div>`;
    const tile = document.querySelector("#p1") as HTMLElement;
    fire([rec({ target: document.body, added: [tile] })]);
    expect(document.querySelector(".player__info > .player-icons")).not.toBeNull();
  });

  test("посторонние мутации не трогают DOM вовсе", () => {
    const foreign = document.createElement("section");
    document.body.appendChild(foreign);
    const spy = qsa();
    for (let i = 0; i < 20; i++) fire([rec({ target: foreign })]);
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();
  });
});

describe("сторож шторма пересборки кнопок (жалоба 12.08.2026)", () => {
  test("обычный темп проходит целиком", () => {
    let state;
    for (let i = 0; i < REBUILD_LIMIT; i++) {
      const r = throttleRebuild(state, 1000 + i);
      expect(r.allowed, `пересборка ${i + 1} в пределах порога`).toBe(true);
      state = r.state;
    }
  });

  test("превышение порога включает паузу и сообщает о шторме", () => {
    let state;
    for (let i = 0; i < REBUILD_LIMIT; i++) state = throttleRebuild(state, 1000).state;
    const storm = throttleRebuild(state, 1000);
    expect(storm.allowed).toBe(false);
    expect(storm.stormed, "о шторме сообщаем — иначе в журнале снова тишина").toBe(true);

    // Пока пауза — молчим и больше НЕ жалуемся (одна строка на шторм).
    const during = throttleRebuild(storm.state, 1000 + REBUILD_COOLDOWN_MS - 1);
    expect(during.allowed).toBe(false);
    expect(during.stormed).toBe(false);
  });

  test("после паузы работа возобновляется", () => {
    let state;
    for (let i = 0; i < REBUILD_LIMIT; i++) state = throttleRebuild(state, 1000).state;
    const storm = throttleRebuild(state, 1000);
    const after = throttleRebuild(storm.state, 1000 + REBUILD_COOLDOWN_MS + 1);
    expect(after.allowed, "плитка не должна остаться без кнопок навсегда").toBe(true);
  });

  test("счётчик скользящий: редкие пересборки не копятся в шторм", () => {
    // Иначе за длинную игру любая плитка однажды упёрлась бы в порог и замерла.
    let state;
    for (let i = 0; i < REBUILD_LIMIT * 3; i++) {
      const r = throttleRebuild(state, 1000 + i * 1500);
      expect(r.allowed).toBe(true);
      state = r.state;
    }
  });
});

/**
 * Прогрев пересечений (просьба владельца 13.08.2026: «чтоб для пользователя
 * было моментально»).
 *
 * Сторожим здесь не «данные посчитались» — это дело crossover.test.ts, — а
 * ЦЕНУ: когда прогрев начинается, сколько историй тянет за один проход и
 * отпускает ли свою, когда стол уже посчитан. Ошибка в любом из трёх
 * превращает тихий фон в поток запросов.
 */
describe("прогрев пересечений", () => {
  /** Кого спрашивали в /profile/default/get-games (userId по порядку). */
  let asked: string[] = [];

  /** Стол: своя плитка + соперники, свой id известен из шапки сайта. */
  function table(...opponents: string[]): void {
    // Класс фазы живёт на body и переживает смену разметки — сбрасываем явно,
    // иначе «ночь» предыдущего теста включила бы прогрев в следующем.
    document.body.className = "";
    document.body.innerHTML = `
      <div class="p-header__userCont"><a href="/profile/7">fj</a></div>
      <div class="players">
        <div class="player my-player" id="me">
          <div class="player__info info"><span class="info__name">fj</span></div>
        </div>
        ${opponents
          .map(
            (name, i) => `
          <div class="player" id="p${i}">
            <div class="player__info info"><span class="info__name">${name}</span></div>
          </div>`,
          )
          .join("")}
      </div>`;
  }

  function serveSite(): void {
    asked = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/ratings/default/get-list")) {
          return {
            ok: true,
            json: async () => [
              { user_id: 7, username: "fj" },
              { user_id: 11, username: "Alpha" },
              { user_id: 12, username: "Beta" },
              { user_id: 13, username: "Gamma" },
            ],
          };
        }
        if (url.includes("/profile/default/get-games")) {
          asked.push(new URL(url).searchParams.get("userId") ?? "");
          return { ok: true, json: async () => ({ rows: [], totalCount: 0 }) };
        }
        return { ok: false, status: 404 };
      }) as unknown as typeof fetch,
    );
  }

  /** Прогнать проход по плиткам и дать асинхронным хвостам доехать. */
  async function pass(): Promise<void> {
    const tile = document.querySelector(".player") as HTMLElement;
    fire([rec({ target: document.body, added: [tile] })]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
  }

  beforeEach(async () => {
    playerNotesFeature.disable();
    seam.subs = [];
    seam.ownIdGate = null;
    serveSite();
    await playerNotesFeature.enable({
      settings: { statistics_enabled: true, btn_crossover_enabled: true } as unknown as Settings,
    });
  });

  test("днём прогрев молчит", async () => {
    // Днём игрок говорит и смотрит на стол — фоновые истории ему ни к чему,
    // да и ночь ещё придёт.
    document.body.classList.remove("night");
    table("Alpha", "Beta");
    await pass();
    expect(asked, "ни одной истории до первой ночи").toEqual([]);
  });

  test("ночью считает по ОДНОМУ игроку за проход", async () => {
    // Залп из десяти историй разом — это и грубо к серверу, и медленнее для
    // того единственного, на кого сейчас навели курсор.
    table("Alpha", "Beta", "Gamma");
    document.body.classList.add("night");

    await pass();
    // Своя история (id 7) + ровно один соперник.
    expect(asked.filter((id) => id !== "7"), "за проход — один соперник").toHaveLength(1);

    await pass();
    expect(asked.filter((id) => id !== "7"), "следующий проход берёт следующего").toHaveLength(2);
  });

  test("себя не прогреваем", async () => {
    // «Пересечения с собой» — это просто все свои игры; лишний запрос ни о чём.
    table();
    document.body.classList.add("night");
    await pass();
    expect(asked, "за столом только я — тянуть нечего").toEqual([]);
  });

  test("стол посчитан — своя история отпущена", async () => {
    // Просьба владельца: держать в памяти сводку (полтора десятка чисел), а
    // не тысячи строк истории. Наблюдаемо: подсевший позже игрок заставляет
    // загрузить свою историю ЗАНОВО.
    table("Alpha");
    document.body.classList.add("night");
    await pass();
    expect(asked.filter((id) => id === "7"), "своя история загружена").toHaveLength(1);

    // Стол прогрет целиком — проход обязан отпустить историю.
    await pass();

    const late = document.createElement("div");
    late.className = "player";
    late.innerHTML = `<div class="player__info info"><span class="info__name">Beta</span></div>`;
    document.querySelector(".players")!.appendChild(late);
    await pass();
    expect(
      asked.filter((id) => id === "7").length,
      "историю отпустили — для нового игрока её пришлось взять снова",
    ).toBe(2);
  });

  test("второе наведение ЖДЁТ первый запрос, а не заводит свой", async () => {
    // Замечание владельца 13.08.2026. Реестр «в полёте» был, но между
    // проверкой реестра и записью в него стоял await (свой id) — и два
    // наведения подряд успевали проскочить оба, подняв по паре историй
    // каждое. Держим ворота на резолве ника: пока он висит, оба наведения
    // как раз и оказываются «внутри окна».
    let open = () => {};
    // В комнате шапки сайта нет, и свой id добывается запросом — вот оно,
    // окно между «проверил реестр» и «записал в реестр».
    seam.ownIdGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    table("Alpha");
    await pass();

    // Именно на плитке СОПЕРНИКА: на своей кнопка тоже есть, и наведение на
    // неё ничего бы не проверило (первая версия теста так и промахнулась).
    const button = document.querySelector("#p0 .pn-crossover-button") as HTMLElement;
    expect(button, "кнопка пересечений обязана быть на плитке соперника").not.toBeNull();
    button.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(400);
    button.dispatchEvent(new MouseEvent("mouseleave"));
    button.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(400);

    open();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked.filter((id) => id === "11"), "история соперника запрошена один раз").toHaveLength(
      1,
    );
  });

  test("ночь определяется по классу фазы у body", () => {
    document.body.classList.remove("night");
    expect(isNightNow()).toBe(false);
    document.body.classList.add("night");
    expect(isNightNow()).toBe(true);
  });
});

/**
 * Окно «последние игры»: длина списка и пометка «ПУ» (просьба владельца
 * 13.08.2026, скриншот с пометками от руки).
 *
 * Пометка — это УТВЕРЖДЕНИЕ про человека, поэтому сторожим границу «знаем /
 * не знаем» и то, что настройка действительно управляет запросами: разбор
 * каждого матча стоит отдельного запроса.
 */
describe("окно последних игр", () => {
  let urls: string[] = [];

  /** Сайт: рейтинг, список игр и разборы матчей (id → кто первый убитый). */
  function serveGames(rows: unknown[], firstKilled: Record<string, string>): void {
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("/ratings/default/get-list")) {
          return {
            ok: true,
            json: async () => [
              { user_id: 7, username: "fj" },
              { user_id: 11, username: "Alpha" },
            ],
          };
        }
        if (url.includes("/profile/default/get-games")) {
          return { ok: true, json: async () => ({ rows, totalCount: rows.length }) };
        }
        const match = /\/match\/(\d+)/.exec(url);
        if (match) {
          const who = firstKilled[match[1]];
          if (who === undefined) return { ok: false, status: 500 };
          return {
            ok: true,
            text: async () =>
              `<Gamestats :game-data='{"id": ${match[1]}, "firstKilled": ${who}}'></Gamestats>`,
          };
        }
        return { ok: false, status: 404 };
      }) as unknown as typeof fetch,
    );
  }

  const game = (id: number) => ({
    id,
    role: { type: "civilian" },
    result: { code: "fail" },
    mmr: { mmr_diff: -28 },
  });

  function board(): void {
    document.body.className = "";
    document.body.innerHTML = `
      <div class="p-header__userCont"><a href="/profile/7">fj</a></div>
      <div class="players">
        <div class="player" id="p0">
          <div class="player__info info"><span class="info__name">Alpha</span></div>
        </div>
      </div>`;
  }

  /** Навести курсор на «последние игры» и дождаться содержимого тултипа. */
  async function hover(): Promise<string> {
    fire([rec({ target: document.body, added: [document.querySelector(".player") as Node] })]);
    await vi.advanceTimersByTimeAsync(1);
    const button = document.querySelector("#p0 .last-games-button") as HTMLElement;
    // Ссылку на тултип берём ДО наведения: показ уносит его порталом в body.
    const tip = button.querySelector(".pn-tooltip") as HTMLElement;
    button.dispatchEvent(new MouseEvent("mouseenter"));
    // С «ПУ» окно ждёт задержку намерения: мазок курсором по столу не должен
    // поднимать разбор каждой игры у каждого игрока.
    await vi.advanceTimersByTimeAsync(400);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1);
    return tip.innerHTML;
  }

  async function start(settings: Record<string, unknown>): Promise<void> {
    // Разборы матчей кэшируются на уровне модуля и переживают тест: без
    // сброса соседний тест видел бы чужую пометку.
    resetMatchBriefCache();
    playerNotesFeature.disable();
    seam.subs = [];
    seam.ownIdGate = null;
    await playerNotesFeature.enable({
      settings: { statistics_enabled: true, btn_last_games_enabled: true, ...settings } as never,
    });
    board();
  }

  test("«ПУ» стоит ровно там, где первым убили именно его", async () => {
    serveGames([game(101), game(102)], { "101": "11", "102": "99" });
    await start({ last_games_count: "8", last_games_first_killed: true });
    const html = await hover();
    expect(html.match(/ПУ/g) ?? [], "одна игра из двух — его").toHaveLength(1);
  });

  test("матч не разобрался — пометки нет ВОВСЕ", async () => {
    // «Не ПУ» по неудаче было бы утверждением, которого мы не проверяли:
    // разбор не пришёл — значит мы просто не знаем.
    serveGames([game(101)], {});
    await start({ last_games_count: "8", last_games_first_killed: true });
    expect(await hover()).not.toContain("ПУ");
  });

  test("выключённая настройка не ходит за разборами матчей", async () => {
    // Это её единственный смысл: восемь игр — восемь лишних запросов.
    serveGames([game(101)], { "101": "11" });
    await start({ last_games_count: "8", last_games_first_killed: false });
    const html = await hover();
    expect(html).not.toContain("ПУ");
    expect(urls.filter((u) => u.includes("/match/")), "матчи не запрашивались").toEqual([]);
  });

  test("сколько игр просить — из настройки, а не из кода", async () => {
    // Проверяем ОБА значения: тест только на «4» проходил бы и с прежним
    // зашитым четырём (поймано мутантом при самопроверке).
    const limitAsked = () =>
      new URL(urls.find((u) => u.includes("get-games"))!).searchParams.get("limit");

    serveGames([game(101)], {});
    await start({ last_games_count: "8", last_games_first_killed: false });
    await hover();
    expect(limitAsked()).toBe("8");

    serveGames([game(101)], {});
    await start({ last_games_count: "4", last_games_first_killed: false });
    await hover();
    expect(limitAsked()).toBe("4");
  });

  test("мазок курсором по столу не поднимает разборы матчей", async () => {
    // С «ПУ» окно стоит запроса на каждую игру: без задержки намерения
    // проход мышью по десяти плиткам стоил бы под сотню запросов.
    serveGames([game(101)], { "101": "11" });
    await start({ last_games_count: "8", last_games_first_killed: true });
    fire([rec({ target: document.body, added: [document.querySelector(".player") as Node] })]);
    await vi.advanceTimersByTimeAsync(1);

    const button = document.querySelector("#p0 .last-games-button") as HTMLElement;
    button.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(100);
    button.dispatchEvent(new MouseEvent("mouseleave"));
    await vi.advanceTimersByTimeAsync(500);
    expect(urls.filter((u) => u.includes("get-games")), "курсор ушёл — грузить нечего").toEqual([]);
  });

  test("без «ПУ» окно открывается сразу, как раньше", async () => {
    // Дешёвое окно (один запрос) ждать не должно — задержка тут была бы
    // регрессом вида «стало медленнее, чем было».
    serveGames([game(101)], {});
    await start({ last_games_count: "4", last_games_first_killed: false });
    fire([rec({ target: document.body, added: [document.querySelector(".player") as Node] })]);
    await vi.advanceTimersByTimeAsync(1);

    const button = document.querySelector("#p0 .last-games-button") as HTMLElement;
    button.dispatchEvent(new MouseEvent("mouseenter"));
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1);
    expect(urls.some((u) => u.includes("get-games")), "запрос ушёл без ожидания").toBe(true);
  });
});

/**
 * Цветовая схема кнопок (просьба владельца 13.08.2026: белая по умолчанию,
 * прежняя синяя отдельным пунктом, плюс «своя»).
 *
 * Сторожим проводку: палитра живёт в shared, а перекраска — в content, и
 * между ними легко потерять именно «свой цвет» (единственное значение,
 * которое приходит не из палитры).
 */
describe("цвет кнопок игрока", () => {
  async function board(settings: Record<string, unknown>): Promise<HTMLElement> {
    playerNotesFeature.disable();
    seam.subs = [];
    await playerNotesFeature.enable({
      settings: { statistics_enabled: true, btn_stats_enabled: true, ...settings } as never,
    });
    document.body.className = "";
    document.body.innerHTML = `
      <div class="players"><div class="player" id="p0">
        <div class="player__info info"><span class="info__name">Alpha</span></div>
      </div></div>`;
    fire([rec({ target: document.body, added: [document.querySelector(".player") as Node] })]);
    await vi.advanceTimersByTimeAsync(1);
    return document.querySelector("#p0 .stats-button") as HTMLElement;
  }

  test("по умолчанию кнопки белые", async () => {
    const button = await board({});
    expect(button.style.color).toBe("rgb(255, 255, 255)");
  });

  test("«своя тема» красит в выбранный цвет", async () => {
    const button = await board({ stats_button_theme: "custom", stats_button_color: "#12ab34" });
    expect(button.style.color).toBe("rgb(18, 171, 52)");
  });

  test("смена темы в попапе перекрашивает уже нарисованные кнопки", async () => {
    // Иначе цвет применялся бы только к кнопкам следующей игры.
    const button = await board({});
    playerNotesFeature.update?.({
      settings: { statistics_enabled: true, btn_stats_enabled: true, stats_button_theme: "classic" },
    } as never);
    expect(button.style.color).toBe("rgb(66, 103, 178)");
  });
});

/**
 * Точка «есть заметка» (просьба владельца 15.08.2026: дать выключить тем,
 * кому она не нужна).
 */
describe("тумблер точки «есть заметка»", () => {
  async function boardWithNote(enabled: boolean): Promise<void> {
    playerNotesFeature.disable();
    seam.subs = [];
    (browserMock.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (q: unknown) => {
        // Карта заметок: у Alpha заметка есть. pn_migrated обязателен, иначе
        // enable уйдёт в путь миграции из sync и карта потеряется в моках.
        if (q && typeof q === "object" && "playerNotes" in (q as object)) {
          return {
            playerNotes: { Alpha: { text: "чекает в нуля" } },
            tagCustomColors: [],
            pn_notes_migrated_v1: true,
          };
        }
        return {};
      },
    );
    await playerNotesFeature.enable({
      settings: {
        statistics_enabled: true,
        btn_note_enabled: true,
        note_indicator_enabled: enabled,
      } as never,
    });
    document.body.className = "";
    document.body.innerHTML = `
      <div class="players"><div class="player" id="p0">
        <div class="player__info info"><span class="info__name">Alpha</span></div>
      </div></div>`;
    fire([rec({ target: document.body, added: [document.querySelector(".player") as Node] })]);
    await vi.advanceTimersByTimeAsync(1);
  }

  test("включено — точка стоит у игрока с заметкой", async () => {
    await boardWithNote(true);
    expect(document.querySelector(".pn-note-dot"), "заметка есть — точка есть").not.toBeNull();
  });

  test("выключено — точки нет, а при выключении на лету снимается", async () => {
    await boardWithNote(false);
    expect(document.querySelector(".pn-note-dot")).toBeNull();

    // Включили в попапе → точка появляется без пересборки.
    playerNotesFeature.update?.({
      settings: {
        statistics_enabled: true,
        btn_note_enabled: true,
        note_indicator_enabled: true,
      } as never,
    } as never);
    expect(document.querySelector(".pn-note-dot"), "включение вернуло точку").not.toBeNull();

    // И обратно: выключение обязано снять УЖЕ стоящую.
    playerNotesFeature.update?.({
      settings: {
        statistics_enabled: true,
        btn_note_enabled: true,
        note_indicator_enabled: false,
      } as never,
    } as never);
    expect(document.querySelector(".pn-note-dot"), "выключение сняло точку").toBeNull();
  });
});
