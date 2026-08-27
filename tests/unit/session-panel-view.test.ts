// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game/1" }
/**
 * Настройки вида «Моего вечера» (просьба владельца 27.08.2026: «как у твитч
 * чата — фон, убирать заголовок, менять размеры нормально»).
 *
 * Панель настоящая (FloatingPanel не подменяем): предмет теста — именно её
 * хром и ресайз. Сеть и хранилище — моки.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      sync: { set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: "x" },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/own-user", () => ({ getOwnUserId: vi.fn(async () => 7) }));
vi.mock("@core/crossover", () => ({
  fetchFirstPage: vi.fn(async () => ({ rows: h.rows, total: h.rows.length, truncated: false })),
}));

import { sessionStatsFeature } from "@content/panels/session-stats-panel";

// В Node 22+ на globalThis живёт собственный экспериментальный localStorage
// (undefined без --localstorage-file) и затеняет браузерный — тот же шим, что
// в page-storage-trust.test.ts.
function storageShim(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}
Object.defineProperty(globalThis, "localStorage", { value: storageShim(), configurable: true });

const PREFS_KEY = "fp:session-stats:prefs";

/** Игра сессии: дата «сейчас», роль и ±MMR — чтобы список действительно рисовался. */
function game(id: number, diff: number): unknown {
  const d = new Date(Date.now() - id * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    id,
    role: { type: "civilian" },
    result: { code: diff > 0 ? "win" : "fail" },
    mmr: { mmr_diff: diff },
    // Сайт отдаёт UTC-строку без зоны.
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

const panelEl = () => document.querySelector(".session-stats-panel") as HTMLElement;
const headerEl = () => panelEl().querySelector(".fp-header") as HTMLElement;
const menuEl = () =>
  [...panelEl().children].find(
    (c) => (c as HTMLElement).style.width === "210px",
  ) as HTMLElement;
const headerBtn = (label: string) =>
  [...headerEl().querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const menuRowByLabel = (label: string) =>
  [...menuEl().children].find((r) => r.textContent?.startsWith(label)) as HTMLElement;

async function start(games = 3): Promise<void> {
  h.rows = Array.from({ length: games }, (_, i) => game(i + 1, i % 2 ? -20 : 25));
  await sessionStatsFeature.enable({ settings: {} } as never);
  // enable → loadManualReset → refresh: даём микрозадачам доехать.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});
afterEach(() => {
  sessionStatsFeature.disable();
  localStorage.clear();
});

describe("«Мой вечер»: настройки вида", () => {
  test("меню открывается «шестерёнкой» и знает актуальные значения", async () => {
    await start();
    expect(menuEl().style.display, "меню закрыто по умолчанию").toBe("none");
    headerBtn("⚙").click();
    expect(menuEl().style.display).toBe("block");
    expect(menuEl().textContent).toContain("Фон");
    expect(menuEl().textContent).toContain("Игр в списке");
    headerBtn("⚙").click();
    expect(menuEl().style.display, "повторное нажатие закрывает").toBe("none");
  });

  test("фон: ползунок красит живьём, а на диск пишет ОДИН раз — по отпусканию", async () => {
    await start();
    headerBtn("⚙").click();
    const range = menuRowByLabel("Фон").querySelector("input[type=range]") as HTMLInputElement;
    range.value = "20";
    range.dispatchEvent(new Event("input"));
    expect(panelEl().style.background, "предпросмотр применён").toMatch(/0\.2\b/);
    expect(localStorage.getItem(PREFS_KEY), "пока не сохранено").toBeNull();
    range.dispatchEvent(new Event("change"));
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) as string).bgOpacity).toBe(20);
  });

  test("заголовок убирается, и вместо него появляется полоска-ручка", async () => {
    await start();
    headerBtn("⚙").click();
    const check = menuRowByLabel("Заголовок").querySelector("input") as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent(new Event("change"));
    expect(headerEl().style.display).toBe("none");
    const strip = [...panelEl().children].find(
      (c) => (c as HTMLElement).style.cursor === "move" && (c as HTMLElement).style.height === "18px",
    ) as HTMLElement;
    expect(strip, "без ручки панель нечем таскать").toBeTruthy();
    expect(strip.style.display).toBe("flex");
    // «▾» на полоске возвращает заголовок.
    ([...strip.querySelectorAll("button")].find((b) => b.textContent === "▾") as HTMLButtonElement).click();
    expect(headerEl().style.display).toBe("flex");
    expect(strip.style.display).toBe("none");
  });

  test("«игр в списке» реально режет список", async () => {
    await start(8);
    expect(panelEl().querySelectorAll(".ss-row")).toHaveLength(8);
    headerBtn("⚙").click();
    const sel = menuRowByLabel("Игр в списке").querySelector("select") as HTMLSelectElement;
    sel.value = "5";
    sel.dispatchEvent(new Event("change"));
    expect(panelEl().querySelectorAll(".ss-row")).toHaveLength(5);
    expect(panelEl().textContent, "остальные — счётчиком").toContain("и ещё 3");
  });

  test("шрифт L крупнее S — и список перерисовывается сразу", async () => {
    await start(2);
    const body = panelEl().querySelector(".fp-body > div:last-child") as HTMLElement;
    headerBtn("⚙").click();
    const pick = (label: string) =>
      ([...menuRowByLabel("Шрифт").querySelectorAll("button")].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement).click();
    pick("L");
    const large = parseFloat(body.style.font);
    pick("S");
    const small = parseFloat(body.style.font);
    expect(large).toBeGreaterThan(small);
    expect(panelEl().querySelectorAll(".ss-row"), "строки на месте").toHaveLength(2);
  });

  test("«сквозь клики»: панель не ловит мышь, а замок остаётся кликабельным", async () => {
    await start();
    headerBtn("⚙").click();
    const check = menuRowByLabel("Сквозь клики").querySelector("input") as HTMLInputElement;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    expect(panelEl().style.pointerEvents).toBe("none");
    const chip = [...panelEl().children].find(
      (c) => (c as HTMLElement).textContent === "🔓",
    ) as HTMLElement;
    expect(chip.style.display).toBe("grid");
    expect(chip.style.pointerEvents, "иначе из режима не выйти").toBe("auto");
    expect(menuEl().style.display, "меню закрыто: закрыть его было бы нечем").toBe("none");
    chip.click();
    expect(panelEl().style.pointerEvents).toBe("");
  });

  test("настройки переживают перезапуск панели", async () => {
    await start();
    headerBtn("⚙").click();
    const check = menuRowByLabel("Заголовок").querySelector("input") as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent(new Event("change"));
    sessionStatsFeature.disable();
    await start();
    expect(headerEl().style.display, "выбор пользователя не забыт").toBe("none");
  });
});

describe("«Мой вечер»: чего нельзя лишиться", () => {
  test("скрытый заголовок не отбирает «обновить», «начать заново» и «закрыть»", async () => {
    // Adversarial 27.08.2026: полоска несла только ⚙ и ▾, то есть скрытие
    // заголовка отбирало три действия из четырёх, включая главное действие
    // фичи — «начать сессию заново».
    await start();
    headerBtn("⚙").click();
    const check = menuRowByLabel("Заголовок").querySelector("input") as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent(new Event("change"));
    const strip = [...panelEl().children].find(
      (c) => (c as HTMLElement).style.height === "18px",
    ) as HTMLElement;
    const labels = [...strip.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["⟳", "↺", "×", "⚙", "▾"]));
  });

  test("«сквозь клики» гасит и насечку ресайза — на прозрачном оверлее её видно зрителям", async () => {
    await start();
    headerBtn("⚙").click();
    const check = menuRowByLabel("Сквозь клики").querySelector("input") as HTMLInputElement;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    const grip = panelEl().querySelector(".fp-resize-se") as HTMLElement;
    expect(grip.style.display).toBe("none");
  });

  test("«фон 0%» убирает и подложку сводки, а не только рамку", async () => {
    await start(2);
    headerBtn("⚙").click();
    const range = menuRowByLabel("Фон").querySelector("input[type=range]") as HTMLInputElement;
    range.value = "0";
    range.dispatchEvent(new Event("input"));
    expect(panelEl().dataset.pnDim, "прозрачный режим объявлен").toBe("true");
    range.value = "95";
    range.dispatchEvent(new Event("input"));
    expect(panelEl().dataset.pnDim).toBe("false");
  });

  test("сводка честно говорит, насколько она свежая", async () => {
    await start(2);
    expect(panelEl().textContent).toContain("обновлено только что");
  });
});

