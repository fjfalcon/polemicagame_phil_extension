// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/match/616168" }
/**
 * Раскладка вставленных строк фаз на странице матча.
 *
 * Жалоба 07.08.2026 (скриншот): чипы голосований схлопнулись в левый край,
 * строки растянулись на пол-экрана. Причина — стили таблицы у сайта SCOPED
 * (`.table .row .cell[data-v-XXXX]{flex:1;min-width:115px}`), а аудит
 * хрупкости 06.08 убрал копирование scope-ID на наши строки, посчитав его
 * мёртвым. Проверено на живой странице: со scope наша строка повторяет
 * геометрию сайта (67/115×10), без него ячейки схлопываются в ноль.
 *
 * Тест идёт через НАСТОЯЩИЙ вход фичи (событие gameDataParsed), а не через
 * чистую функцию: мутант «detectScopeAttr есть, но applyScope не зовут»
 * обязан падать.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn(() => () => {}),
  safeClick: vi.fn(),
  isVisible: () => true,
}));
vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: { id: "x", getManifest: () => ({ version: "9.7.0" }) },
  },
}));
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
vi.mock("../../src/content/match-data", () => ({
  getMatchId: () => "616168",
  getLastGameData: () => null,
  parseMatchOnPage: vi.fn(),
}));

import { matchStatsFeature } from "@content/features/match-stats";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

/**
 * Живые scope сайта на 07.08.2026 (в коде НЕ зашиты, читаются из DOM):
 * у обёртки `.game-stats-table` — scope РОДИТЕЛЬСКОГО компонента, а
 * раскладка строк живёт под своим, табличным. Поэтому детект обязан читать
 * атрибут с самой строки/ячейки: взяв его с контейнера, мы проставили бы
 * чужой хеш и получили ровно тот же развал вёрстки.
 */
const SCOPE_ATTR = "data-v-1db9d42a";
const PARENT_SCOPE_ATTR = "data-v-bb241ecc";

const ctx = {
  settings: {
    match_page_stats_enabled: true,
    statistics_enabled: true,
    match_stats_view: "hints",
  } as unknown as Settings,
};

/** Разметка страницы матча так, как её рисует сайт (со scoped-атрибутами). */
function buildSitePage(scopeAttr: string | null): void {
  const scope = scopeAttr ? ` ${scopeAttr}=""` : "";
  // Обёртка и заголовок — под родительским scope, как на живой странице.
  const parent = ` ${PARENT_SCOPE_ATTR}=""`;
  document.body.innerHTML = `
    <div class="game-stats-header"${parent}></div>
    <div class="game-stats-table"${parent}>
      <div class="table"${scope}${parent}>
        <div class="row"${scope}>
          <div class="cell title"${scope}>Роль</div>
          <div class="cell player"${scope}>Мафия</div>
          <div class="cell player"${scope}>Мирный</div>
        </div>
        <div class="row"${scope}>
          <div class="cell title"${scope}>Итог</div>
          <div class="cell player"${scope}>1.5</div>
          <div class="cell player"${scope}>0.5</div>
        </div>
      </div>
    </div>`;
}

/** Данные матча: день с голосованием и ночь с выстрелом. */
const GAME_DATA = {
  data: {
    players: [
      { position: 1, role: 1, username: "a" },
      { position: 2, role: 2, username: "b" },
    ],
    votes: [{ day: 1, voter: 2, candidate: 1, num: 1 }],
    shots: [{ night: 1, shooter: 1, target: 2 }],
    checks: [],
  },
  winner: 1,
};

function fireGameData(): void {
  document.dispatchEvent(new CustomEvent("gameDataParsed", { detail: GAME_DATA }));
  // Таблицу фича ждёт интервалом в 500 мс — без прокрутки строки не встанут.
  vi.advanceTimersByTime(600);
}

/** Наши вставленные строки фаз. */
const phaseRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".row[data-phase]"));

beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  matchStatsFeature.disable();
  vi.useRealTimers();
});

