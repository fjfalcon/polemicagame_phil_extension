// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Сворачивание ников «гармошкой» (просьба владельца 07.08.2026).
 *
 * Мутационный критерий: каждый тест валит конкретную поломку — свёрнутое
 * состояние без CSS, клик, уходящий сайту (открывает превью игрока),
 * неидемпотентная запись в DOM, пережившие выключение стили и атрибуты.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let domSubscriberRaw: ((records: MutationRecord[]) => void) | null = null;
vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: (records: MutationRecord[]) => void) => {
    domSubscriberRaw = cb;
    return () => {
      domSubscriberRaw = null;
    };
  }),
  safeClick: vi.fn(),
  isVisible: () => true,
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ROOT_CLASS,
  nickPlateFeature,
  playerIdFromNumberEl,
  resolveToggleTarget,
} from "@content/features/nick-plate";
import type { Settings } from "@shared/types";

const ctx = { settings: { compact_nicknames_enabled: true } as Settings };
const posCtx = (position: string) => ({
  settings: { compact_nicknames_enabled: false, nick_plate_position: position } as Settings,
});

/** Стол сайта: плитки с плашкой «номер + ник + бейджи». */
function table(count = 3): void {
  document.body.innerHTML = Array.from({ length: count }, (_, i) => {
    return `
      <div class="player desktop-version">
        <div class="player__info info">
          <div class="player-number player-${i}">${i + 1}</div>
          <span class="info__name">Ник${i + 1}</span>
          <img class="info__prime" alt="Prime Icon">
        </div>
      </div>`;
  }).join("");
}

const infoAt = (i: number) =>
  document.querySelectorAll<HTMLElement>(".player__info")[i] as HTMLElement;
const numberAt = (i: number) =>
  document.querySelectorAll<HTMLElement>(".player-number")[i] as HTMLElement;
const styleEl = () => document.getElementById("pn-nick-plate-styles");