describe("«Мой вечер»: размеры окна", () => {
  const handle = (dir: "e" | "s" | "se") =>
    panelEl().querySelector(`.fp-resize-${dir}`) as HTMLElement;

  /**
   * jsdom не считает layout: getBoundingClientRect всегда нулевой, и ресайз
   * стартовал бы от нулевой ширины. Подставляем коробку из инлайн-стилей —
   * ровно то, что в браузере вернул бы движок.
   */
  function withLayout(root: HTMLElement): void {
    root.getBoundingClientRect = () => {
      const w = parseFloat(root.style.width) || 0;
      const hgt = parseFloat(root.style.height) || 0;
      return { left: 0, top: 0, right: w, bottom: hgt, width: w, height: hgt, x: 0, y: 0 } as DOMRect;
    };
  }

  /** Протащить ручку: pointerdown → pointermove → pointerup. */
  function drag(el: HTMLElement, dx: number, dy: number): void {
    const mk = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as PointerEvent & { pointerId: number };
      Object.assign(e, { pointerId: 1, clientX: x, clientY: y });
      return e;
    };
    el.dispatchEvent(mk("pointerdown", 100, 100));
    window.dispatchEvent(mk("pointermove", 100 + dx, 100 + dy));
    window.dispatchEvent(mk("pointerup", 100 + dx, 100 + dy));
  }

  test("три ручки: край, низ и уголок (в невидимый угол 14×14 не попасть)", async () => {
    await start();
    expect(handle("e"), "правый край").toBeTruthy();
    expect(handle("s"), "нижний край").toBeTruthy();
    expect(handle("se"), "уголок").toBeTruthy();
    expect(handle("e").style.cursor).toBe("ew-resize");
    expect(handle("s").style.cursor).toBe("ns-resize");
  });

  test("правый край меняет ТОЛЬКО ширину, нижний — только высоту", async () => {
    await start();
    const root = panelEl();
    root.style.width = "250px";
    root.style.height = "320px";
    withLayout(root);
    drag(handle("e"), 60, 60);
    expect(root.style.height, "высота не тронута").toBe("320px");
    expect(parseInt(root.style.width, 10)).toBeGreaterThan(250);
    const w = root.style.width;
    drag(handle("s"), 40, 40);
    expect(root.style.width, "ширина не тронута").toBe(w);
    expect(parseInt(root.style.height, 10)).toBeGreaterThan(320);
  });

  test("окно уменьшилось — панель возвращается на экран, но сохранённая коробка цела", async () => {
    // Стример меняет разрешение под запись: панель, оставшаяся за краем,
    // недостижима. При этом подрезанную коробку на диск писать нельзя —
    // вернувшись на большой монитор, человек ждёт своё прежнее окно.
    await start();
    const root = panelEl();
    root.style.left = "900px";
    root.style.top = "600px";
    root.style.width = "250px";
    root.style.height = "320px";
    withLayout(root);
    localStorage.setItem(
      "fp:session-stats",
      JSON.stringify({ left: 900, top: 600, width: 250, height: 320 }),
    );
    Object.defineProperty(window, "innerWidth", { value: 640, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 480, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(parseInt(root.style.left, 10) + parseInt(root.style.width, 10)).toBeLessThanOrEqual(640);
    expect(parseInt(root.style.top, 10), "заголовок остался в экране").toBeLessThanOrEqual(480 - 32);
    expect(
      JSON.parse(localStorage.getItem("fp:session-stats") as string),
      "кламп по временному окну на диск не едет",
    ).toEqual({ left: 900, top: 600, width: 250, height: 320 });
  });

  test("сдвиг подрезанной панели НЕ закрепляет навязанный размер на диске", async () => {
    // Adversarial 27.08.2026: кламп на диск не писал, но первый же сдвиг
    // мышью сохранял ТЕКУЩИЙ (подрезанный) прямоугольник — обещание
    // обходилось за один жест. Двигаем панель на маленьком окне: на диск
    // обязано уехать новое положение и ПРЕЖНИЙ размер.
    localStorage.setItem(
      "fp:session-stats",
      JSON.stringify({ left: 100, top: 100, width: 400, height: 900 }),
    );
    await start();
    const root = panelEl();
    withLayout(root);
    const header = root.querySelector(".fp-header") as HTMLElement;
    const mk = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as PointerEvent & { pointerId: number };
      Object.assign(e, { pointerId: 2, clientX: x, clientY: y });
      return e;
    };
    header.dispatchEvent(mk("pointerdown", 50, 50));
    window.dispatchEvent(mk("pointermove", 70, 90));
    window.dispatchEvent(mk("pointerup", 70, 90));
    const saved = JSON.parse(localStorage.getItem("fp:session-stats") as string);
    expect(saved.height, "высота пользователя цела").toBe(900);
    expect(saved.width).toBe(400);
  });

  test("свежая установка: ресайз сначала прибивает якорь, иначе панель растёт ВЛЕВО", async () => {
    // Adversarial 27.08.2026: дефолтная позиция — right:16px без left. При
    // position:fixed рост width расширяет панель влево: правый край стоит,
    // уголок убегает из-под курсора. Перетаскивание якорь чинило, ресайз —
    // нет (половинчатый фикс).
    await start();
    const root = panelEl();
    expect(root.style.right, "дефолт — привязка к правому краю").toBe("16px");
    withLayout(root);
    root.style.width = "250px";
    root.style.height = "320px";
    drag(handle("e"), 60, 0);
    expect(root.style.right, "якорь переехал на левый край").toBe("auto");
    expect(root.style.left, "и left задан явно").not.toBe("");
  });

  test("панель нельзя утащить целиком за экран", async () => {
    // Adversarial 27.08.2026: pointer capture шлёт события и за пределами
    // окна, кламп же срабатывал только на resize — панель исчезала до F5.
    await start();
    const root = panelEl();
    root.style.left = "300px";
    root.style.top = "200px";
    root.style.width = "250px";
    root.style.height = "320px";
    withLayout(root);
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
    const header = root.querySelector(".fp-header") as HTMLElement;
    const mk = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as PointerEvent & { pointerId: number };
      Object.assign(e, { pointerId: 3, clientX: x, clientY: y });
      return e;
    };
    header.dispatchEvent(mk("pointerdown", 400, 250));
    window.dispatchEvent(mk("pointermove", 9000, 9000));
    window.dispatchEvent(mk("pointerup", 9000, 9000));
    expect(parseInt(root.style.left, 10), "край панели остался в окне").toBeLessThanOrEqual(1280 - 48);
    expect(parseInt(root.style.top, 10), "шапка остались в окне").toBeLessThanOrEqual(720 - 32);
  });

  test("меньше минимума панель не схлопывается", async () => {
    await start();
    const root = panelEl();
    root.style.width = "250px";
    root.style.height = "320px";
    withLayout(root);
    drag(handle("e"), -9999, 0);
    expect(parseInt(root.style.width, 10)).toBeGreaterThanOrEqual(210);
  });
});

describe("панель, скрытая тумблером, переживает изменение окна", () => {
  test("resize при display:none НЕ схлопывает коробку в угол", async () => {
    // Блокер adversarial 27.08.2026: hide() оставляет панель смонтированной,
    // а у display:none нулевой getBoundingClientRect — кламп читал нули и
    // писал минимальный размер в точке (0,0). Стример прячет чат, тянет край
    // окна, возвращает панель — она в левом верхнем углу 210×160.
    await start();
    const root = panelEl();
    root.style.left = "300px";
    root.style.top = "200px";
    root.style.width = "420px";
    root.style.height = "500px";
    root.style.display = "none"; // как делает hide()
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(root.style.width, "размер скрытой панели не трогаем").toBe("420px");
    expect(root.style.height).toBe("500px");
    expect(root.style.left).toBe("300px");
    expect(root.style.top).toBe("200px");
  });
});
