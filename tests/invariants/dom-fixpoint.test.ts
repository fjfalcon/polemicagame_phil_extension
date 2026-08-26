// @vitest-environment jsdom
/**
 * Исполняемый страж инварианта §4: «запись в DOM из подписчика onDomChange —
 * только идемпотентная» (решение владельца 26.08.2026).
 *
 * До этого файла инвариант был доктриной: блокер профильных карточек
 * (вечный цикл «вставка → самоудаление → мутация → вставка») прошёл мимо
 * ручных тестов, потому что они НЕ доигрывали мутацию, порождённую
 * самим обработчиком. Здесь конвейер настоящий: НЕмокнутый @core/dom с
 * живым MutationObserver — всё, что фича пишет в DOM, возвращается ей же
 * мутацией, как в бою.
 *
 * Механика: вкладка «скрыта» (document.hidden=true) — планирование в
 * @core/dom идёт чистыми setTimeout, и фейковые таймеры прокручивают
 * конвейер детерминированно. Фикспоинт = четыре тихих раунда подряд
 * (раунд ≈ 600 мс: больше и дросселя 250, и hidden-таймера 500).
 *
 * Канарейка в конце — страж самого стража: нарочно неидемпотентный
 * подписчик ОБЯЗАН детектироваться. Если харнес «зеленеет» на канарейке,
 * он сломан сам.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: "test" },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn(() => () => undefined),
  sendRuntime: vi.fn(async () => ({ success: true })),
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));
vi.mock("@core/own-user", () => ({ getOwnUserId: vi.fn(async () => 13509) }));
vi.mock("@core/crossover", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@core/crossover")>();
  return {
    ...orig,
    releaseOwnHistory: vi.fn(),
    getOwnHistory: vi.fn(async () => ({
      rows: [{ id: 10, role: "civilian", win: true, mmrAfter: 100, mmrDiff: 5 }],
      truncated: false,
    })),
    fetchFirstPage: vi.fn(async () => ({
      rows: [
        { id: 10, role: "mafia", win: false, mmrAfter: 90, mmrDiff: -5 },
        { id: 11, role: "civilian", win: true, mmrAfter: 95, mmrDiff: 5 },
      ],
      total: 2,
    })),
    completeHistory: vi.fn(async (_id: unknown, first: { rows: unknown[] }) => ({
      rows: first.rows,
      truncated: false,
    })),
  };
});

// ВАЖНО: @core/dom НЕ мокается — конвейер настоящий.
import { domObserver, onDomChange } from "@core/dom";
import { log } from "@core/log";
import { getOwnUserId } from "@core/own-user";
import { profileCrossoverFeature, syncProfileCrossoverRoute } from "@content/features/profile-crossover";
import { profileMmrChartFeature, syncProfileMmrRoute } from "@content/features/profile-mmr-chart";
import type { FeatureContext } from "@core/feature";

const ROUND_MS = 600;
const MAX_ROUNDS = 60;
const QUIET_ROUNDS = 4;

/**
 * Крутит конвейер до фикспоинта. Возвращает {settled, rounds} — ассерты
 * снаружи, чтобы канарейка могла утверждать ОБРАТНОЕ.
 */
async function driveToFixpoint(): Promise<{ settled: boolean; rounds: number }> {
  let seen = 0;
  const counter = new MutationObserver((m) => {
    seen += m.length;
  });
  counter.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  try {
    let quiet = 0;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const before = seen;
      await vi.advanceTimersByTimeAsync(ROUND_MS);
      await Promise.resolve(); // микротаски MutationObserver
      if (seen === before) {
        quiet++;
        if (quiet >= QUIET_ROUNDS) return { settled: true, rounds: round };
      } else {
        quiet = 0;
      }
    }
    return { settled: false, rounds: MAX_ROUNDS };
  } finally {
    counter.disconnect();
  }
}

function mountProfileDom(): void {
  document.body.innerHTML =
    '<div class="profile__right">' +
    '<div class="profile__right-info"></div>' +
    '<div class="profile__right-tabs"></div>' +
    "</div>";
}

