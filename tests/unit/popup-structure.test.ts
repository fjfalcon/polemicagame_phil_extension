// @vitest-environment jsdom
/**
 * Целостность меню настроек.
 *
 * Владелец попросил «перешерстить пункт, чтобы в меню всё было чётко»
 * (08.08.2026), и вкладка «Игра» разъехалась на две. Перекладывание строк
 * между вкладками — ровно та правка, при которой настройка тихо теряется:
 * контрол уезжает из HTML, попап продолжает писать дефолт, а пользователь
 * видит, что тумблер «не работает». Эти тесты сверяют ТРИ списка:
 * DEFAULT_SETTINGS, контролы в popup.html и подписку попапа на change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

// Мок расширенческого окружения: @core/settings тянет polyfill, который в
// чистом jsdom отказывается грузиться («should only be loaded in a browser
// extension»), а нам нужны только ДЕФОЛТЫ настроек.
vi.mock("@core/env", () => ({
  browser: {
    storage: {
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: "test" },
  },
  isStoreInstall: () => false,
}));

import { DEFAULT_SETTINGS } from "@core/settings";
import { PLATE_POSITIONS } from "@shared/nick-plate";
import { CUSTOM_THEME, THEME_COLORS } from "@shared/button-theme";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(ROOT, "src/static/popup.html"), "utf8");
const popupSource = fs.readFileSync(path.join(ROOT, "src/popup/index.ts"), "utf8");

function doc(): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Настройки, у которых контрола в попапе нет и быть не должно: их значение
 * задаётся не тумблером (внутренние, хоткеи с собственным UI, поля OBS/Twitch
 * с отдельной вёрсткой).
 */
const NO_CONTROL = new Set([
  "obs_host",
  "obs_password",
  "obs_day_scene",
  "obs_night_scene",
  "twitch_channel",
  "pause_hotkey_code",
  "hotkey_role_fake",
  "hotkey_role_reset",
  "hotkey_role_hide",
  "note_frame_width",
  "match_stats_view",
  "stats_button_theme",
  "nick_plate_position",
]);

describe("вкладки и панели согласованы", () => {
  test("у каждой вкладки есть своя панель, и наоборот", () => {
    const d = doc();
    const tabs = Array.from(d.querySelectorAll(".tab")).map((el) => el.getAttribute("data-tab"));
    const panels = Array.from(d.querySelectorAll(".panel")).map((el) =>
      el.getAttribute("data-panel"),
    );
    expect(tabs.filter(Boolean).sort()).toEqual(panels.filter(Boolean).sort());
    expect(tabs, "вкладка «Иконки» появилась после перекройки меню").toContain("icons");
  });

  test("ровно одна вкладка и одна панель активны при открытии", () => {
    const d = doc();
    expect(d.querySelectorAll(".tab.active")).toHaveLength(1);
    expect(d.querySelectorAll(".panel.active")).toHaveLength(1);
    expect(d.querySelector(".tab.active")?.getAttribute("data-tab")).toBe(
      d.querySelector(".panel.active")?.getAttribute("data-panel"),
    );
  });

  test("id контролов уникальны: дубль после переноса строки читался бы первым", () => {
    const d = doc();
    const ids = Array.from(d.querySelectorAll("[id]")).map((el) => el.id);
    expect(ids.length - new Set(ids).size, `дубли: ${ids.filter((v, i) => ids.indexOf(v) !== i)}`).toBe(0);
  });
});

