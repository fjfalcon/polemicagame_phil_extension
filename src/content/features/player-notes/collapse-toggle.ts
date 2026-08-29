/**
 * Сворачивание ряда кнопок плитки за «⋯» (просьба владельца 29.08.2026:
 * кнопок стало много, «чтоб не мешалось»).
 *
 * Вынесено модулем по правилу «новая подсистема — новый модуль» (инвариант
 * player-notes-кап). Состояния здесь НЕТ: правда одна — настройка
 * tile_buttons_collapsed (sync). Тумблер на любой плитке и переключатель в
 * попапе пишут одну и ту же настройку, обычный путь настроек разносит её по
 * плиткам и вкладкам — отдельного канала синхронизации не нужно.
 *
 * DOM-запись строго идемпотентна (§4.1): вызывается из подписчика onDomChange
 * на каждом проходе.
 *
 * Прячет кнопки НЕ этот модуль, а правило в notes.css по атрибуту
 * data-pn-collapsed: notes.css даёт кнопкам поимённо display:flex !important,
 * и inline style.display="none" ему проигрывает — на живом сайте
 * сворачивалась одна кнопка из семи (жалоба владельца 29.08.2026, jsdom-тест
 * был слеп: обвязка не загружает notes.css). Модуль пишет только атрибут.
 */
import { OWN } from "@core/selectors";
import { BUTTON_PLAIN_CSS } from "./styles";

export interface CollapseToggleCtx {
  /** Текущее значение настройки (правда — в settings, не в DOM). */
  isCollapsed(): boolean;
  /** Клик по тумблеру: перевернуть настройку (и оптимистично перерисовать). */
  onToggle(next: boolean): void;
  /** Тема кнопок фичи — тумблер выглядит как остальной ряд. */
  themeButton(button: HTMLElement): void;
}

const SVG_STYLE = 'style="color: rgba(66, 103, 178, 0.9);"';
const SVG_OPEN =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${SVG_STYLE}>` +
  '<path d="M14 6L8 12L14 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_COLLAPSED =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${SVG_STYLE}>` +
  '<circle cx="5" cy="12" r="1.6" fill="currentColor"/>' +
  '<circle cx="12" cy="12" r="1.6" fill="currentColor"/>' +
  '<circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>';

function createToggle(ctx: CollapseToggleCtx): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = OWN.collapseButton;
  button.style.cssText = BUTTON_PLAIN_CSS;
  // Слушатель живёт на своём узле и умирает вместе с ним (уборка ряда идёт
  // через OWN_BUTTON_SELECTOR) — remove не нужен, §4.7 учтено в разрешении.
  button.addEventListener("click", () => ctx.onToggle(!ctx.isCollapsed()));
  ctx.themeButton(button);
  return button;
}

/** Идемпотентно привести группу кнопок к настройке свёрнутости. */
export function syncCollapseState(iconsGroup: HTMLElement, ctx: CollapseToggleCtx): void {
  const collapsed = ctx.isCollapsed();
  let toggle = iconsGroup.querySelector<HTMLElement>(`.${OWN.collapseButton}`);
  if (!toggle) {
    toggle = createToggle(ctx);
    iconsGroup.appendChild(toggle);
  }
  // Тумблер держится в конце ряда: ensureRotate/Mute дописывают ЗА него.
  if (iconsGroup.lastElementChild !== toggle) iconsGroup.appendChild(toggle);
  const want = collapsed ? "true" : "false";
  // Запись через setAttribute, а не dataset: присваивание dataset идёт мимо
  // Element.prototype.setAttribute, и шпион идемпотентности его не видит
  // (dataset-мутация прошла зелёной — поймано при разработке теста).
  if (iconsGroup.dataset.pnCollapsed !== want) iconsGroup.setAttribute("data-pn-collapsed", want);
  if (toggle.dataset.pnState !== want) {
    toggle.setAttribute("data-pn-state", want);
    toggle.title = collapsed ? "Показать кнопки" : "Свернуть кнопки";
    // Свёрнуто — «⋯» (за ним спрятан ряд); развёрнуто — шеврон «‹».
    toggle.innerHTML = collapsed ? SVG_COLLAPSED : SVG_OPEN;
    // Перекрасить ПОСЛЕ смены глифа: innerHTML приносит SVG с зашитым синим,
    // а тема красит только уже существующие узлы — без этого вызова кнопка
    // мигала «то синяя, то белая» (жалоба владельца 29.08.2026): тема её
    // красила проходом по всем кнопкам, очередной клик возвращал синий.
    ctx.themeButton(toggle);
  }
}
