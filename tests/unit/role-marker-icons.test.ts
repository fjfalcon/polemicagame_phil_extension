// @vitest-environment jsdom
/**
 * Иконки сайта в метках ролей (просьба владельца 15.08.2026: вместо подписей
 * «Мир/Шер/Дон» — фрагменты спрайта комнаты).
 *
 * Сторожим то, чем можно навредить: неверное сопоставление (дон в спрайте
 * зовётся godfather — перепутать значит показать чужую роль) и потерю
 * идемпотентности (метка перерисовывается общим наблюдателем).
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));
vi.mock("@core/dom", () => ({ onDomChange: vi.fn(() => () => {}) }));

import { paintMarker } from "@content/features/role-marker";
import { resetRoleSpriteCache } from "@content/role-sprite";

const hrefOf = (m: HTMLElement): string =>
  m.querySelector("use")?.getAttribute("href") ?? "";

function marker(): HTMLElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  resetRoleSpriteCache();
});

describe("иконки сайта в метке", () => {
  test("каждой роли — свой фрагмент спрайта; дон = godfather", () => {
    const m = marker();
    paintMarker(m, "civ");
    expect(hrefOf(m)).toContain("#civilian");
    paintMarker(m, "sheriff");
    expect(hrefOf(m)).toContain("#sheriff");
    paintMarker(m, "mafia");
    expect(hrefOf(m)).toContain("#mafia");
    // Перепутать = показать чужую роль: дон в спрайте сайта — godfather.
    paintMarker(m, "don");
    expect(hrefOf(m)).toContain("#godfather");
  });

  test("сброс остаётся текстом «?» — иконки у него нет", () => {
    const m = marker();
    paintMarker(m, "none");
    expect(m.querySelector("use")).toBeNull();
    expect(m.textContent).toBe("?");
  });

  test("спрайт берётся у САЙТА, когда он на странице", () => {
    // Живой <use> комнаты указывает на файл бандла — иконка обязана идти
    // туда же, а не в зашитый фолбэк: у файла в имени хэш, он меняется.
    document.body.innerHTML =
      '<svg><use href="/room/bundle/abc123.svg#civilian"></use></svg>';
    resetRoleSpriteCache();
    const m = marker();
    paintMarker(m, "sheriff");
    expect(hrefOf(m)).toBe("/room/bundle/abc123.svg#sheriff");
  });

  test("повторная перерисовка той же роли НИЧЕГО не пишет (§4 п.1)", () => {
    const m = marker();
    paintMarker(m, "civ");
    const before = m.innerHTML;
    const spy = vi.spyOn(m, "innerHTML", "set");
    paintMarker(m, "civ");
    expect(spy, "dataset.role совпал — записи нет").not.toHaveBeenCalled();
    expect(m.innerHTML).toBe(before);
    spy.mockRestore();
  });
});