describe("ни одна настройка не потерялась при перекройке", () => {
  test("у каждой настройки есть контрол в попапе (кроме заведомо безконтрольных)", () => {
    const d = doc();
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (key) => !NO_CONTROL.has(key) && !d.getElementById(key),
    );
    expect(missing, `нет контролов: ${missing.join(", ")}`).toEqual([]);
  });

  test("контролы с select-настройками на месте и с нужными вариантами", () => {
    const d = doc();
    for (const id of ["stats_button_theme", "match_stats_view", "note_frame_width"]) {
      expect(d.getElementById(id), `${id} пропал из попапа`).not.toBeNull();
    }
    // Палитра кнопок — общий контракт попапа и content-скрипта: до 9.22.0 они
    // жили порознь и УЖЕ разошлись (в разметке не было половины значений, и
    // выбрать их было нечем).
    const theme = d.getElementById("stats_button_theme") as HTMLSelectElement;
    const themeValues = Array.from(theme.querySelectorAll("option")).map((o) =>
      o.getAttribute("value"),
    );
    for (const key of Object.keys(THEME_COLORS)) {
      expect(themeValues, `тема ${key} есть в палитре, но её нельзя выбрать`).toContain(key);
    }
    expect(themeValues, "«своя тема» — отдельный пункт").toContain(CUSTOM_THEME);
    expect(d.getElementById("stats_button_color"), "выбор своего цвета").not.toBeNull();
    const plate = d.getElementById("nick_plate_position") as HTMLSelectElement | null;
    expect(plate, "селект угла плашки").not.toBeNull();
    const values = Array.from(plate?.querySelectorAll("option") || []).map((o) =>
      o.getAttribute("value"),
    );
    // Список углов — общий контракт попапа и content-скрипта (shared/nick-plate).
    expect(values.sort()).toEqual([...PLATE_POSITIONS].sort());
  });

  test("каждый КОНТРОЛ настройки подписан на сохранение (change)", () => {
    // Баг 08.08.2026: `nick_plate_position` попал в разметку и в чтение, но
    // не в список подписки — селект менялся, значение не сохранялось, и
    // настройка выглядела «не работающей». Прошлая версия теста смотрела
    // только чекбоксы и такую дыру не видела.
    const d = doc();
    const list = /const simpleChangeIds = \[([\s\S]*?)\];/.exec(popupSource)?.[1] || "";
    expect(list, "список simpleChangeIds не найден").not.toBe("");
    const subscribed = new Set([...list.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));

    const controls = Array.from(
      d.querySelectorAll<HTMLElement>('input[type="checkbox"][id], select[id]'),
    )
      .map((el) => el.id)
      .filter((id) => id in DEFAULT_SETTINGS);
    // Контролы с СОБСТВЕННЫМ обработчиком change: они не просто сохраняют
    // (мастер-выключатель гасит интерфейс, OBS/Twitch подключаются и
    // раскрывают свои блоки). Для них проверяем, что обработчик есть.
    const OWN_HANDLER: Record<string, RegExp> = {
      extension_enabled: /\$<HTMLInputElement>\("extension_enabled"\)\?\.addEventListener\("change"/,
      obs_enabled: /obsEnabled\.addEventListener\("change"/,
      obs_floating_panel_enabled: /obsFloatingEnabled\.addEventListener\("change"/,
      obs_auto_mode_enabled: /obsAutoModeEnabled\.addEventListener\("change"/,
      twitch_chat_enabled: /twitchEnabled\.addEventListener\("change"/,
      twitch_floating_panel_enabled: /twitchFloatingEnabled\.addEventListener\("change"/,
      // Селекты сцен: их значения нельзя писать вслепую — пустой список
      // сцен означает «OBS не подключён», и сохранённый выбор надо беречь.
      obs_day_scene: /obsDayScene\.addEventListener\("change"/,
      obs_night_scene: /obsNightScene\.addEventListener\("change"/,
    };
    const missing = controls.filter((id) => {
      if (subscribed.has(id)) return false;
      const own = OWN_HANDLER[id];
      return !own || !own.test(popupSource);
    });
    expect(missing, `контролы без подписки на change: ${missing.join(", ")}`).toEqual([]);
  });

  test("каждый чекбокс попапа упомянут в коде попапа", () => {
    // Контрол, забытый в simpleChangeIds, выглядит рабочим и молча теряет
    // значение при закрытии попапа.
    const d = doc();
    const boxes = Array.from(d.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id]'))
      .map((el) => el.id)
      // Галочки очередей разведки и кнопок плитки обрабатываются пачкой —
      // они присутствуют в списке под своими же id, проверяем их так же.
      .filter((id) => id in DEFAULT_SETTINGS);
    const unsubscribed = boxes.filter((id) => !popupSource.includes(`"${id}"`));
    expect(unsubscribed, `не подписаны: ${unsubscribed.join(", ")}`).toEqual([]);
  });
});

describe("вкладка «Иконки» собрала всё про плитку игрока", () => {
  test("настройки плитки живут в одной вкладке, а не разбросаны", () => {
    const d = doc();
    const icons = d.querySelector('.panel[data-panel="icons"]') as HTMLElement;
    expect(icons).not.toBeNull();
    for (const id of [
      "stats_button_theme",
      "btn_stats_enabled",
      "btn_note_enabled",
      "btn_last_games_enabled",
      "btn_crossover_enabled",
      "btn_hide_video_enabled",
      "camera_rotate_enabled",
      "player_mute_enabled",
      "role_marker_enabled",
      "nick_colors_enabled",
      "note_frame_width",
      "compact_nicknames_enabled",
      "nick_plate_position",
      "open_nick_colors",
    ]) {
      expect(icons.querySelector(`#${id}`), `${id} должен быть во вкладке «Иконки»`).not.toBeNull();
    }
  });

  test("во вкладке «Игра» осталось только про саму игру", () => {
    const d = doc();
    const game = d.querySelector('.panel[data-panel="game"]') as HTMLElement;
    for (const id of ["pause_hotkey_enabled", "disable_webcam_clicks", "f5_refresh_fix_enabled"]) {
      expect(game.querySelector(`#${id}`), `${id} остаётся в «Игре»`).not.toBeNull();
    }
    for (const id of ["btn_stats_enabled", "nick_colors_enabled", "compact_nicknames_enabled"]) {
      expect(game.querySelector(`#${id}`), `${id} переехал в «Иконки»`).toBeNull();
    }
  });
});

describe("галочка = решение гейта", () => {
  test("загрузка настроек рисует галочку строго по === true, как FeatureManager", () => {
    // Truthy-мусор в хранилище (строка "true") рисовал галочку при выключенной
    // фиче: попап врал «всё включено», а кнопок на плитках не было (жалоба
    // 25.08.2026). Правило одно на попап и гейт: включено — только boolean true.
    expect(popupSource).toContain("el.checked = val === true");
    expect(popupSource).not.toMatch(/el\.checked = val;/);
  });
});
