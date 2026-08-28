// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Страничные хранилища (localStorage/sessionStorage игровой вкладки)
 * принадлежат САЙТУ — источник недоверенный (AGENTS.md §5). Здесь собраны
 * property-тесты всех наших парсеров page-storage: любой вход обязан давать
 * валидный результат без исключений и без «рычагов», которых мы не давали
 * (аудит хрупкости 06.08.2026, раздел «Хранилища сайта»).
 */

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      sync: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));
vi.mock("@core/dom", () => ({
  onDomChange: vi.fn(() => () => undefined),
  paintNickEl: vi.fn(),
  safeClick: vi.fn(),
  isVisible: vi.fn(() => true),
  // Панель регистрирует свой корень: её собственные записи не должны будить
  // подписчиков (28.08.2026).
  registerOwnContainer: vi.fn(),
  unregisterOwnContainer: vi.fn(),
}));
vi.mock("@core/messaging", () => ({ onMessage: vi.fn(() => () => undefined), sendRuntime: vi.fn() }));
vi.mock("../../src/content/camera-flip", () => ({
  toggleFlipForPlayer: vi.fn(),
  isPlayerFlipped: vi.fn(),
  unflipAll: vi.fn(),
}));
vi.mock("../../src/content/match-data", () => ({ getMatchId: vi.fn() }));

import { FloatingPanel } from "@core/FloatingPanel";
import { parseFlippedPlayers } from "@content/features/player-notes";
import { loadPrefs } from "@content/panels/twitch-panel";
import { loadPrefs as loadSessionPrefs } from "@content/panels/session-stats-panel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// В Node 22+ на globalThis живёт СОБСТВЕННЫЙ экспериментальный localStorage
// (undefined без --localstorage-file), и в jsdom-среде vitest он затеняет
// браузерный: бары `localStorage` в продакшн-коде молча читали бы undefined.
// Подкладываем простой Storage-шим (продакшн пользуется только
// getItem/setItem/removeItem). sessionStorage не трогаем: нодовский in-memory
// вариант работает и без флага.
function storageShim(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  } as Storage;
}
Object.defineProperty(globalThis, "localStorage", { value: storageShim(), configurable: true });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
});

// ───────────────────────── pn_flipped_players ─────────────────────────

describe("parseFlippedPlayers: cap и отбраковка недоверенного sessionStorage", () => {
  const MAX_FLIPPED = 30; // пин значения из player-notes.ts: рост — только через ревью

  test("любая строка из sessionStorage не бросает и даёт капнутый Set строк", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constant(null)), (raw) => {
        const set = parseFlippedPlayers(raw);
        expect(set).toBeInstanceOf(Set);
        expect(set.size).toBeLessThanOrEqual(MAX_FLIPPED);
        for (const item of set) {
          expect(typeof item).toBe("string");
          expect(item).not.toBe("");
        }
      }),
    );
  });

  test("любой JSON-массив: остаются только непустые строки из входа, не больше cap", () => {
    const element = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer(),
      fc.constant(null),
      fc.boolean(),
      fc.array(fc.string({ maxLength: 3 }), { maxLength: 2 }),
      fc.record({ nick: fc.string({ maxLength: 5 }) }),
    );
    fc.assert(
      fc.property(fc.array(element, { maxLength: 120 }), (list) => {
        const set = parseFlippedPlayers(JSON.stringify(list));
        expect(set.size).toBeLessThanOrEqual(MAX_FLIPPED);
        const valid = list.filter((u): u is string => typeof u === "string" && u !== "");
        for (const item of set) expect(valid).toContain(item);
      }),
    );
  });

  test("гигантский массив сайта усечён до первых 30 валидных имён", () => {
    const names = Array.from({ length: 5000 }, (_, i) => `player-${i}`);
    const set = parseFlippedPlayers(JSON.stringify(names));
    expect(set.size).toBe(MAX_FLIPPED);
    expect(set.has("player-0")).toBe(true);
    expect(set.has("player-29")).toBe(true);
    expect(set.has("player-30")).toBe(false);
  });

  test.each(["not json", "null", "{}", '"solo"', "123", "[[]]", '{"length":1e9}'])(
    "не-массив/мусор %j даёт пустой Set",
    (raw) => {
      expect(parseFlippedPlayers(raw).size).toBe(0);
    },
  );
});

