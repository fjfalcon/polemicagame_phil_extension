// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: "x", getManifest: () => ({ version: "9.5.0" }) },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn(() => () => {}),
  sendRuntime: vi.fn(async () => ({ success: true })),
  broadcastToGameTabs: vi.fn(),
  sendToActiveTabStrict: vi.fn(),
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

/**
 * Бюджеты перф-аудита 06.08.2026 — юнит-половина (PERF-1, PERF-10).
 * Инструментальные бюджеты остальных фич — в соседних файлах фич.
 */
import {
  classifyPlayerMutations,
  shouldRunMutationPass,
} from "../../src/content/features/player-notes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function rec(init: {
  target: Node;
  added?: Node[];
  removed?: Node[];
  type?: string;
}): MutationRecord {
  return {
    type: init.type ?? "childList",
    target: init.target,
    addedNodes: (init.added ?? []) as unknown as NodeList,
    removedNodes: (init.removed ?? []) as unknown as NodeList,
  } as unknown as MutationRecord;
}

describe("PERF-1: классификация мутаций плиток", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div class="players"><div class="player" id="p1"><div class="inner"></div></div></div>`;
  });

  test("добавление целой плитки — identity (немедленный проход)", () => {
    const tile = document.createElement("div");
    tile.className = "player";
    expect(classifyPlayerMutations([rec({ target: document.body, added: [tile] })])).toBe(
      "identity",
    );
  });

  test("шевеление ВНУТРИ плитки — inner (дросселируется)", () => {
    const inner = document.querySelector("#p1 .inner") as Element;
    const span = document.createElement("span");
    expect(classifyPlayerMutations([rec({ target: inner, added: [span] })])).toBe("inner");
  });

  test("посторонний childList — none", () => {
    const foreign = document.createElement("div");
    document.body.appendChild(foreign);
    expect(classifyPlayerMutations([rec({ target: foreign, added: [] })])).toBe("none");
  });

  test("attr-мутации не считаются вовсе", () => {
    const tile = document.getElementById("p1") as Element;
    expect(classifyPlayerMutations([rec({ target: tile, type: "attributes" })])).toBe("none");
  });

  test("гейт: identity — всегда, inner — не чаще раза в секунду", () => {
    const now = 1_800_000_000_000;
    expect(shouldRunMutationPass("identity", now, now - 10)).toBe(true);
    expect(shouldRunMutationPass("inner", now, now - 10), "свежий проход — inner ждёт").toBe(false);
    expect(shouldRunMutationPass("inner", now, now - 1500)).toBe(true);
    expect(shouldRunMutationPass("none", now, 0)).toBe(false);
  });
});

describe("PERF-10: скрытая вкладка не теряет flush за замороженным rAF", () => {
  let realRaf: typeof requestAnimationFrame;
  let rafFrozen = false;

  beforeEach(() => {
    vi.useFakeTimers();
    realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      // «Заморозка» фоновой вкладки: колбэк не зовётся никогда.
      if (!rafFrozen) cb(performance.now());
      return 1;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    rafFrozen = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    vi.useRealTimers();
  });

  test("дроссель-таймер, догнавший спрятанную вкладку, флашит без rAF", async () => {
    const { onDomChange } = await import("@core/dom");
    const seen: number[] = [];
    const unsub = onDomChange(() => seen.push(Date.now()));
    try {
      // Первый flush — мгновенный (rAF живой), взводит lastFlushAt.
      document.body.appendChild(document.createElement("div"));
      await Promise.resolve();
      vi.advanceTimersByTime(50);
      const before = seen.length;

      // Вторая мутация попадает в дроссель-ветку; пока таймер ждёт — вкладка
      // прячется, rAF замерзает. Раньше scheduled=true блокировал всё
      // навсегда (PERF-10) — теперь таймер флашит напрямую.
      document.body.appendChild(document.createElement("div"));
      await Promise.resolve();
      rafFrozen = true;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      vi.advanceTimersByTime(400);
      expect(seen.length, "flush обязан пройти без rAF").toBeGreaterThan(before);

      // И машина не застряла: следующая мутация тоже доходит.
      document.body.appendChild(document.createElement("div"));
      await Promise.resolve();
      vi.advanceTimersByTime(700);
      expect(seen.length).toBeGreaterThan(before + 1);
    } finally {
      unsub();
    }
  });
});

describe("перф-аудит 26.08.2026: исполняемые бюджеты (PERF26-6)", () => {
  const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  test("горячие константы запинены: смена = осознанное решение, не дрейф", () => {
    // Ложнозелёные из отчёта: MAX_PENDING=400000 или MIN_FLUSH_INTERVAL_MS=10
    // не ронял ни один тест.
    const dom = src("src/core/dom.ts");
    expect(dom).toContain("const MAX_PENDING = 4000;");
    expect(dom).toContain("const MIN_FLUSH_INTERVAL_MS = 250;");
    const ws = src("src/core/ws-log.ts");
    expect(ws).toContain("export const MAX_TOTAL_CHARS = 2_000_000;");
    // 1М с 9.42.0: метрика стала сериализованной (SEC26-3/adversarial №3),
    // прежние 400К «тел» сжимали терпимый бэклог впятеро.
    expect(ws).toContain("export const PENDING_MAX_CHARS = 1_000_000;");
    expect(ws).toContain("export const MAX_CHUNKS = 100;");
    // Прогрев переехал в ./player-notes/history-store вместе с кэшами
    // (арх-ревью 28.08.2026): пин следует за константой, а не за файлом.
    const hist = src("src/content/features/player-notes/history-store.ts");
    expect(hist).toContain("export const WARM_PAGE_LIMIT = 200;");
    // Переехал в @core/polemica-api вместе с сетью и кэшами (арх-ревью
    // 28.08.2026): пин следует за константой, а не за файлом.
    const api = src("src/core/polemica-api.ts");
    expect(api).toContain("export const ACTIVE_GAMES_TTL_MS = 15_000;");
    const ss = src("src/content/panels/session-stats-panel.ts");
    expect(ss).toContain("const REFRESH_MS = 3 * 60_000;");
    expect(ss).toContain("const SESSION_PAGE_LIMIT = 200;");
    const pc = src("src/content/features/profile-crossover.ts");
    expect(pc).toContain("setTimeout(r, 350)");
  });

  test("«/api/games» НИКОГДА не перекрывает нерешённый запрос (PERF26-8)", async () => {
    const { fetchActiveGames, resetActiveGamesCacheForTest } = await import(
      "../../src/content/features/player-notes"
    );
    resetActiveGamesCacheForTest();
    vi.useFakeTimers();
    try {
      let resolveFirst: (v: unknown) => void = () => {};
      const gate = new Promise((r) => (resolveFirst = r));
      const fetchMock = vi.fn(() => gate as Promise<Response>);
      vi.stubGlobal("fetch", fetchMock);

      const p1 = fetchActiveGames();
      // TTL (15 с) давно вышел, а запрос ВСЁ ЕЩЁ висит — второго быть не должно.
      await vi.advanceTimersByTimeAsync(16_000);
      const p2 = fetchActiveGames();
      expect(p2, "нерешённый запрос не перекрывается").toBe(p1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Развязка: TTL стартует ОТ завершения.
      resolveFirst({ ok: true, json: async () => [] });
      await vi.advanceTimersByTimeAsync(1);
      const p3 = fetchActiveGames();
      expect(p3, "внутри TTL от развязки — тот же результат").toBe(p1);
      await vi.advanceTimersByTimeAsync(16_000);
      const p4 = fetchActiveGames();
      expect(p4, "после TTL — новый запрос").not.toBe(p1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      resetActiveGamesCacheForTest();
    }
  });

  test("поздний reject старого запроса не стирает маркер нового (путь P3 закрыт)", async () => {
    const { fetchActiveGames, resetActiveGamesCacheForTest } = await import(
      "../../src/content/features/player-notes"
    );
    resetActiveGamesCacheForTest();
    vi.useFakeTimers();
    try {
      let rejectFirst: (e: unknown) => void = () => {};
      let resolveSecond: (v: unknown) => void = () => {};
      const first = new Promise((_r, rj) => (rejectFirst = rj));
      const second = new Promise((r) => (resolveSecond = r));
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(first as Promise<Response>)
        .mockReturnValueOnce(second as Promise<Response>);
      vi.stubGlobal("fetch", fetchMock);

      const p1 = fetchActiveGames();
      p1.catch(() => {}); // reject ниже не должен уронить тест unhandled'ом
      rejectFirst(new Error("сеть моргнула"));
      await vi.advanceTimersByTimeAsync(1); // маркер очищен ошибкой — легально
      const p2 = fetchActiveGames();
      expect(p2).not.toBe(p1);
      // Пока P2 летит, ПОЗДНИЙ хвост P1 уже отработал — identity-гейт не дал
      // ему стереть маркер P2: третьего запроса нет.
      await vi.advanceTimersByTimeAsync(16_000);
      const p3 = fetchActiveGames();
      expect(p3, "нерешённый P2 не перекрыт").toBe(p2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      resolveSecond({ ok: true, json: async () => [] });
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      resetActiveGamesCacheForTest();
    }
  });
});
