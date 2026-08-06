// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game/123" }
/**
 * Бюджет «Tooltip» (перф-аудит 06.08.2026, PERF-11):
 *  • attribute-only батчи не доходят до селекторов вовсе (фильтр по типу
 *    записи стоит ДО чтения addedNodes — записи в тесте намеренно враждебной
 *    формы, с непустым addedNodes, чтобы снятие фильтра детектировалось);
 *  • QSA достаются только поддеревьям, реально содержащим целевые точки;
 *  • удаление владельца тултипа из DOM убирает активный body-тултип,
 *    не дожидаясь disable().
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  domSub: null as null | ((mutations: MutationRecord[]) => void),
}));

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((fn: (mutations: MutationRecord[]) => void) => {
    h.domSub = fn;
    return () => {
      h.domSub = null;
    };
  }),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@content/match-data", () => ({
  getLastGameData: vi.fn(() => null),
}));
vi.mock("@content/features/match-stats", () => ({
  ROLE_COLORS: {} as Record<number, string>,
}));

import type { FeatureContext } from "@core/feature";
import { tooltipFeature } from "@content/features/tooltip";

/** Счётчик ВСЕХ querySelectorAll — и document-wide, и по поддеревьям. */
function spyQsa(): { n: number } {
  const counter = { n: 0 };
  const origDoc = Document.prototype.querySelectorAll;
  vi.spyOn(Document.prototype, "querySelectorAll").mockImplementation(function (
    this: Document,
    selector: string,
  ) {
    counter.n++;
    return origDoc.call(this, selector);
  } as typeof Document.prototype.querySelectorAll);
  const origEl = Element.prototype.querySelectorAll;
  vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    counter.n++;
    return origEl.call(this, selector);
  } as typeof Element.prototype.querySelectorAll);
  return counter;
}

function makeDot(): HTMLElement {
  const dot = document.createElement("div");
  dot.className = "penalty-dot";
  dot.setAttribute("title", "Фол\nИнициатор: 2\n1: ✓");
  return dot;
}

const childRecord = (added: Node[] = [], removed: Node[] = []): MutationRecord =>
  ({ type: "childList", addedNodes: added, removedNodes: removed }) as unknown as MutationRecord;

/**
 * Attribute-запись НАМЕРЕННО враждебной формы: настоящий attribute-record
 * несёт пустой addedNodes, и мутация «снят ранний выход» была бы невидима.
 * Непустой addedNodes гарантирует: фильтр по type обязан стоять ПЕРВЫМ.
 */
const hostileAttrRecord = (target: Element): MutationRecord =>
  ({ type: "attributes", target, addedNodes: [target], removedNodes: [] }) as unknown as MutationRecord;

function enableFeature(): void {
  tooltipFeature.enable({ settings: {} } as unknown as FeatureContext);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  tooltipFeature.disable();
  document.body.innerHTML = "";
});

describe("TT-P11: бюджет подписчика тултипов", () => {
  test("100 attribute-only батчей — 0 QSA, точка не обрабатывается", () => {
    enableFeature();

    const hostileRoot = document.createElement("div");
    const dot = makeDot();
    hostileRoot.appendChild(dot);
    document.body.appendChild(hostileRoot);

    const qsa = spyQsa();
    for (let i = 0; i < 100; i++) h.domSub?.([hostileAttrRecord(hostileRoot)]);

    expect(qsa.n).toBe(0);
    // Точку никто не трогал: нативный title на месте, замены на кастомный
    // тултип не было.
    expect(dot.getAttribute("title")).not.toBeNull();
  });

  test("childList без целевых узлов — 0 QSA", () => {
    enableFeature();

    const leaf = document.createElement("div");
    const branchy = document.createElement("div");
    branchy.appendChild(document.createElement("span"));
    branchy.querySelector("span")?.appendChild(document.createElement("b"));
    document.body.append(leaf, branchy);

    const qsa = spyQsa();
    h.domSub?.([childRecord([leaf]), childRecord([branchy])]);
    expect(qsa.n).toBe(0);
  });

  test("голая точка обрабатывается без QSA; поддерево с точкой — ровно одним", () => {
    enableFeature();

    // Голый appendChild точки в существующую ячейку (кейс лучшего хода).
    const bare = makeDot();
    document.body.appendChild(bare);
    const qsa = spyQsa();
    h.domSub?.([childRecord([bare])]);
    expect(bare.getAttribute("title")).toBeNull(); // обработана
    expect(qsa.n).toBe(0);

    // Точка в глубине добавленного контейнера: один QSA по контейнеру.
    const container = document.createElement("div");
    const cell = document.createElement("div");
    const nested = makeDot();
    cell.appendChild(nested);
    container.appendChild(cell);
    document.body.appendChild(container);
    qsa.n = 0;
    h.domSub?.([childRecord([container])]);
    expect(nested.getAttribute("title")).toBeNull();
    expect(qsa.n).toBe(1);
  });

  test("удаление владельца убирает активный body-тултип до disable()", () => {
    const dot = makeDot();
    document.body.appendChild(dot);
    enableFeature(); // initial scan подхватывает точку

    dot.dispatchEvent(new Event("mouseenter"));
    expect(document.body.querySelector(".penalty-tooltip")).not.toBeNull();

    dot.remove();
    h.domSub?.([childRecord([], [dot])]);
    expect(document.body.querySelector(".penalty-tooltip")).toBeNull();
  });

  test("disable() по-прежнему снимает оставшиеся тултипы и стили", () => {
    const dot = makeDot();
    document.body.appendChild(dot);
    enableFeature();
    dot.dispatchEvent(new Event("mouseenter"));
    expect(document.body.querySelector(".penalty-tooltip")).not.toBeNull();

    tooltipFeature.disable();
    expect(document.body.querySelector(".penalty-tooltip")).toBeNull();
    expect(document.getElementById("polemica-tooltip-styles")).toBeNull();
  });
});
