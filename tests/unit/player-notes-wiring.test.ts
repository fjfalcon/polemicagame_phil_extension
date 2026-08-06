// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Проводка дросселя PERF-1 в подписчике player-notes (ревью 07.08.2026:
 * мутанты W1 «дроссель снят» и W8 «мутации не запускают проход» проходили
 * всю сюиту — чистые функции сторожились, вызов был на честном слове).
 * Наблюдаемое — счётчик document.querySelectorAll: полный проход всегда
 * делает QSA, отфильтрованный батч — ни одного.
 */
const seam = vi.hoisted(() => ({
  subs: [] as Array<(muts: MutationRecord[]) => void>,
}));

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: (muts: MutationRecord[]) => void) => {
    seam.subs.push(cb);
    return () => {
      seam.subs = seam.subs.filter((s) => s !== cb);
    };
  }),
  paintNickEl: vi.fn(),
  safeClick: vi.fn(),
  isVisible: vi.fn(() => true),
}));
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

import { playerNotesFeature } from "@content/features/player-notes";
import type { Settings } from "@shared/types";

const ctx = {
  settings: { statistics_enabled: true, nick_colors_enabled: true } as unknown as Settings,
};

function rec(init: { target: Node; added?: Node[]; type?: string }): MutationRecord {
  return {
    type: init.type ?? "childList",
    target: init.target,
    addedNodes: (init.added ?? []) as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
  } as unknown as MutationRecord;
}

const fire = (muts: MutationRecord[]) => seam.subs.forEach((s) => s(muts));

beforeEach(async () => {
  document.body.innerHTML = `<div class="players"><div class="player" id="p1"><div class="inner"></div></div></div>`;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
  await playerNotesFeature.enable(ctx);
});

afterEach(() => {
  playerNotesFeature.disable();
  seam.subs = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("проводка PERF-1", () => {
  const qsa = () => vi.spyOn(document, "querySelectorAll");

  test("identity-мутация (новая плитка) запускает проход НЕМЕДЛЕННО (W8)", () => {
    const spy = qsa();
    const tile = document.createElement("div");
    tile.className = "player";
    fire([rec({ target: document.body, added: [tile] })]);
    expect(spy.mock.calls.length, "проход обязан пройти без ожидания интервала").toBeGreaterThan(
      0,
    );
    spy.mockRestore();
  });

  test("шквал inner-мутаций дросселируется, а через секунду проход проходит (W1)", () => {
    const inner = document.querySelector("#p1 .inner") as Element;
    // Первый inner — проход разрешён (счётчик пуст).
    fire([rec({ target: inner })]);

    const spy = qsa();
    for (let i = 0; i < 10; i++) fire([rec({ target: inner })]);
    expect(spy.mock.calls.length, "внутри секунды повторных проходов нет").toBe(0);

    vi.advanceTimersByTime(1_100);
    fire([rec({ target: inner })]);
    expect(spy.mock.calls.length, "после секунды проход обязан пройти").toBeGreaterThan(0);
    spy.mockRestore();
  });

  test("посторонние мутации не трогают DOM вовсе", () => {
    const foreign = document.createElement("section");
    document.body.appendChild(foreign);
    const spy = qsa();
    for (let i = 0; i < 20; i++) fire([rec({ target: foreign })]);
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();
  });
});