// ───────────────────────── FloatingPanel: кламп геометрии ─────────────────────────

class TrustProbePanel extends FloatingPanel {
  protected renderBody(): void {
    /* пустое тело — важна только геометрия */
  }
}

const PANEL_KEY = "trust-probe";
const PANEL_LS_KEY = `fp:${PANEL_KEY}`;

/** Панель «достижима»: заголовок в пределах вьюпорта либо дефолтный угол. */
function expectReachable(root: HTMLElement): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (root.style.right === "16px") {
    // дефолтная ветка restoreBox — box отвергнут целиком
    expect(root.style.top).toBe("80px");
    return;
  }
  const left = parseFloat(root.style.left);
  const top = parseFloat(root.style.top);
  const width = parseFloat(root.style.width);
  const height = parseFloat(root.style.height);
  for (const v of [left, top, width, height]) expect(Number.isFinite(v)).toBe(true);
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(width).toBeLessThanOrEqual(vw);
  expect(height).toBeLessThanOrEqual(vh);
  expect(left + width).toBeLessThanOrEqual(vw);
  expect(top).toBeLessThanOrEqual(vh - 32); // заголовок остаётся доступным
}

function mountWithRaw(raw: string | null): { panel: TrustProbePanel; root: HTMLElement } {
  localStorage.removeItem(PANEL_LS_KEY);
  if (raw !== null) localStorage.setItem(PANEL_LS_KEY, raw);
  const panel = new TrustProbePanel({ storageKey: PANEL_KEY, title: "probe" });
  panel.mount();
  const root = document.querySelector<HTMLElement>(".fp-panel");
  expect(root).not.toBeNull();
  return { panel, root: root! };
}

describe("FloatingPanel: геометрия из localStorage сайта кламплена по вьюпорту", () => {
  test.each([
    ["гигантский box уносил панель за экран", '{"left":1e9,"top":1e9,"width":1e9,"height":1e9}'],
    ["отрицательные координаты", '{"left":-5000,"top":-5000,"width":300,"height":200}'],
    ["Infinity через JSON-грамматику 1e999", '{"left":1e999,"top":10,"width":300,"height":200}'],
    ["нулевые размеры", '{"left":10,"top":10,"width":0,"height":0}'],
    ["строки вместо чисел", '{"left":"10","top":"10","width":"300","height":"200"}'],
    ["не-объект", "[1,2,3]"],
    ["мусор", "не json вовсе"],
  ])("%s", (_name, raw) => {
    const { panel, root } = mountWithRaw(raw);
    try {
      expectReachable(root);
    } finally {
      panel.unmount();
    }
  });

  test("property: произвольный box из page-storage не прячет панель", () => {
    const numToken = fc.oneof(
      fc.double({ noNaN: true, noDefaultInfinity: true }).map((v) => JSON.stringify(v)),
      fc.constantFrom("1e999", "-1e999", "null", "true", '"20"', "0", "-0.0"),
    );
    const boxRaw = fc
      .tuple(numToken, numToken, numToken, numToken)
      .map(([l, t, w, h]) => `{"left":${l},"top":${t},"width":${w},"height":${h}}`);
    fc.assert(
      fc.property(fc.oneof(boxRaw, fc.string()), (raw) => {
        const { panel, root } = mountWithRaw(raw);
        try {
          expectReachable(root);
        } finally {
          panel.unmount();
        }
      }),
    );
  });
});

// ───────────────────────── twitch-panel prefs ─────────────────────────

const PREFS_KEY = "fp:twitch-panel:prefs"; // пин имени ключа: смена = миграция

const DEFAULTS = {
  headerHidden: false,
  bgOpacity: 95,
  fontSize: "m",
  timestamps: true,
  highlightMentions: true,
  clickThrough: false,
  visibleCount: 10,
};

