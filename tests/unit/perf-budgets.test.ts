// @vitest-environment jsdom
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
