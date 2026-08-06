// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), safeClick: vi.fn(), isVisible: () => true }));
vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: { id: "x", getManifest: () => ({ version: "9.4.0" }) },
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

import { applyAutoHeight, findSummaryRows, winnerBadge } from "@content/features/match-stats";

describe("winnerBadge: сырой winnerCode SSR", () => {
  test("0 — победа мирных (живая фикстура match_610180)", () => {
    expect(winnerBadge(0)).toEqual({ color: "#22c55e", text: "Победа мирных" });
  });

  test("1 — победа мафии (живая фикстура match_314446)", () => {
    expect(winnerBadge(1)).toEqual({ color: "#ef4444", text: "Победа мафии" });
  });

  test.each([[2], [3], [-1], [undefined], [null], ["1"]])(
    "неизвестный код %s — нейтраль, а НЕ «мафия по умолчанию»",
    (code) => {
      // Прежний `!== 0` молча красил бы новый код сайта в победу мафии —
      // правдоподобная ложь, незаметная по интерфейсу (аудит 06.08.2026).
      expect(winnerBadge(code)).toEqual({ color: "#94a3b8", text: "" });
    },
  );
});

describe("findSummaryRows: семантика вместо порядка", () => {
  function row(title: string, phase?: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "row";
    if (phase) el.setAttribute("data-phase", phase);
    el.innerHTML = `<div class="cell title">${title}</div><div class="cell player">1.5</div>`;
    return el;
  }

  test("текущая разметка: сумма «Итог» есть, MMR нет — игрок не страдает", () => {
    // Живой дрифт из аудита: порядковый выбор «последние две строки» красил
    // последнюю строку ИГРОКА как итог, а сумму — как MMR.
    const rows = [row("№"), row("Ник"), row("Роль"), row("Игрок Вася"), row("Итог")];
    const { totalRow, mmrRow } = findSummaryRows(rows);
    expect(totalRow?.querySelector(".cell.title")?.textContent).toBe("Итог");
    expect(mmrRow, "строки MMR в текущей разметке нет — и выдумывать её нельзя").toBeNull();
  });

  test("сайт вернул строку MMR — она находится по заголовку, не по позиции", () => {
    const rows = [row("Итог"), row("MMR"), row("Ник")];
    const { totalRow, mmrRow } = findSummaryRows(rows);
    expect(totalRow?.querySelector(".cell.title")?.textContent).toBe("Итог");
    expect(mmrRow?.querySelector(".cell.title")?.textContent).toBe("MMR");
  });

  test("наши строки фаз (data-phase) не могут стать «итогом»", () => {
    const rows = [row("Итог", "day-3"), row("Ник")];
    expect(findSummaryRows(rows).totalRow).toBeNull();
  });

  test("строк нет вовсе — оба null, без падения", () => {
    expect(findSummaryRows([])).toEqual({ totalRow: null, mmrRow: null });
  });
});

describe("applyAutoHeight: проводка семантического выбора", () => {
  test("на живой разметке («Итог» без MMR) стилизуется сумма, а не строка игрока", () => {
    // Ревью 06.08.2026: чистая findSummaryRows сторожилась, а её вызов — нет;
    // мутант-возврат к порядковому «последние две строки» проходил все тесты.
    document.body.innerHTML = `
      <div class="game-stats-table">
        <div class="table">
          <div class="row"><div class="cell title">№</div></div>
          <div class="row"><div class="cell title">Роль</div></div>
        </div>
        <div class="table">
          <div class="row" id="last-player"><div class="cell title">10 ночь</div><div class="cell player">1.5</div></div>
        </div>
        <div class="table">
          <div class="row" id="sum-row"><div class="cell title sum">Итог</div><div class="cell player sum">3.2</div></div>
        </div>
      </div>`;
    applyAutoHeight();
    expect(
      document.getElementById("sum-row")?.getAttribute("style") || "",
      "строка «Итог» обязана получить стилизацию итога",
    ).toContain("border-top");
    expect(
      document.getElementById("last-player")?.getAttribute("style") || "",
      "последняя строка ИГРОКА не должна краситься ни итогом, ни MMR",
    ).not.toMatch(/border-top|border-bottom/);
  });
});

describe("протухшие Vue-scope-ID не возвращаются", () => {
  test("в match-stats нет data-v-33ae8458 / data-v-1db9d42a", async () => {
    // Сайт давно на другом scope (data-v-5f3fd140): старые ID матчили только
    // наши же проштампованные узлы и врали о происхождении — заменены на
    // собственный маркер data-pn-stats (аудит хрупкости 06.08.2026).
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/features/match-stats.ts", "utf8");
    // Ловим ИСПОЛЬЗОВАНИЕ (в кавычках или атрибутном селекторе), а не
    // историческое упоминание в комментарии.
    expect(src).not.toMatch(/["'[]data-v-(33ae8458|1db9d42a)/);
    expect(src).toContain("data-pn-stats");
  });
});