function expectValidPrefs(p: ReturnType<typeof loadPrefs>): void {
  expect(Object.keys(p).sort()).toEqual(Object.keys(DEFAULTS).sort());
  expect(typeof p.headerHidden).toBe("boolean");
  expect(Number.isInteger(p.bgOpacity)).toBe(true);
  expect(p.bgOpacity).toBeGreaterThanOrEqual(0);
  expect(p.bgOpacity).toBeLessThanOrEqual(100);
  expect(["s", "m", "l"]).toContain(p.fontSize);
  expect(typeof p.timestamps).toBe("boolean");
  expect(typeof p.highlightMentions).toBe("boolean");
  expect(typeof p.clickThrough).toBe("boolean");
  expect([3, 5, 10, 25, 50]).toContain(p.visibleCount);
}

describe("twitch-panel loadPrefs: схема против недоверенного localStorage", () => {
  test("чужие ключи и неверные типы не проходят схему", () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        junk: 1,
        onmessage: "alert(1)",
        headerHidden: 1,
        bgOpacity: "99",
        fontSize: "xl",
        timestamps: "no",
        visibleCount: 7,
      }),
    );
    const p = loadPrefs();
    // timestamps: "no" !== false → true по контракту «только явный false выключает»
    expect(p).toEqual({ ...DEFAULTS });
  });

  test.each([
    [1e9, 100],
    [-5, 0],
    [42.4, 42],
  ])("bgOpacity %d клампится в %d", (input, expected) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ bgOpacity: input }));
    expect(loadPrefs().bgOpacity).toBe(expected);
  });

  test("унаследованные через prototype поля НЕ считаются выбором пользователя", () => {
    // Значения валидных типов: до Object.hasOwn они проходили схему.
    const proto = Object.prototype as Record<string, unknown>;
    localStorage.setItem(PREFS_KEY, "{}");
    proto.clickThrough = true;
    proto.bgOpacity = 0;
    proto.fontSize = "l";
    proto.headerHidden = true;
    proto.timestamps = false;
    proto.highlightMentions = false;
    proto.visibleCount = 50;
    try {
      expect(loadPrefs()).toEqual({ ...DEFAULTS });
    } finally {
      for (const k of Object.keys(DEFAULTS)) delete proto[k];
    }
  });

  test('ключ "__proto__" в JSON остаётся собственным полем и не загрязняет прототип', () => {
    localStorage.setItem(PREFS_KEY, '{"__proto__":{"clickThrough":true}}');
    expect(loadPrefs()).toEqual({ ...DEFAULTS });
    expect(({} as Record<string, unknown>).clickThrough).toBeUndefined();
  });

  test("property: произвольный JSON никогда не бросает и всегда даёт валидную схему", () => {
    const fieldValue = fc.oneof(
      fc.boolean(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string({ maxLength: 8 }),
      fc.constant(null),
      fc.constantFrom<unknown>("s", "m", "l", 3, 5, 10, 25, 50),
    );
    const objectRaw = fc
      .dictionary(
        fc.constantFrom(...Object.keys(DEFAULTS), "junk", "constructor"),
        fieldValue,
        { maxKeys: 9 },
      )
      .map((o) => JSON.stringify(o));
    fc.assert(
      fc.property(fc.oneof(objectRaw, fc.string()), (raw) => {
        localStorage.setItem(PREFS_KEY, raw);
        expectValidPrefs(loadPrefs());
      }),
    );
  });
});

