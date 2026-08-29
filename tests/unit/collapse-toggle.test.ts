// @vitest-environment jsdom
/**
 * Сворачивание ряда кнопок плитки за «⋯» (9.56.0, просьба владельца).
 *
 * Правда о состоянии — настройка (ctx.isCollapsed), модуль только приводит
 * DOM к ней. Ключевое обещание — идемпотентность (§4.1): sync зовётся из
 * подписчика onDomChange на каждом проходе, и повторный вызов при том же
 * состоянии не имеет права трогать DOM (иначе цикл обратной связи).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/selectors", async (orig) => (await orig()) as object);

import { OWN } from "@core/selectors";
import { syncCollapseState } from "@content/features/player-notes/collapse-toggle";

function makeGroup(buttons = 3): HTMLElement {
  const group = document.createElement("div");
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
  test("свёрнуто: все кнопки спрятаны, тумблер видим и показывает «⋯»", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    const toggle = group.querySelector<HTMLElement>(`.${OWN.collapseButton}`)!;
    expect(toggle.style.display).not.toBe("none");
    for (const b of group.children) {
      if (b !== toggle) expect((b as HTMLElement).style.display).toBe("none");
    }
    expect(group.dataset.pnCollapsed).toBe("true");
    expect(toggle.querySelectorAll("circle"), "иконка «⋯»").toHaveLength(3);
  });

  test("развёрнуто: кнопки возвращаются, тумблер показывает шеврон", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    state.collapsed = false;
    syncCollapseState(group, ctxOf(state));
    for (const b of group.children) expect((b as HTMLElement).style.display).not.toBe("none");
    const toggle = group.querySelector<HTMLElement>(`.${OWN.collapseButton}`)!;
    expect(toggle.querySelector("path"), "иконка-шеврон").not.toBeNull();
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
    // НЕ MutationObserver: jsdom глотает запись атрибута в то же значение,
    // и такой тест зелёный даже при снятых гейтах (проверено мутацией).
    // Сторожим сами точки записи: setAttribute (dataset), appendChild
    // (перестановка тумблера) и сеттер style.display каждого ребёнка.
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));

    let displayWrites = 0;
    for (const child of Array.from(group.children) as HTMLElement[]) {
      const style = child.style;
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style), "display")!;
      Object.defineProperty(style, "display", {
        get: () => desc.get!.call(style) as string,
        set: (v: string) => {
          displayWrites++;
          desc.set!.call(style, v);
        },
      });
    }
    const setAttr = vi.spyOn(Element.prototype, "setAttribute");
    const append = vi.spyOn(Node.prototype, "appendChild");

    syncCollapseState(group, ctxOf(state));
    syncCollapseState(group, ctxOf(state));

    expect(setAttr, "атрибуты не переписываются").not.toHaveBeenCalled();
    expect(append, "тумблер не переставляется").not.toHaveBeenCalled();
    expect(displayWrites, "display не переписывается").toBe(0);
    setAttr.mockRestore();
    append.mockRestore();
  });

  test("тумблер держится в конце ряда: дописанная сайтом/нами кнопка не оттесняет его", () => {
    const state = { collapsed: true, toggled: [] as boolean[] };
    const group = makeGroup();
    syncCollapseState(group, ctxOf(state));
    const late = document.createElement("button"); // ensureRotate/Mute append
    group.appendChild(late);
    syncCollapseState(group, ctxOf(state));
    expect(group.lastElementChild!.className).toBe(OWN.collapseButton);
    expect(late.style.display, "поздняя кнопка тоже свёрнута").toBe("none");
  });
});
