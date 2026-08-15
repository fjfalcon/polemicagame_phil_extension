// @vitest-environment jsdom
/**
 * Детектор фризов главного потока.
 *
 * У датчика два способа врать: пропустить настоящий фриз и сочинить ложный.
 * Ложные опаснее (браузерный троттлинг фоновой вкладки неотличим от фриза по
 * времени) — их сторожим жёстче.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const journal: string[] = [];
const flushes: number[] = [];
vi.mock("@core/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...a: unknown[]) => journal.push(a.join(" ")),
    error: vi.fn(),
    flushNow: () => flushes.push(journal.length),
  },
}));

import {
  STALL_THRESHOLD_MS,
  TICK_MS,
  classifyTick,
  freezeWatchFeature,
} from "@content/features/freeze-watch";

afterEach(() => {
  freezeWatchFeature.disable();
  journal.length = 0;
  flushes.length = 0;
  vi.useRealTimers();
});

describe("классификация тика", () => {
  test("обычный джиттер — не фриз", () => {
    expect(classifyTick(1000, 1000, false)).toBeNull();
    expect(classifyTick(1000, 1000 + STALL_THRESHOLD_MS - 1, false)).toBeNull();
  });

  test("опоздание от порога и выше — фриз, длительность честная", () => {
    expect(classifyTick(1000, 1000 + STALL_THRESHOLD_MS, false)).toBe(STALL_THRESHOLD_MS);
    expect(classifyTick(1000, 8400, false)).toBe(7400);
  });

  test("вкладка была скрыта — тик отбрасывается ЛЮБОЙ длины", () => {
    // Троттлинг фоновой вкладки (до минуты в Chrome) по времени неотличим от
    // фриза; ложный «фриз 60 с» на каждый alt-tab обесценил бы журнал.
    expect(classifyTick(1000, 61_000, true)).toBeNull();
  });
});

/**
 * Фейковые таймеры двигают интервал и часы синхронно — настоящий фриз
 * (интервал ОПОЗДАЛ относительно часов) так не изобразить. Часы —
 * управляемая переменная: tick() двигает их на секунду и стреляет
 * интервалом, stall() двигает ТОЛЬКО часы («поток стоял, время шло»).
 */
let nowMs = 0;
function fakeClock(): void {
  vi.useFakeTimers();
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
}
const tick = (): void => {
  nowMs += TICK_MS;
  vi.advanceTimersByTime(TICK_MS);
};
const stall = (ms: number): void => {
  nowMs += ms;
};


describe("живой цикл", () => {
  test("фриз попадает в журнал и НЕМЕДЛЕННО на диск", () => {
    fakeClock();
    freezeWatchFeature.enable({ settings: {} } as never);
    // Штатные тики — тишина.
    tick();
    tick();
    expect(journal).toHaveLength(0);

    // Фриз: часы ушли на 6 секунд вперёд, интервал сработал с опозданием.
    stall(TICK_MS * 6);
    tick();
    expect(journal.some((l) => l.includes("главный поток стоял"))).toBe(true);
    expect(flushes.length, "сброс на диск сразу, не по расписанию").toBeGreaterThan(0);
  });

  test("свёрнутая вкладка не рождает ложный фриз", () => {
    vi.useFakeTimers();
    freezeWatchFeature.enable({ settings: {} } as never);
    // Вкладку скрыли...
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    // ...таймер растянулся на полминуты...
    vi.advanceTimersByTime(30_000);
    // ...вернули.
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(journal, "троттлинг — не фриз").toHaveLength(0);
  });

  test("после фриза детектор продолжает работать штатно", () => {
    fakeClock();
    freezeWatchFeature.enable({ settings: {} } as never);
    stall(TICK_MS * 6);
    tick(); // фриз пойман
    expect(journal, "ровно одна строка").toHaveLength(1);
    for (let i = 0; i < 10; i++) tick(); // штатные тики
    expect(journal.length, "одна строка на один фриз, не поток").toBe(1);
  });

  test("disable снимает интервал — тиков больше нет", () => {
    vi.useFakeTimers();
    freezeWatchFeature.enable({ settings: {} } as never);
    freezeWatchFeature.disable();
    vi.advanceTimersByTime(TICK_MS * 20);
    expect(journal).toHaveLength(0);
  });
});

describe("находки adversarial 15.08.2026", () => {
  test("пробуждение после сна — не фриз", () => {
    // Windows: монотонные часы идут и во сне; час сна при видимой вкладке
    // выглядел бы как «фриз 3600 с» и обесценил бы журнал.
    expect(classifyTick(1000, 1000 + 3_600_000, false)).toBeNull();
    // А настоящий длинный фриз до отсечки — ловится.
    expect(classifyTick(1000, 1000 + 60_000, false)).toBe(60_000);
  });

  test("затяжной джиттер не топит журнал: дроссель + счётчик подавленных", () => {
    fakeClock();
    freezeWatchFeature.enable({ settings: {} } as never);
    // Пять фризов подряд с шагом ~4 с.
    for (let i = 0; i < 5; i++) {
      stall(TICK_MS * 3);
      tick();
    }
    expect(journal.length, "в кольце не пять строк").toBeLessThan(3);

    // Пауза больше дросселя — следующий фриз пишется и называет подавленных.
    for (let i = 0; i < 11; i++) tick();
    stall(TICK_MS * 3);
    tick();
    expect(journal.some((l) => l.includes("подавлено")), "подавленные сосчитаны").toBe(true);
  });
});
