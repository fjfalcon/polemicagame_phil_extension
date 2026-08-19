// @vitest-environment jsdom
/**
 * Ночная сцена при уходе из комнаты (жалоба 16.08.2026: «заголосовали, ночь,
 * вышла в поиск — на стриме так и осталась ночь, пришлось вручную»).
 *
 * Решение: уход из комнаты ночью возвращает ДЕНЬ; долгая ночь — подсказка,
 * а не переключение (честная ночь бывает длинной). Чистые функции сторожатся
 * мутационно: перепутать условие значит либо дёргать сцену эфира с чужой
 * страницы, либо снова оставить ночь висеть.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), safeClick: vi.fn(), isVisible: () => true }));
vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() }, sync: { set: vi.fn() } }, runtime: { id: "x" } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({ onMessage: vi.fn(), sendRuntime: vi.fn() }));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { LONG_NIGHT_MS, isLongNight, shouldResetNightOnLeave } from "@content/panels/obs-panel";

describe("возврат дня при уходе из комнаты", () => {
  const leftAtNight = { autoMode: true, inRoom: false, currentTimeOfDay: "night" as const };

  test("ушли из комнаты ночью с авто-режимом — возвращаем день", () => {
    expect(shouldResetNightOnLeave(leftAtNight)).toBe(true);
  });

  test("в комнате — не трогаем: там фазу ведёт детектор", () => {
    expect(shouldResetNightOnLeave({ ...leftAtNight, inRoom: true })).toBe(false);
  });

  test("ушли днём — переключать нечего", () => {
    expect(shouldResetNightOnLeave({ ...leftAtNight, currentTimeOfDay: "day" })).toBe(false);
    expect(shouldResetNightOnLeave({ ...leftAtNight, currentTimeOfDay: null })).toBe(false);
  });

  test("авто-режим выключен — сцену эфира не трогаем ни при каких условиях", () => {
    // Ручной режим: стример сам управляет сценами, наш сброс был бы
    // самодеятельностью на живом эфире.
    expect(shouldResetNightOnLeave({ ...leftAtNight, autoMode: false })).toBe(false);
  });
});

describe("подсказка о долгой ночи", () => {
  test("раньше порога молчим: честная ночь бывает длинной", () => {
    expect(isLongNight(1000, 1000 + LONG_NIGHT_MS - 1)).toBe(false);
    // Порог обязан быть ЩЕДРЫМ: обычная ночь (стрельба, проверки, договорка
    // с паузой) укладывается в пару минут — подсказка раньше трёх минут была
    // бы ложной тревогой на каждой второй игре (поймано мутантом «порог 0»).
    expect(LONG_NIGHT_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(isLongNight(1000, 1000 + 2 * 60_000), "две минуты — обычная ночь").toBe(false);
  });

  test("от порога и дальше — пора подсказать", () => {
    expect(isLongNight(1000, 1000 + LONG_NIGHT_MS)).toBe(true);
  });

  test("ночи нет — нет и подсказки", () => {
    expect(isLongNight(null, 10 ** 9)).toBe(false);
  });
});