/** Батч мутаций: сайт пересоздал узлы (childList) — именно его мы слушаем. */
function fireChildList(): void {
  domSubscriberRaw?.([{ type: "childList" } as unknown as MutationRecord]);
}
/** Батч только с атрибутами — фича обязана его игнорировать. */
function fireAttributes(): void {
  domSubscriberRaw?.([{ type: "attributes" } as unknown as MutationRecord]);
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

afterEach(() => {
  nickPlateFeature.disable();
  domSubscriberRaw = null;
});

describe("ряд кнопок в колонке угла (notes.css)", () => {
  test("в колонке ряд лежит В ПОТОКЕ, а вне её — по-прежнему абсолютом", () => {
    // Абсолютный ряд в колонке лёг бы поверх плашки рейтинга сайта — ровно
    // жалоба владельца 08.08.2026. Правило-исключение сторожим здесь, потому
    // что notes.css грузится браузером и юнитами иначе не покрыт.
    const css = fs.readFileSync(path.join(ROOT, "src/static/notes.css"), "utf8");
    const inFlow = /\.player__botleftmenu > \.player-icons\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(inFlow, "правила «в потоке» нет").toBeTruthy();
    expect(inFlow).toMatch(/position:\s*static\s*!important/);
    // Фолбэк для плиток без колонки обязан остаться.
    expect(css).toMatch(/\n\.player-icons\s*\{[^}]*position:\s*absolute/);
  });
});

describe("чистые функции разбора плашки", () => {
  test("id берётся из класса player-N, а не из подписи", () => {
    // Текст плашки — это N+1 (человеку удобнее с единицы), и путать их
    // нельзя: по id сайт различает плитки.
    table(3);
    expect(playerIdFromNumberEl(numberAt(0))).toBe("0");
    expect(numberAt(0).textContent).toBe("1");
    expect(playerIdFromNumberEl(numberAt(2))).toBe("2");
  });

  test("посторонние классы номером не считаются", () => {
    const el = document.createElement("div");
    el.className = "player-number player-abc playerx-1";
    expect(playerIdFromNumberEl(el)).toBeNull();
  });

  test("цель переключения — только клик по номеру внутри плашки", () => {
    table(2);
    expect(resolveToggleTarget(numberAt(1))?.id).toBe("1");
    // Клик по нику — не наш: там сайтовое превью игрока.
    const nick = document.querySelector<HTMLElement>(".info__name") as HTMLElement;
    expect(resolveToggleTarget(nick)).toBeNull();
    // Номер вне плашки (тултип статистики рисует такой же класс) — не наш.
    const stray = document.createElement("span");
    stray.className = "player-number player-3";
    document.body.append(stray);
    expect(resolveToggleTarget(stray)).toBeNull();
  });
});

describe("включение и выключение", () => {
  test("включение вешает класс на <html> и внедряет стили гармошки", () => {
    table();
    nickPlateFeature.enable(ctx);
    expect(document.documentElement.classList.contains(ROOT_CLASS)).toBe(true);
    const css = styleEl()?.textContent || "";
    expect(css).toContain(".info__name");
    expect(css).toMatch(/max-width:\s*0/);
    // Именно НИК обязан возвращаться, и именно НЕНУЛЕВОЙ ширины: проверка
    // одного селектора оставляла живым мутант `max-width: 240px → 0`, при
    // котором клик по номеру больше ничего не показывает, а тесты зелёные
    // (ревью 08.08.2026, сбежавший мутант).
    const openRule = /\[data-pn-nick="open"\][^{]*\.info__name[^{]*\{([^}]*)\}/.exec(css)?.[1] || "";
    expect(openRule, "правило разворота ника не найдено").not.toBe("");
    const openWidth = /max-width:\s*(\d+)px/.exec(openRule)?.[1];
    expect(Number(openWidth), "развёрнутый ник обязан получать ширину").toBeGreaterThan(0);
    expect(openRule).toMatch(/opacity:\s*1/);
  });

  test("свёрнутая плашка ужимается ДО номера: гасим отступы родителя", () => {
    // Ревью 08.08.2026 (блокер): расстояния держит сам `.player__info`
    // (gap .438rem + правый padding .684rem), а скрытые дети остаются
    // флекс-айтемами. Без обнуления у родителя от плашки оставалась пустая
    // полоса шире самого номера.
    table();
    nickPlateFeature.enable(ctx);
    const css = styleEl()?.textContent || "";
    const rule = /\.pn-compact-nicks \.player__info:not\(\[data-pn-nick="open"\]\)\s*\{([^}]*)\}/.exec(
      css,
    )?.[1];
    expect(rule, "правила для свёрнутой плашки нет").toBeTruthy();
    // !important обязателен: селектор сайта специфичнее нашего.
    expect(rule).toMatch(/gap:\s*0\s*!important/);
    expect(rule).toMatch(/padding-right:[^;]*!important/);
  });

  test("выключение снимает класс, стили и все развороты", () => {
    table();
    nickPlateFeature.enable(ctx);
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(0).getAttribute("data-pn-nick")).toBe("open");

    nickPlateFeature.disable();
    expect(document.documentElement.classList.contains(ROOT_CLASS)).toBe(false);
    expect(styleEl()).toBeNull();
    expect(infoAt(0).hasAttribute("data-pn-nick")).toBe(false);
  });

  test("повторное включение не плодит второй <style>", () => {
    table();
    nickPlateFeature.enable(ctx);
    nickPlateFeature.disable();
    nickPlateFeature.enable(ctx);
    expect(document.querySelectorAll("#pn-nick-plate-styles")).toHaveLength(1);
  });
});

