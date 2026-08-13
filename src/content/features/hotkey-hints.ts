/**
 * Фича: подсказка клавиши прямо на кнопке — «Выкрикнуть (C)», «Пауза (F8)».
 *
 * Просьба владельца 13.08.2026. Хоткей, о котором надо помнить, — это хоткей,
 * которым не пользуются; а переназначенный к тому же нигде не написан, кроме
 * попапа.
 *
 * Рисуется CSS'ом через `::after` от нашего же атрибута, а не отдельным узлом
 * в кнопке. Причины две:
 *  - запись в DOM: подписью владеет Vue, и вставленный внутрь кнопки span он
 *    сносил бы при каждой перерисовке, а мы возвращали бы — ровно тот цикл
 *    «запись → наблюдатель → запись», от которого стоит сторож в player-notes;
 *  - столкновений нет: в CSS комнаты (room/bundle/style.css, сверено
 *    13.08.2026) у `.button` собственного `::after` не объявлено.
 *
 * Атрибут ставится ТОЛЬКО когда клавиша реально сработает: фича хоткея
 * включена, мы в комнате, кнопка на месте и не заблокирована. Подсказка,
 * обещающая нерабочую клавишу, хуже её отсутствия.
 */
import { onDomChange, isVisible } from "@core/dom";
import { formatKeyCode } from "@core/keyboard";
import { SITE, TEXT } from "@core/selectors";
import { isGameRoomPath } from "@shared/routes";
import { findOutcryButton } from "./outcry-hotkey";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const STYLE_ID = "pn-hotkey-hints";
/** Атрибут-метка: он же источник текста для CSS. */
export const HINT_ATTR = "data-pn-key";

const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Как показать клавишу на кнопке. От попапа отличается пробелом: там «Space»
 * читается нормально, а на кнопке в игре нужен знак — владелец просил именно
 * значок пробела.
 */
export function keyHintLabel(code: string): string {
  if (code === "Space") return "␣";
  return formatKeyCode(code);
}

export function styleText(): string {
  return (
    `[${HINT_ATTR}]::after{content:" (" attr(${HINT_ATTR}) ")";` +
    `opacity:.6;font-weight:400;font-size:.85em;white-space:nowrap}`
  );
}

/**
 * Контейнеры меню игры. Гейт нужен ради ЦЕНЫ: проход идёт на каждое шевеление
 * DOM, а `.button, li` по всему документу в комнате — это сотни узлов на тик
 * (тот же урок, что у перф-аудита 06.08.2026). Меню закрыто почти всегда, и
 * дешёвая проверка «а есть ли оно вообще» экономит весь обход.
 */
const MENU_ROOTS = '.base-menu, .game-room__settings, [role="menu"], .dropdown-menu';

/** Пункт «Пауза» в открытом меню настроек. null — меню закрыто. */
export function findPauseItem(root: ParentNode = document): HTMLElement | null {
  const menus = Array.from(root.querySelectorAll<HTMLElement>(MENU_ROOTS)).filter((menu) =>
    isVisible(menu),
  );
  if (menus.length === 0) return null;
  const items = menus.flatMap((menu) =>
    Array.from(menu.querySelectorAll<HTMLElement>('.base-menu__item, [role="menuitem"], .button, li')),
  );
  return (
    items.find((item) => {
      if (!TEXT.pauseExact.includes(norm(item.textContent))) return false;
      if (!isVisible(item)) return false;
      // Заблокированный пункт (пауза уже идёт) клавишей не сработает —
      // подсказка на нём обещала бы неправду.
      return !(
        item.classList.contains("disabled") ||
        item.hasAttribute("disabled") ||
        item.getAttribute("aria-disabled") === "true"
      );
    }) ?? null
  );
}

let unsubscribe: (() => void) | null = null;
let settings: Partial<Settings> = {};

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = styleText();
  document.head.appendChild(style);
}

function clearMarks(): void {
  document
    .querySelectorAll<HTMLElement>(`[${HINT_ATTR}]`)
    .forEach((el) => el.removeAttribute(HINT_ATTR));
}

function cleanup(): void {
  document.getElementById(STYLE_ID)?.remove();
  clearMarks();
}

/**
 * Расставить подсказки. Идемпотентно: атрибут пишется, только если он
 * изменился, а с кнопок, переставших подходить, снимается (инвариант §4 п.1).
 */
export function apply(root: ParentNode = document): void {
  const marked = new Set<Element>();
  const mark = (el: HTMLElement | null, code: string, fallback: string): void => {
    if (!el) return;
    const label = keyHintLabel(code || fallback);
    if (el.getAttribute(HINT_ATTR) !== label) el.setAttribute(HINT_ATTR, label);
    marked.add(el);
  };

  if (settings.outcry_hotkey_enabled === true) {
    mark(findOutcryButton(root), settings.outcry_hotkey_code ?? "", "KeyC");
  }
  if (settings.pause_hotkey_enabled !== false) {
    mark(findPauseItem(root), settings.pause_hotkey_code ?? "", "F8");
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${HINT_ATTR}]`))) {
    if (!marked.has(el)) el.removeAttribute(HINT_ATTR);
  }
}

function tick(): void {
  // Кнопки действий и меню настроек есть только в комнате; на остальных
  // страницах сайта фича обязана не оставлять следов.
  if (!isGameRoomPath(location.pathname)) {
    if (document.getElementById(STYLE_ID)) cleanup();
    return;
  }
  ensureStyle();
  apply();
}

export const hotkeyHintsFeature: Feature = {
  id: "hotkey-hints",
  settingKey: "hotkey_hints_enabled",

  enable(ctx: FeatureContext) {
    settings = ctx.settings;
    tick();
    unsubscribe = onDomChange(() => tick());
  },

  update(ctx: FeatureContext) {
    settings = ctx.settings;
    // Сменил клавишу в попапе — подпись меняется сразу, без перезахода в игру.
    tick();
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    cleanup();
  },
};
