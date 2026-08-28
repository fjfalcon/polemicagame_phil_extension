/**
 * Инлайновые стили кнопок и тултипов player-notes.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026): это статические
 * строки без единой ветки логики, и держать их посреди четырёх тысяч строк
 * поведения незачем. Инлайн, а не таблица стилей, — осознанно: сайт живёт
 * своим CSS, и наши правила не должны участвовать в его каскаде.
 */

export const BUTTON_CIRCLE_CSS = `
  position: relative; /* якорь тултипа: без него absolute-тултип цеплялся к случайному предку */
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 1 !important;
  visibility: visible !important;
`;

export const BUTTON_PLAIN_CSS = `
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  transition: all 0.2s ease;
  opacity: 1 !important;
  visibility: visible !important;
`;

export const TOOLTIP_CSS = `
  position: absolute;
  bottom: 100%;
  left: 0;
  transform: translateY(10px);
  background: rgba(11, 27, 57, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(79, 129, 245, 0.3);
  padding: 10px;
  border-radius: 8px;
  font-size: 12px;
  visibility: hidden;
  opacity: 0;
  /* ТОЛЬКО opacity: со значением "all" тултип, уезжая в портал (showTooltip),
     анимировал ещё и left/top — от левого края экрана к своей позиции: он
     «влетал» через пол-страницы (регрессия 8.1.55). */
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
  white-space: normal;
  min-width: 120px;
  z-index: 1001;
  line-height: 1.3;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  margin-bottom: 5px;
  color: white;
`;

/**
 * Значение атрибута для селектора БЕЗ кавычек: `[data-username=<escaped>]`.
 *
 * Ручная замена кавычек не покрывала управляющие символы (LF/CR/FF): ник с
 * ними делал селектор невалидным, и querySelectorAll бросал исключение —
 * обновление кнопок/тултипов срывалось (аудит безопасности 01.08.2026, №14).
 * CSS.escape экранирует по спецификации именно идентификатор, поэтому
 * подставлять результат нужно без обрамляющих кавычек.
 */
export function cssAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // Фолбэк (движков без CSS.escape среди наших минимумов нет): экранируем
  // всё, что не [A-Za-z0-9_-] и не кириллица, по правилу CSS «\<hex> ».
  return value.replace(/[^\wЀ-ӿ-]/g, (c) => `\\${c.codePointAt(0)!.toString(16)} `);
}