describe("гармошка по клику", () => {
  test("клик по номеру разворачивает и сворачивает обратно", () => {
    table();
    nickPlateFeature.enable(ctx);
    numberAt(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(1).getAttribute("data-pn-nick")).toBe("open");
    expect(infoAt(0).hasAttribute("data-pn-nick"), "сосед не тронут").toBe(false);

    numberAt(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(1).hasAttribute("data-pn-nick")).toBe(false);
  });

  test("клик по номеру НЕ доходит до сайта — иначе откроется превью игрока", () => {
    // На .player__info висит сайтовый onClick (showPlayerPreview). Без
    // остановки всплытия каждое сворачивание открывало бы чужое окно.
    table();
    const sitePreview = vi.fn();
    infoAt(0).addEventListener("click", sitePreview);
    nickPlateFeature.enable(ctx);
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sitePreview).not.toHaveBeenCalled();
  });

  test("клик по нику сайту достаётся: превью игрока остаётся рабочим", () => {
    table();
    const sitePreview = vi.fn();
    infoAt(0).addEventListener("click", sitePreview);
    nickPlateFeature.enable(ctx);
    document
      .querySelector<HTMLElement>(".info__name")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sitePreview).toHaveBeenCalledTimes(1);
  });

  test("модель 26.08.2026: клик по номеру сворачивает и при ВЫКЛЮЧЕННОМ дефолте", () => {
    // Настройка — только стартовое состояние стола; механика клика всегда.
    table();
    const sitePreview = vi.fn();
    infoAt(0).addEventListener("click", sitePreview);
    nickPlateFeature.enable(ctx);
    nickPlateFeature.update?.({
      settings: { compact_nicknames_enabled: false } as Settings,
    });
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sitePreview, "клик по номеру наш, до превью сайта не доходит").not.toHaveBeenCalled();
    expect(infoAt(0).getAttribute("data-pn-nick"), "исключение к развёрнутому дефолту").toBe(
      "closed",
    );
    // Второй клик возвращает дефолт.
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(0).hasAttribute("data-pn-nick")).toBe(false);
  });

  test("тумблер дефолта СБРАСЫВАЕТ ручные исключения: состояние ставится единым", () => {
    table();
    nickPlateFeature.enable(ctx); // дефолт свёрнут
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(0).getAttribute("data-pn-nick")).toBe("open");
    nickPlateFeature.update?.({
      settings: { compact_nicknames_enabled: false } as Settings,
    });
    expect(infoAt(0).hasAttribute("data-pn-nick"), "исключение прошлого дефолта снято").toBe(
      false,
    );
  });

  test("закрытое исключение переживает пересборку плитки (childList-ресинк)", () => {
    table();
    nickPlateFeature.enable({
      settings: { compact_nicknames_enabled: false } as Settings,
    });
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(0).getAttribute("data-pn-nick")).toBe("closed");
    infoAt(0).removeAttribute("data-pn-nick"); // Vue пересоздал узел
    domSubscriberRaw?.([{ type: "childList" } as unknown as MutationRecord]);
    expect(infoAt(0).getAttribute("data-pn-nick"), "тик вернул исключение").toBe("closed");
  });
});

