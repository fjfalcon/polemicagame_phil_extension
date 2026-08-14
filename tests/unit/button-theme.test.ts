/**
 * Цветовая схема кнопок игрока.
 *
 * Тут два разных риска. Первый — молчаливая смена вида у тех, кто ничего не
 * выбирал (умолчание сменилось на белое, и прежний синий обязан остаться
 * доступным). Второй — «свой цвет» уходит в inline-стиль и CSS-переменную, то
 * есть строка из storage попадает прямо в разметку: разбирать её надо строго.
 */
import { describe, expect, test, vi } from "vitest";

// settings.ts тянет webextension-polyfill через @core/env — вне расширения он
// падает при импорте. Нам из него нужны только DEFAULT_SETTINGS.
vi.mock("@core/env", () => ({
  browser: { storage: { sync: {}, local: {}, onChanged: {} } },
}));
vi.mock("@core/log", () => ({ log: { debug: vi.fn() } }));

import {
  CUSTOM_THEME,
  DEFAULT_CUSTOM_COLOR,
  THEME_COLORS,
  buttonThemeColor,
  readButtonColor,
} from "@shared/button-theme";
import { DEFAULT_SETTINGS } from "@core/settings";

describe("умолчание и прежний вид", () => {
  test("по умолчанию кнопки белые", () => {
    expect(DEFAULT_SETTINGS.stats_button_theme).toBe("default");
    expect(buttonThemeColor(DEFAULT_SETTINGS.stats_button_theme, undefined)).toBe("#ffffff");
  });

  test("прежний синий никуда не делся — он стал темой classic", () => {
    // Сменить умолчание можно, отобрать прежний вид — нет: у кого он был
    // привычным, вернуть его должно быть одним выбором.
    expect(THEME_COLORS.classic).toBe("rgb(66, 103, 178)");
  });

  test("явно выбранная тема сильнее умолчания", () => {
    expect(buttonThemeColor("lime", undefined)).toBe(THEME_COLORS.lime);
    expect(buttonThemeColor("classic", "#000000")).toBe(THEME_COLORS.classic);
  });

  test("незнакомая тема не оставляет кнопки без цвета", () => {
    // В storage может лежать значение из будущей версии или из бэкапа.
    expect(buttonThemeColor("нет такой", undefined)).toBe(THEME_COLORS.default);
    expect(buttonThemeColor(undefined, undefined)).toBe(THEME_COLORS.default);
  });
});

describe("своя тема", () => {
  test("берёт цвет из настройки, а не из палитры", () => {
    expect(buttonThemeColor(CUSTOM_THEME, "#12ab34")).toBe("#12ab34");
    expect(buttonThemeColor(CUSTOM_THEME, "#ABC")).toBe("#abc");
  });

  test("мусор в цвете не попадает в разметку", () => {
    // Значение уходит в style и в CSS-переменную: пускать туда произвольную
    // строку нельзя ни из бэкапа, ни из правки руками.
    for (const bad of [
      "red",
      "#12345",
      "javascript:alert(1)",
      "#00ff00; background:url(x)",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(readButtonColor(bad), `«${String(bad)}» не цвет`).toBe(DEFAULT_CUSTOM_COLOR);
    }
  });

  test("своя тема без выбранного цвета не делает кнопки невидимыми", () => {
    expect(buttonThemeColor(CUSTOM_THEME, undefined)).toBe(DEFAULT_CUSTOM_COLOR);
    expect(DEFAULT_SETTINGS.stats_button_color).toBe(DEFAULT_CUSTOM_COLOR);
  });
});
