// @vitest-environment jsdom
/**
 * Модуль role-pin — единственный владелец inline-пина своей роли (аудит
 * скрытия ролей 29.08.2026, находки 1/2/7). Ключевые обещания:
 *  • правда живёт НА УЗЛЕ: Vue-пересоздание уносит пин, pinHolds честно
 *    отвечает «нет» — глобальный латч без этого лгал (роль в эфире);
 *  • подъём на время «подсмотреть» логически ДЕРЖИТ пин (владелец не воюет
 *    с подсматриванием), возврат перенакладывает на ЖИВЫЕ узлы;
 *  • снятие возвращает ровно те стили и приоритеты, что были до нас.
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  getRoleVisibilityTargets,
  isPinnedElement,
  liftPins,
  pinHolds,
  pinOwnRole,
  releasePins,
  resetRolePinForTest,
  restoreLiftedPins,
} from "@content/role-pin";

function mountRole(): HTMLElement {
  const el = document.createElement("div");
  el.className = "player__role role my-role";
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  resetRolePinForTest();
  document.body.innerHTML = "";
});

describe("пин своей роли", () => {
  test("пин скрытия: important-стили + маркер на узле; целей нет — false", () => {
    expect(pinOwnRole("hidden"), "пустая страница").toBe(false);
    const el = mountRole();
    expect(pinOwnRole("hidden")).toBe(true);
    expect(el.style.getPropertyValue("visibility")).toBe("hidden");
    expect(el.style.getPropertyPriority("visibility")).toBe("important");
    expect(isPinnedElement(el)).toBe(true);
    expect(pinHolds("hidden")).toBe(true);
    expect(pinHolds("visible")).toBe(false);
  });

  test("№1: Vue-пересоздание узла — пин мёртв, и pinHolds это ЗНАЕТ", () => {
    const el = mountRole();
    pinOwnRole("hidden");
    el.remove();
    mountRole(); // свежий узел без пина — настоящая роль видна
    expect(pinHolds("hidden"), "глобальная память не заменяет живой узел").toBe(false);
  });

  test("№7: подъём для peek держит пин логически и возвращает на ЖИВОЙ узел", () => {
    const el = mountRole();
    pinOwnRole("hidden");
    expect(liftPins()).toBe(true);
    expect(el.style.getPropertyValue("visibility"), "стили сняты — роль видна").toBe("");
    expect(pinHolds("hidden"), "владелец не должен перепинивать под peek").toBe(true);
    // Vue пересоздал узел, пока клавиша удерживалась.
    el.remove();
    const fresh = mountRole();
    restoreLiftedPins();
    expect(fresh.style.getPropertyValue("visibility"), "пин вернулся на живой узел").toBe("hidden");
    expect(isPinnedElement(fresh)).toBe(true);
  });

  test("снятие возвращает исходные inline-стили С ПРИОРИТЕТАМИ", () => {
    const el = mountRole();
    el.style.setProperty("opacity", "0.5", "important");
    el.style.visibility = "visible";
    pinOwnRole("hidden");
    releasePins();
    expect(el.style.getPropertyValue("opacity")).toBe("0.5");
    expect(el.style.getPropertyPriority("opacity")).toBe("important");
    expect(el.style.getPropertyValue("visibility")).toBe("visible");
    expect(isPinnedElement(el)).toBe(false);
    expect(pinHolds("hidden")).toBe(false);
  });

  test("повторный lift без пина — false; restore после перепина владельцем — не мешает", () => {
    expect(liftPins(), "пина нет — поднимать нечего").toBe(false);
    mountRole();
    pinOwnRole("hidden");
    liftPins();
    // Владелец перепинил сам (смена фазы на ночь) — подъём аннулирован.
    pinOwnRole("visible");
    restoreLiftedPins(); // не должен вернуть «hidden» поверх ночного показа
    expect(pinHolds("visible")).toBe(true);
    const el = getRoleVisibilityTargets()[0];
    expect(el.getAttribute("data-pn-role-pin")).toBe("visible");
  });
});