describe("угол плашки", () => {
  const css = () => styleEl()?.textContent || "";

  test("«как на сайте»: классов на <html> нет; стили есть только ради клика", () => {
    // Модель 26.08.2026: клик-сворачивание всегда доступно, поэтому <style>
    // (курсор + правила исключений) инжектится и в дефолте — но корневых
    // классов нет, и внешний вид стола не тронут.
    table();
    nickPlateFeature.enable({
      settings: { compact_nicknames_enabled: false, nick_plate_position: "default" } as Settings,
    });
    expect(document.documentElement.className).toBe("");
    expect(styleEl(), "стили клика присутствуют").not.toBeNull();
    expect(css()).toContain("cursor: pointer");
  });

  test.each(["top-left", "top-right", "bottom-right"])(
    "угол %s: класс на <html> и правило для контейнера плашки",
    (pos) => {
      table();
      nickPlateFeature.enable(posCtx(pos));
      expect(document.documentElement.classList.contains(`pn-nick-pos-${pos}`)).toBe(true);
      // Двигаем КОНТЕЙНЕР: сама плашка внутри absolute-родителя, и её
      // собственный absolute считался бы от него, а не от плитки.
      expect(css()).toMatch(
        new RegExp(`\\.pn-nick-pos-${pos} \\.player__botleftmenu\\s*\\{[^}]+\\}`),
      );
    },
  );

  test("верхние углы уводят плашку вниз — под кнопки сайта", () => {
    // В верхних углах у сайта уже стоят меню (готовность слева, фолы и «…»
    // справа): без отступа наша плашка легла бы поверх них.
    table();
    nickPlateFeature.enable(posCtx("top-left"));
    const rule = /\.pn-nick-pos-top-left \.player__botleftmenu\s*\{([^}]+)\}/.exec(css())?.[1] || "";
    expect(rule).toMatch(/top:\s*3\.25rem/);
    expect(rule).toMatch(/bottom:\s*auto/);
  });

  test.each(["top-left", "top-right"])(
    "угол %s: ряд кнопок переставляется ПОД плашку flex-порядком",
    (pos) => {
      // Просьба владельца 08.08.2026: «если плашка сверху — кнопки снизу».
      // Ряд лежит в потоке колонки ПЕРЕД плашкой, поэтому достаточно order.
      table();
      nickPlateFeature.enable(posCtx(pos));
      const rule = new RegExp(
        `\\.pn-nick-pos-${pos} \\.player__botleftmenu > \\.player-icons\\s*\\{([^}]*)\\}`,
      ).exec(css())?.[1];
      expect(rule, "правила порядка для ряда кнопок нет").toBeTruthy();
      expect(rule).toMatch(/order:\s*1/);
    },
  );

  test.each(["top-left", "top-right"])(
    "угол %s: пустой угол сайта — плашка прижимается к краю, а не висит посередине",
    (pos) => {
      // Жалоба владельца 08.08.2026: в лобби до готовности верхний левый
      // угол пуст, и отступ «под кнопки сайта» выглядел как зависание.
      table();
      nickPlateFeature.enable(posCtx(pos));
      const menu = pos === "top-left" ? "player__topleftmenu" : "player__toprightmenu";
      const rule = new RegExp(
        `\\.pn-nick-pos-${pos} \\.player:not\\(:has\\(\\.${menu} > \\*\\)\\) \\.player__botleftmenu\\s*\\{([^}]*)\\}`,
      ).exec(css())?.[1];
      expect(rule, "правила «пустой угол» нет").toBeTruthy();
      expect(rule).toMatch(/top:\s*0\.625rem/);
    },
  );

  test("нижний угол ряд кнопок не переставляет — там он и так над плашкой", () => {
    // Стиль инжектится один на все углы, активный выбирает класс на <html>,
    // поэтому проверяем ОТСУТСТВИЕ правила именно для нижнего угла — иначе
    // ряд уехал бы под плашку, к самому краю плитки.
    table();
    nickPlateFeature.enable(posCtx("bottom-right"));
    expect(css()).not.toMatch(
      /\.pn-nick-pos-bottom-right \.player__botleftmenu > \.player-icons/,
    );
    // И «пустой угол» тоже не про низ: там кнопок сайта нет.
    expect(css()).not.toMatch(/\.pn-nick-pos-bottom-right \.player:not\(:has/);
  });

  test("угол «снизу слева» не вешает позиционных классов — вид сайта", () => {
    table();
    nickPlateFeature.enable(posCtx("default"));
    // Стили клика есть всегда (модель 26.08), а классов позиции нет.
    expect(document.documentElement.className).toBe("");
  });

  test("мусор в настройке — угол сайта, а не пустой экран", () => {
    table();
    nickPlateFeature.enable(posCtx("нет-такого-угла"));
    expect(document.documentElement.className).toBe("");
  });

  test("смена угла на лету: старый класс снимается, новый встаёт", () => {
    table();
    nickPlateFeature.enable(posCtx("top-left"));
    nickPlateFeature.update?.(posCtx("bottom-right"));
    expect(document.documentElement.classList.contains("pn-nick-pos-top-left")).toBe(false);
    expect(document.documentElement.classList.contains("pn-nick-pos-bottom-right")).toBe(true);
  });

  test("выключение угла возвращает вид сайта (классы сняты)", () => {
    table();
    nickPlateFeature.enable(posCtx("top-right"));
    nickPlateFeature.update?.(posCtx("default"));
    expect(document.documentElement.className).toBe("");
  });

  test("сворачивание и угол независимы: работают вместе", () => {
    table();
    nickPlateFeature.enable({
      settings: {
        compact_nicknames_enabled: true,
        nick_plate_position: "bottom-right",
      } as Settings,
    });
    expect(document.documentElement.classList.contains(ROOT_CLASS)).toBe(true);
    expect(document.documentElement.classList.contains("pn-nick-pos-bottom-right")).toBe(true);
  });

  test("выключение дефолта на лету снимает исключения; клик остаётся нашим", () => {
    table();
    nickPlateFeature.enable(ctx);
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(0).getAttribute("data-pn-nick")).toBe("open");

    nickPlateFeature.update?.({
      settings: { compact_nicknames_enabled: false, nick_plate_position: "default" } as Settings,
    });
    expect(infoAt(0).hasAttribute("data-pn-nick"), "исключения сняты").toBe(false);
    // Модель 26.08: механика клика не выключается вместе с дефолтом.
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(0).getAttribute("data-pn-nick"), "клик по-прежнему наш").toBe("closed");
  });
});

