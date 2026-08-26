// @vitest-environment jsdom
/**
 * Парная статистика на странице профиля (просьба владельца 26.08.2026).
 *
 * Главные стражи:
 *  • вставка из onDomChange ИДЕМПОТЕНТНА (инвариант §4): повторные мутации
 *    не плодят и не пересоздают карточку;
 *  • SPA-переход между профилями меняет карточку, а не оставляет чужую;
 *  • свой профиль и разлогин — карточки нет;
 *  • сеть ходит через кэш/дедупликацию, а не на каждую мутацию.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  domSub: null as null | ((mutations: MutationRecord[]) => void),
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
vi.mock("@core/own-user", () => ({
  getOwnUserId: vi.fn(async () => 13509),
}));
vi.mock("@core/crossover", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@core/crossover")>();
  return {
    ...orig,
    // Сеть фейковая, счёт (crossGames/oldestDate) — настоящий.
    fetchHistory: vi.fn(async () => ({
      rows: [
        { id: 10, role: "civilian", win: true },
        { id: 11, role: "mafia", win: false },
      ],
      truncated: false,
    })),
    fetchFirstPage: vi.fn(async () => ({
      rows: [{ id: 10, role: "mafia", win: false }],
      total: 1,
    })),
    completeHistory: vi.fn(async (_id: unknown, first: { rows: unknown[] }) => ({
      rows: first.rows,
      truncated: false,
    })),
  };
});

import { fetchFirstPage } from "@core/crossover";
import { getOwnUserId } from "@core/own-user";
import {
  BLOCK_CLASS,
  profileCrossoverFeature,
  profileIdFromPath,
  syncProfileCrossoverRoute,
} from "@content/features/profile-crossover";
import type { FeatureContext } from "@core/feature";

const flush = () => new Promise((r) => setTimeout(r, 0));
const childRecord = (): MutationRecord =>
  ({ type: "childList", addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;

function mountProfileDom(): void {
  document.body.innerHTML =
    '<div class="profile__right">' +
    '<div class="profile__right-info"></div>' +
    '<div class="profile__right-tabs"></div>' +
    "</div>";
}

const block = (): HTMLElement | null => document.querySelector(`.${BLOCK_CLASS}`);

beforeEach(() => {
  profileCrossoverFeature.disable();
  mountProfileDom();
  window.history.replaceState(null, "", "/profile/993");
  (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(13509);
});

describe("id из пути", () => {
  test("профиль с числовым id — распознаётся, включая под-вкладки", () => {
    expect(profileIdFromPath("/profile/993")).toBe("993");
    expect(profileIdFromPath("/profile/993/games")).toBe("993");
  });
  test("не-профили и мусор — null", () => {
    expect(profileIdFromPath("/game-search")).toBeNull();
    expect(profileIdFromPath("/profile/")).toBeNull();
    expect(profileIdFromPath("/profile/vasya")).toBeNull();
    expect(profileIdFromPath("/profiles/993")).toBeNull();
  });
});

describe("карточка на профиле", () => {
  test("вставляется между инфо и вкладками и наполняется настоящим счётом", async () => {
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    const b = block();
    expect(b, "карточка вставлена сразу (плейсхолдер)").not.toBeNull();
    expect(b?.previousElementSibling?.className).toBe("profile__right-info");
    expect(b?.nextElementSibling?.className).toBe("profile__right-tabs");

    await flush();
    // Игра №10: я мирный, он мафия — разноцвет, моя победа.
    expect(b?.textContent).toContain("Совместных игр");
    expect(b?.textContent).toContain("Разноцвет");
  });

  test("повторные мутации DOM не пересоздают карточку (идемпотентность §4)", async () => {
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    const first = block();
    h.domSub?.([childRecord()]);
    h.domSub?.([childRecord()]);
    expect(block()).toBe(first);
    expect(document.querySelectorAll(`.${BLOCK_CLASS}`)).toHaveLength(1);
    // И сеть не дёргалась повторно: кэш, а не запрос на каждую мутацию.
    expect((fetchFirstPage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  test("Vue смыл карточку перерисовкой — мутация возвращает её на место", async () => {
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    block()?.remove();
    h.domSub?.([childRecord()]);
    await flush();
    expect(block(), "карточка восстановлена").not.toBeNull();
    expect(block()?.textContent).toContain("Совместных игр");
  });

  test("SPA-переход на другой профиль меняет карточку, а не оставляет чужую", async () => {
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    window.history.replaceState(null, "", "/profile/994");
    syncProfileCrossoverRoute("994");
    expect(block()?.dataset.pnFor).toBe("994");
    await flush();
    const calls = (fetchFirstPage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][0]).toBe("994");
  });

  test("уход с профиля убирает карточку", async () => {
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    syncProfileCrossoverRoute(null);
    expect(block()).toBeNull();
  });

  test("свой профиль — карточки нет: пересекаться не с кем", async () => {
    window.history.replaceState(null, "", "/profile/13509");
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    expect(block()).toBeNull();
  });

  test("разлогин (id не определился) — карточка тихо убирается", async () => {
    (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    expect(block()).toBeNull();
  });

  test("disable симметричен: ни карточки, ни подписки", async () => {
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    await flush();
    profileCrossoverFeature.disable();
    expect(block()).toBeNull();
    expect(h.domSub).toBeNull();
  });
});
