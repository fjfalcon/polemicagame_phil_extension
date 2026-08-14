/**
 * Цветовая схема кнопок на плитке игрока.
 *
 * Общее место для контента и попапа: список тем и разбор «своего» цвета. До
 * 9.22.0 палитра жила только в content-скрипте, а попап знал о ней лишь по
 * списку <option> — два источника правды, которые уже начали расходиться
 * (в разметке не было половины значений).
 *
 * Смена умолчания (просьба владельца 13.08.2026): по умолчанию теперь БЕЛАЯ.
 * Прежний тёмно-синий никуда не делся — он стал обычным пунктом «Синяя (как
 * раньше)», так что вернуть прежний вид можно одним выбором. Те, кто тему не
 * трогал, увидят белые кнопки — это и есть смысл просьбы, но сказать об этом
 * пользователям надо прямо.
 */

/** Тема → цвет. `custom` цвета здесь не имеет: он лежит в настройке. */
export const THEME_COLORS: Record<string, string> = {
  // Белый по умолчанию: стол в комнате тёмный, и белые иконки читаются на нём
  // при любой раскраске плиток.
  default: "#ffffff",
  // Прежнее умолчание расширения — теперь именованная тема.
  classic: "rgb(66, 103, 178)",
  pink: "#ec4899",
  yellow: "#eab308",
  red: "#ef4444",
  green: "#22c55e",
  lime: "#84cc16",
  blue: "#38bdf8",
};

/** Значение темы «свой цвет». */
export const CUSTOM_THEME = "custom";
/** Цвет своей темы, пока игрок не выбрал свой. */
export const DEFAULT_CUSTOM_COLOR = "#ffd54f";

/**
 * Разобрать цвет своей темы. Только `#rgb`/`#rrggbb`: значение уходит в
 * style-свойство и в CSS-переменную, и пускать туда произвольную строку из
 * storage (бэкап, правка руками, другая версия) нельзя.
 */
export function readButtonColor(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_CUSTOM_COLOR;
  const value = raw.trim().toLowerCase();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(value) ? value : DEFAULT_CUSTOM_COLOR;
}

/**
 * Цвет кнопок для текущих настроек. Незнакомая тема — это не повод остаться
 * без цвета: возвращаем умолчание.
 */
export function buttonThemeColor(theme: unknown, customColor: unknown): string {
  if (theme === CUSTOM_THEME) return readButtonColor(customColor);
  return THEME_COLORS[theme as string] ?? THEME_COLORS.default;
}