describe("живучесть и идемпотентность", () => {
  test("перерисовка Vue стёрла атрибут — следующий тик вернёт", () => {
    table();
    nickPlateFeature.enable(ctx);
    numberAt(2).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(infoAt(2).getAttribute("data-pn-nick")).toBe("open");

    // Сайт перерисовал стол: атрибуты слетели, узлы новые.
    table();
    fireChildList();
    expect(infoAt(2).getAttribute("data-pn-nick")).toBe("open");
  });

  test("батч только с атрибутами игнорируется: смотрим на childList", () => {
    // Атрибутные мутации (таймеры, индикаторы речи) — большинство на игровой
    // странице, а наш `data-pn-nick` наблюдатель не видит вовсе: снять его
    // может только пересоздание узла (ревью 08.08.2026).
    table();
    nickPlateFeature.enable(ctx);
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const qs = vi.spyOn(document, "querySelectorAll");
    try {
      fireAttributes();
      expect(qs, "атрибутный батч не должен вызывать пересканирование").not.toHaveBeenCalled();
      fireChildList();
      expect(qs).toHaveBeenCalled();
    } finally {
      qs.mockRestore();
    }
  });

  test("пока никто не развёрнут, тик вообще не трогает DOM", () => {
    // Штатный режим фичи — «всё свёрнуто»: Set пуст, синхронизировать нечего.
    table();
    nickPlateFeature.enable(ctx);
    const qs = vi.spyOn(document, "querySelectorAll");
    try {
      fireChildList();
      expect(qs).not.toHaveBeenCalled();
    } finally {
      qs.mockRestore();
    }
  });

  test("бейдж с классом player-N внутри плашки ручкой не становится", () => {
    // Гард «ручка = только номер» обязан быть СТРУКТУРНЫМ: сайт уже раздаёт
    // классы player-N нескольким компонентам, и новый бейдж с таким классом
    // не должен отбирать клик у превью игрока (ревью 08.08.2026).
    table();
    const nick = document.querySelector<HTMLElement>(".info__name") as HTMLElement;
    nick.classList.add("player-5");
    expect(resolveToggleTarget(nick)).toBeNull();
  });

  test("тик без изменений НИЧЕГО не пишет в DOM (инвариант §4 п.1)", () => {
    table();
    nickPlateFeature.enable(ctx);
    numberAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const setSpy = vi.spyOn(Element.prototype, "setAttribute");
    const removeSpy = vi.spyOn(Element.prototype, "removeAttribute");
    try {
      fireChildList();
      fireChildList();
      expect(setSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      setSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