describe("session-stats loadPrefs: та же схема против недоверенного localStorage", () => {
  // Панель «Мой вечер» получила настройки вида 27.08.2026 и читает тот же
  // общий санитайзер, что и чат. Свой набор ключей — свой property-тест:
  // общий модуль не отвечает за поле rowsLimit.
  const SESSION_KEY = "fp:session-stats:prefs";
  const SESSION_DEFAULTS = {
    headerHidden: false,
    bgOpacity: 95,
    fontSize: "m",
    clickThrough: false,
    rowsLimit: 12,
  };

  afterEach(() => localStorage.removeItem(SESSION_KEY));

  test("чужие ключи и неверные типы не проходят схему", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ junk: 1, headerHidden: 1, bgOpacity: "99", fontSize: "xl", rowsLimit: 7 }),
    );
    expect(loadSessionPrefs()).toEqual(SESSION_DEFAULTS);
  });

  test("унаследованные через prototype поля НЕ считаются выбором пользователя", () => {
    const proto = Object.prototype as Record<string, unknown>;
    localStorage.setItem(SESSION_KEY, "{}");
    proto.clickThrough = true;
    proto.headerHidden = true;
    proto.bgOpacity = 0;
    proto.rowsLimit = 50;
    try {
      expect(loadSessionPrefs()).toEqual(SESSION_DEFAULTS);
    } finally {
      for (const k of Object.keys(SESSION_DEFAULTS)) delete proto[k];
    }
  });

  test("property: произвольный JSON никогда не бросает и всегда даёт валидную схему", () => {
    const fieldValue = fc.oneof(
      fc.boolean(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string({ maxLength: 8 }),
      fc.constant(null),
      fc.constantFrom<unknown>("s", "m", "l", 5, 10, 12, 25, 50),
    );
    const objectRaw = fc
      .dictionary(fc.constantFrom(...Object.keys(SESSION_DEFAULTS), "junk"), fieldValue, {
        maxKeys: 8,
      })
      .map((o) => JSON.stringify(o));
    fc.assert(
      fc.property(fc.oneof(objectRaw, fc.string()), (raw) => {
        localStorage.setItem(SESSION_KEY, raw);
        const p = loadSessionPrefs();
        expect(Object.keys(p).sort()).toEqual(Object.keys(SESSION_DEFAULTS).sort());
        expect(Number.isInteger(p.bgOpacity)).toBe(true);
        expect(p.bgOpacity).toBeGreaterThanOrEqual(0);
        expect(p.bgOpacity).toBeLessThanOrEqual(100);
        expect(["s", "m", "l"]).toContain(p.fontSize);
        expect([5, 10, 12, 25, 50]).toContain(p.rowsLimit);
        expect(typeof p.headerHidden).toBe("boolean");
        expect(typeof p.clickThrough).toBe("boolean");
      }),
    );
  });
});

// ───────────────────────── core/log: пороги и page-storage ─────────────────────────

describe("core/log: page-storage управляет ТОЛЬКО консольным порогом", () => {
  afterEach(() => {
    localStorage.removeItem("polemica:loglevel");
    localStorage.removeItem("polemica:buflevel");
  });

  test("polemica:loglevel=debug открывает консоль, но буфер остаётся на info", async () => {
    localStorage.setItem("polemica:loglevel", "debug");
    vi.resetModules();
    const { log } = await import("@core/log");
    log.setPersist(false);
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    log.debug("trust", "console-only");
    expect(dbg).toHaveBeenCalledTimes(1);
    // debug ниже фиксированного буферного info — в файл поддержки не идёт
    expect(log.getBuffer()).toEqual([]);
    log.info("trust", "buffered");
    expect(log.getBuffer()).toHaveLength(1);
  });

  test("сайтовый polemica:buflevel игнорируется полностью", async () => {
    localStorage.setItem("polemica:buflevel", "debug");
    vi.resetModules();
    const { log } = await import("@core/log");
    log.setPersist(false);
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    log.debug("trust", "site tried to widen the buffer");
    expect(log.getBuffer()).toEqual([]); // буфер не расширился
    expect(dbg).not.toHaveBeenCalled(); // и консольный порог остался warn
  });

  test("НЕГАТИВНЫЙ инвариант: исходник log.ts не читает polemica:buflevel", () => {
    // Сайт однажды включал себе сбор чужих данных через buflevel (аудит
    // безопасности 01.08.2026, находка 10) — обратной дороги нет.
    const source = readSource("src/core/log.ts");
    expect(source).toMatch(/let bufferLevel: Level = "info"/);
    expect(source).not.toMatch(/getItem\([^)]*buflevel/);
    const consoleLevelReads = [...source.matchAll(/resolveConsoleLevel\(\s*["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(consoleLevelReads).toEqual(["polemica:loglevel"]);
  });
});
