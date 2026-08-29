// @vitest-environment jsdom
/**
 * Сворачивание ряда кнопок плитки за «⋯» (9.56.x, просьба владельца).
 *
 * Правда о состоянии — настройка (ctx.isCollapsed); модуль пишет ТОЛЬКО
 * атрибут data-pn-collapsed, а прячет кнопки правило в notes.css. Так, а не
 * inline: notes.css даёт кнопкам поимённо display:flex !important, и inline
 * style.display="none" ему ПРОИГРЫВАЕТ — на живом сайте сворачивалась одна
 * кнопка из семи, единственная не упомянутая в CSS-списке. jsdom-тест был
 * слеп (обвязка не загружает notes.css) — поэтому здесь пара «атрибут в
 * модуле ↔ правило в CSS» сторожится явно, по обоим концам.
 *
 * Ключевое обещание — идемпотентность (§4.1): sync зовётся из подписчика
 * onDomChange на каждом проходе; повторный вызов не пишет в DOM. Проверка
 * шпионами точек записи, НЕ MutationObserver: jsdom глотает запись атрибута
 * в то же значение, и такой тест зелёный даже при снятых гейтах.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/selectors", async (orig) => (await orig()) as object);

import { OWN } from "@core/selectors";
import { syncCollapseState } from "@content/features/player-notes/collapse-toggle";

function makeGroup(buttons = 3): HTMLElement {
  const group = document.createElement("div");
  group.className = "player-icons";
  for (let i = 0; i < buttons; i++) group.appendChild(document.createElement("button"));
  document.body.appendChild(group);
  return group;
}

function ctxOf(state: { collapsed: boolean; toggled: boolean[] }) {
  return {
    isCollapsed: () => state.collapsed,
    onToggle: (next: boolean) => state.toggled.push(next),
    themeButton: () => undefined,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("сворачивание ряда кнопок («⋯»)", () => {
  test("свёрнуто: атрибут на группе, тумблер показывает «⋯»", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    expect(group.getAttribute("data-pn-collapsed")).toBe("true");
    const toggle = group.querySelector<HTMLElement>(`.${OWN.collapseButton}`)!;
    expect(toggle.querySelectorAll("circle"), "иконка «⋯»").toHaveLength(3);
  });

  test("развёрнуто: атрибут снят по значению, тумблер — шеврон", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    state.collapsed = false;
    syncCollapseState(group, ctxOf(state));
    expect(group.getAttribute("data-pn-collapsed")).toBe("false");
    const toggle = group.querySelector<HTMLElement>(`.${OWN.collapseButton}`)!;
    expect(toggle.querySelector("path"), "иконка-шеврон").not.toBeNull();
  });

  test("пара «модуль ↔ CSS»: правило notes.css прячет ровно то, что помечает модуль", () => {
    // Жалоба 29.08.2026 случилась из-за разрыва этой пары. Сторожим оба
    // конца: атрибут и класс тумблера в правиле — те же, что пишет модуль,
    // display:none — с important (иначе проигрывает поимённому flex).
    const css = readFileSync("src/static/notes.css", "utf8");
    const rule = css.match(
      /\.player-icons\[data-pn-collapsed="true"\]\s*>\s*:not\(\.([\w-]+)\)\s*\{([^}]+)\}/,
    );
    expect(rule, "правило сворачивания существует в notes.css").not.toBeNull();
    expect(rule![1], "исключение правила — класс тумблера из OWN").toBe(OWN.collapseButton);
    expect(rule![2]).toMatch(/display:\s*none\s*!important/);
    // Атрибут, который пишет модуль, — тот же, что в правиле.
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    expect(group.getAttribute("data-pn-collapsed")).toBe("true");
  });

  test("смена глифа перекрашивает кнопку заново — иначе «то синяя, то белая»", () => {
    // innerHTML приносит SVG с зашитым синим; тема красит только живые узлы.
    // Жалоба 29.08.2026: тема перекрашивала тумблер проходом по всем кнопкам,
    // а очередная смена состояния возвращала зашитый цвет.
    const state = { collapsed: false, toggled: [] as boolean[] };
    const paint = (b: HTMLElement) =>
      b.querySelectorAll<SVGElement>("svg").forEach((el) => (el.style.color = "red"));
    const ctx = {
      isCollapsed: () => state.collapsed,
      onToggle: () => undefined,
      themeButton: paint,
    };
    const group = makeGroup();
    syncCollapseState(group, ctx);
    state.collapsed = true;
    syncCollapseState(group, ctx); // смена глифа: innerHTML переписан
    const svg = group.querySelector<SVGElement>(`.${OWN.collapseButton} svg`)!;
    expect(svg.style.color, "тема применена к НОВОМУ svg").toBe("red");
  });

  test("клик переворачивает НАСТРОЙКУ, а не DOM напрямую", () => {
    const state = { collapsed: false, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    const toggle = group.querySelector<HTMLElement>(`.${OWN.collapseButton}`)!;
    toggle.click();
    expect(state.toggled).toEqual([true]);
    state.collapsed = true; // настройку применил владелец
    toggle.click();
    expect(state.toggled).toEqual([true, false]);
  });

  test("§4.1: повторный sync при том же состоянии не пишет в DOM вообще", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    const setAttr = vi.spyOn(Element.prototype, "setAttribute");
    const append = vi.spyOn(Node.prototype, "appendChild");
    syncCollapseState(group, ctxOf(state));
    syncCollapseState(group, ctxOf(state));
    expect(setAttr, "атрибуты не переписываются").not.toHaveBeenCalled();
    expect(append, "тумблер не переставляется").not.toHaveBeenCalled();
    setAttr.mockRestore();
    append.mockRestore();
  });

  test("тумблер держится в конце ряда: дописанная кнопка не оттесняет его", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    group.appendChild(document.createElement("button")); // ensureRotate/Mute
    syncCollapseState(group, ctxOf(state));
    expect(group.lastElementChild!.className).toBe(OWN.collapseButton);
  });
});