beforeEach(() => {
  vi.useFakeTimers();
  // Скрытая вкладка: @core/dom планирует чистыми setTimeout — конвейер
  // полностью под фейковыми таймерами.
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.body.innerHTML = "";
  (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(13509);
});

afterEach(() => {
  profileCrossoverFeature.disable();
  profileMmrChartFeature.disable();
  syncProfileCrossoverRoute(null);
  syncProfileMmrRoute(null);
  vi.useRealTimers();
});

describe("§4 fixpoint: профильные карточки", () => {
  test("чужой профиль: «Вместе с вами» рисуется и DOM затихает", async () => {
    mountProfileDom();
    window.history.replaceState(null, "", "/profile/993");
    const before = domObserver.subscriberCount();
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    // «Покрыт» в enrollment значит «сценарий гоняет ЖИВУЮ подписку»: импорт
    // без подписки — фикция покрытия (ревью 26.08.2026).
    expect(domObserver.subscriberCount(), "фича реально подписалась").toBe(before + 1);
    const r = await driveToFixpoint();
    expect(r.settled, `DOM не затих за ${r.rounds} раундов — цикл подписчика`).toBe(true);
    expect(document.querySelector(".pn-profile-crossover")?.textContent).toContain(
      "Совместных игр",
    );
  });

  test("СЦЕНАРИЙ БЛОКЕРА: свой профиль — карточка самоудаляется БЕЗ вечного цикла", async () => {
    // Ровно тот случай, что прошёл мимо ручных тестов: самоудаление рождает
    // мутацию, и старый apply() вставлял карточку заново — навсегда.
    mountProfileDom();
    window.history.replaceState(null, "", "/profile/13509");
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    const r = await driveToFixpoint();
    expect(r.settled, `DOM не затих за ${r.rounds} раундов — вечный цикл вернулся`).toBe(true);
    expect(document.querySelector(".pn-profile-crossover")).toBeNull();
  });

  test("разлогин: обе карточки самоудаляются и затихают ВМЕСТЕ", async () => {
    (getOwnUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mountProfileDom();
    window.history.replaceState(null, "", "/profile/993");
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
    const r = await driveToFixpoint();
    expect(r.settled, `DOM не затих за ${r.rounds} раундов`).toBe(true);
    expect(document.querySelector(".pn-profile-crossover")).toBeNull();
    expect(document.querySelector(".pn-mmr-chart")).toBeNull();
  });

  test("свой профиль: график рисуется, кроссовер уходит — фикспоинт при обеих фичах", async () => {
    mountProfileDom();
    window.history.replaceState(null, "", "/profile/13509");
    const before = domObserver.subscriberCount();
    profileCrossoverFeature.enable({ settings: {} } as unknown as FeatureContext);
    profileMmrChartFeature.enable({ settings: {} } as unknown as FeatureContext);
    expect(domObserver.subscriberCount(), "обе фичи реально подписались").toBe(before + 2);
    const r = await driveToFixpoint();
    expect(r.settled, `DOM не затих за ${r.rounds} раундов`).toBe(true);
    expect(document.querySelector(".pn-mmr-chart")?.textContent).toContain("Путь MMR");
    expect(document.querySelector(".pn-profile-crossover")).toBeNull();
  });
});

describe("рантайм-сторож шторма (живой лог, не только тесты)", () => {
  test("минута безостановочных проходов вне комнаты — одна warn-строка", async () => {
    window.history.replaceState(null, "", "/profile/1");
    // Управляемые часы для performance.now: реальное время в фейк-таймерах
    // не течёт, а сторожу нужно «прожить» минуту.
    let clock = 0;
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const off = onDomChange(() => {
      document.body.appendChild(document.createElement("div")); // шторм
    });
    try {
      document.body.appendChild(document.createElement("span"));
      for (let i = 0; i < 130; i++) {
        clock += 600;
        await vi.advanceTimersByTimeAsync(600);
        await Promise.resolve();
      }
      const warns = (log.warn as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c.join(" "))
        .filter((line) => line.includes("не затихает"));
      expect(warns.length, "предупреждение о шторме — ровно одно (латч)").toBe(1);
    } finally {
      off();
      perfSpy.mockRestore();
    }
  });

  test("в игровой комнате шторм легитимен — сторож молчит", async () => {
    window.history.replaceState(null, "", "/game/123");
    let clock = 0;
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const off = onDomChange(() => {
      document.body.appendChild(document.createElement("div"));
    });
    try {
      document.body.appendChild(document.createElement("span"));
      for (let i = 0; i < 130; i++) {
        clock += 600;
        await vi.advanceTimersByTimeAsync(600);
        await Promise.resolve();
      }
      const warns = (log.warn as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c.join(" "))
        .filter((line) => line.includes("не затихает"));
      expect(warns).toHaveLength(0);
    } finally {
      off();
      perfSpy.mockRestore();
    }
  });
});

describe("канарейка: харнес обязан УМЕТЬ падать", () => {
  test("нарочно неидемпотентный подписчик детектируется как нефикспоинт", async () => {
    // Тот же класс, что блокер: каждая пачка мутаций — новая запись в DOM.
    const off = onDomChange(() => {
      document.body.appendChild(document.createElement("div"));
    });
    try {
      document.body.appendChild(document.createElement("span")); // затравка
      const r = await driveToFixpoint();
      expect(r.settled, "харнес «озеленил» вечный цикл — страж сломан").toBe(false);
    } finally {
      off();
    }
  });
});