describe("строки фаз наследуют Vue-scope сайта", () => {
  test("scope копируется на строки И на все ячейки — иначе таблица разваливается", () => {
    buildSitePage(SCOPE_ATTR);
    matchStatsFeature.enable(ctx);
    fireGameData();

    const rows = phaseRows();
    expect(rows.length, "строки дня и ночи вставлены").toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.hasAttribute(SCOPE_ATTR), `у строки ${row.dataset.phase} нет scope`).toBe(true);
      const cells = Array.from(row.querySelectorAll<HTMLElement>(".cell"));
      expect(cells.length, "ячейка заголовка + по ячейке на игрока").toBe(3);
      for (const cell of cells) {
        expect(cell.hasAttribute(SCOPE_ATTR), `у ячейки в ${row.dataset.phase} нет scope`).toBe(
          true,
        );
      }
    }
  });

  test("берётся scope СТРОКИ, а не обёртки: у контейнера хеш другого компонента", () => {
    // Живая страница: .game-stats-table несёт scope родителя, а правила
    // .table .row .cell — под своим. Детект «с контейнера» дал бы чужой хеш
    // и тот же самый развал вёрстки, что в жалобе.
    buildSitePage(SCOPE_ATTR);
    matchStatsFeature.enable(ctx);
    fireGameData();

    const rows = phaseRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.hasAttribute(SCOPE_ATTR))).toBe(true);
    expect(
      rows.some((r) => r.hasAttribute(PARENT_SCOPE_ATTR)),
      "scope обёртки на строках не нужен — под ним нет правил раскладки",
    ).toBe(false);
  });

  test("scope-ID НЕ зашит в код: другой хеш сайта подхватывается как есть", () => {
    // Ровно та хрупкость, из-за которой баг и родился: жёсткий data-v-1db9d42a
    // умер бы молча при следующем ребилде сайта.
    buildSitePage("data-v-deadbeef");
    matchStatsFeature.enable(ctx);
    fireGameData();

    const rows = phaseRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.hasAttribute("data-v-deadbeef"))).toBe(true);
    expect(rows.some((r) => r.hasAttribute(SCOPE_ATTR)), "старый хеш не выдумываем").toBe(false);
  });

  test("сайт без scoped-стилей: строки строятся, но об этом сказано в лог", () => {
    // Фолбэк-CSS (.table .row[data-pn-stats]) держит раскладку сам, но
    // молчать нельзя: следующий такой скриншот должен объясняться логом.
    buildSitePage(null);
    matchStatsFeature.enable(ctx);
    fireGameData();

    expect(phaseRows().length).toBeGreaterThanOrEqual(2);
    expect(
      vi.mocked(log.warn).mock.calls.some((args) =>
        args.some((a) => String(a).includes("нет Vue-scope")),
      ),
    ).toBe(true);
  });

  test("фолбэк-CSS задаёт строкам flex и ячейкам ширину сайта", () => {
    buildSitePage(SCOPE_ATTR);
    matchStatsFeature.enable(ctx);
    fireGameData();

    const css = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent || "")
      .join("\n");
    expect(css).toMatch(/\.table \.row\[data-pn-stats\]\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.table \.row\[data-pn-stats\]\s*>\s*\.cell\s*\{[^}]*min-width:\s*115px/);
  });

  test("ячейка дня не сжимается сильнее соседних (нет inline min-width:0)", () => {
    // Inline-ноль перебивал сайтовые 115px: на узком экране наши колонки
    // разъезжались с шапкой (найдено при разборе жалобы 07.08.2026).
    buildSitePage(SCOPE_ATTR);
    matchStatsFeature.enable(ctx);
    fireGameData();

    const dayCells = Array.from(
      document.querySelectorAll<HTMLElement>('.row[data-phase^="day"] .cell.player'),
    );
    expect(dayCells.length).toBeGreaterThan(0);
    for (const cell of dayCells) {
      expect(cell.style.minWidth, "min-width остаётся за CSS сайта").toBe("");
      expect(cell.style.display, "раскладка чипов внутри ячейки — наша").toBe("flex");
    }
  });
});
