// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game-search" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn(() => () => {}),
  safeClick: vi.fn(() => true),
  isVisible: vi.fn(() => true),
}));
vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: { id: "x", getManifest: () => ({ version: "9.3.1" }) },
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
vi.mock("@core/keyboard", () => ({ keyboard: { register: vi.fn(() => () => {}) } }));

import { autoStartFeature } from "@content/features/auto-start";
import { safeClick } from "@core/dom";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

const ctx = {
  settings: {
    auto_accept_enabled: true,
    skip_start_screen_enabled: true,
  } as unknown as Settings,
};

const warnHas = (needle: string) =>
  vi.mocked(log.warn).mock.calls.some((args) => args.some((a) => String(a).includes(needle)));
const infoCount = (needle: string) =>
  vi.mocked(log.info).mock.calls.filter((args) => args.some((a) => String(a).includes(needle)))
    .length;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
  // Не с нуля: бэкофф после кликов игрока сравнивает Date.now() с нулём.
  vi.setSystemTime(new Date(1_800_000_000_000));
});

afterEach(() => {
  autoStartFeature.disable();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("автопринятие: принятый блок — путь успеха, а не отказа", () => {
  test("блок БЕЗ cursor-pointer (уже принят) не кликается и не сжигает бюджет", () => {
    // Лог 04.08.2026: «3 клика по цели карточка не дали результата» за 1.7 с
    // при УСПЕШНОМ принятии. Принятый блок остаётся в DOM («Готовы: N/10»),
    // cursor-pointer сайт держит ровно до принятия — клики по принятому
    // лишь врали терминальным warn в лог поддержки.
    document.body.innerHTML = `
      <div class="p-play__profile-panel"><div class="p-play-profile__wr">
        <div class="p-play__profile-game p-play__profile-accept">
          <div class="p-play__profile-accept-timer">0:22</div>
          Готовы: 7/10
        </div>
      </div></div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(4_500); // четыре тика интервала
    expect(vi.mocked(safeClick)).not.toHaveBeenCalled();
    expect(warnHas("не дали результата"), "warn на пути успеха запрещён").toBe(false);
  });

  test("блок С cursor-pointer (ещё не принят) кликается как раньше", () => {
    document.body.innerHTML = `
      <div class="p-play__profile-panel"><div class="p-play-profile__wr">
        <div class="p-play__profile-game p-play__profile-accept cursor-pointer">
          <div class="p-play__profile-accept-timer">0:22</div>
          Принять игру
        </div>
      </div></div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(vi.mocked(safeClick)).toHaveBeenCalled();
  });
});

describe("стартовое окно: один клик на попытку", () => {
  test("кнопка и текстовый дубль — клик ровно один, по кнопке", () => {
    // Лог 04.08.2026: «клик по кнопке» и «клик по тексту» одной миллисекундой
    // — окно получало два синтетических клика подряд. Текстовая ветка — это
    // фолбэк для окна без <button>, а не второй клик.
    document.body.innerHTML = `
      <div class="common-room-modal">
        <p>Добро пожаловать</p>
        <button>НАЧАТЬ ИГРУ</button>
        <div class="button">НАЧАТЬ ИГРУ</div>
      </div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(infoCount("клик по кнопке")).toBe(1);
    expect(infoCount("клик по тексту"), "текстовый дубль запрещён").toBe(0);
    expect(vi.mocked(safeClick), "safeClick — путь текстовой ветки").not.toHaveBeenCalled();
  });

  test("окно без <button> — текстовый фолбэк работает", () => {
    document.body.innerHTML = `
      <div class="common-room-modal">
        <p>Добро пожаловать</p>
        <div class="button">НАЧАТЬ ИГРУ</div>
      </div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(infoCount("клик по тексту")).toBe(1);
    expect(vi.mocked(safeClick)).toHaveBeenCalledTimes(1);
  });
});
