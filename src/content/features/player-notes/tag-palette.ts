/**
 * Палитра готовых меток и цветов ников.
 *
 * Отдельный модуль (арх-ревью 28.08.2026): её делят модалка заметки, менеджер
 * цветов и отрисовка плиток, и «список цветов» — единственная причина этого
 * файла меняться.
 */

/**
 * Палитра меток игроков. `css` — любое значение для background:
 * сплошной цвет ИЛИ градиент (linear-gradient...). Старые метки (hex-цвет) совместимы.
 */
export const TAG_PRESETS: Array<{ css: string; name: string }> = [
  { css: "", name: "нет" },
  // сплошные цвета
  { css: "#ef4444", name: "красный" },
  { css: "#f59e0b", name: "оранжевый" },
  { css: "#eab308", name: "жёлтый" },
  { css: "#22c55e", name: "зелёный" },
  { css: "#3b82f6", name: "синий" },
  { css: "#a855f7", name: "фиолетовый" },
  { css: "#06b6d4", name: "бирюзовый" },
  { css: "#ffffff", name: "белый" },
  { css: "#0a0a0a", name: "чёрный" },
  // градиенты
  { css: "linear-gradient(135deg,#ffffff,#ec4899)", name: "бело-розовый" },
  { css: "linear-gradient(135deg,#ff2d95,#0a0a0a)", name: "розово-чёрный" },
  { css: "linear-gradient(135deg,#0a0a0a,#ffffff)", name: "чёрно-белый" },
  { css: "linear-gradient(135deg,#ff512f,#f09819)", name: "огонь" },
  { css: "linear-gradient(135deg,#ef4444,#eab308,#22c55e,#3b82f6,#a855f7)", name: "радуга" },
];
