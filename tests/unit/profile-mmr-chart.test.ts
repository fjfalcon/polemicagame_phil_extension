// @vitest-environment jsdom
/**
 * График «Путь MMR» (просьба владельца 26.08.2026).
 *
 * Мутационные стражи чистых функций: перевёрнутая ось Y рисовала бы рост
 * рейтинга падением; несортированный ряд — пилу вместо пути; плоская
 * линия не должна давать NaN (деление на нулевой размах).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  domSub: null as null | ((m: MutationRecord[]) => void),
}));

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((fn: (m: MutationRecord[]) => void) => {
    h.domSub = fn;
    return () => {
      h.domSub = null;
    };
  }),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/own-user", () => ({ getOwnUserId: vi.fn(async () => 13509) }));
vi.mock("@core/crossover", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@core/crossover")>();
  return {
    ...orig,
    fetchFirstPage: vi.fn(async () => ({
      rows: [
        { id: 3, role: "civilian", win: true, mmrAfter: 120, mmrDiff: 20 },
        { id: 1, role: "civilian", win: true, mmrAfter: 100, mmrDiff: 10 },
        { id: 2, role: "mafia", win: false, mmrAfter: 90, mmrDiff: -10 },
        { id: 4, role: "don", win: true }, // без рейтинга — не точка графика
      ],
      truncated: false,
    })),
  };
});

import { getOwnUserId } from "@core/own-user";
import {
  CHART_CLASS,
  chartPoints,
  mmrSeries,
  profileMmrChartFeature,
  syncProfileMmrRoute,
} from "@content/features/profile-mmr-chart";
import type { GameRow } from "@core/crossover";
import type { FeatureContext } from "@core/feature";

const flush = () => new Promise((r) => setTimeout(r, 400)); // 350 мс паузы перед сетью
const block = (): HTMLElement | null => document.querySelector(`.${CHART_CLASS}`);

beforeEach(() => {
  profileMmrChartFeature.disable();
  document.body.innerHTML =
    '<div class="profile__right"><div class="profile__right-info"></div><div class="profile__right-tabs"></div></div>';
  window.history.replaceState(null, "", "/profile/13509");
  (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(13509);
});

describe("ряд значений", () => {
  test("хронология по id, только рейтинговые игры", () => {
    const rows: GameRow[] = [
      { id: 3, role: "x", win: true, mmrAfter: 120 },
      { id: 1, role: "x", win: true, mmrAfter: 100 },
      { id: 2, role: "x", win: false }, // нет MMR
    ];
    expect(mmrSeries(rows)).toEqual([100, 120]);
  });
});

describe("точки полилинии", () => {
  test("рост рейтинга — вверх по экрану (Y меньше)", () => {
    const pts = chartPoints([100, 200], 100, 50).split(" ");
    const y = (p: string) => Number(p.split(",")[1]);
    expect(y(pts[1])).toBeLessThan(y(pts[0]));
  });
  test("минимум и максимум растянуты на всю высоту (с полями)", () => {
    const pts = chartPoints([100, 200], 100, 50, 4).split(" ");
    const y = (p: string) => Number(p.split(",")[1]);
    expect(y(pts[0])).toBe(46); // min — у нижнего края
    expect(y(pts[1])).toBe(4); // max — у верхнего
  });
  test("плоская линия — без NaN", () => {
    expect(chartPoints([100, 100, 100], 100, 50)).not.toContain("NaN");
  });
  test("меньше двух точек — пусто", () => {
    expect(chartPoints([100], 100, 50)).toBe("");
    expect(chartPoints([], 100, 50)).toBe("");
  });
});

describe("карточка на своём профиле", () => {
  test("рисуется с текущим MMR и дельтой; SVG-путь непустой", async () => {
    profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    const b = block();
    expect(b).not.toBeNull();
    expect(b?.textContent).toContain("Путь MMR");
    expect(b?.textContent).toContain("120"); // последний MMR
    expect(b?.textContent).toContain("+20 за 3 игр"); // 120 − 100 (первое значение)
    expect(b?.querySelector("polyline")?.getAttribute("points")).toBeTruthy();
  });

  test("чужой профиль — карточки нет (там живёт «Вместе с вами»)", async () => {
    window.history.replaceState(null, "", "/profile/993");
    profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    expect(block()).toBeNull();
    // Регрессия блокера §4: мутация от самоудаления не перевставляет карточку.
    h.domSub?.([{ type: "childList" } as unknown as MutationRecord]);
    await flush();
    expect(block()).toBeNull();
  });

  test("повторные мутации не пересоздают карточку (идемпотентность §4)", async () => {
    profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    const first = block();
    h.domSub?.([{ type: "childList" } as unknown as MutationRecord]);
    expect(block()).toBe(first);
    expect(document.querySelectorAll(`.${CHART_CLASS}`)).toHaveLength(1);
  });

  test("уход с профиля убирает карточку", async () => {
    profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    syncProfileMmrRoute(null);
    expect(block()).toBeNull();
  });
});
