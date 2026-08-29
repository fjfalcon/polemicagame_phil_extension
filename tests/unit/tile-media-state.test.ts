/**
 * Что игрок решил про чужие плитки: мьют, переворот, скрытие видео.
 *
 * Слой выделен 28.08.2026. Главное правило здесь — СЛИЯНИЕ мьютов между
 * вкладками: обе хранят список целиком, и «последний писатель побеждает»
 * терял мьюты, сделанные в соседней вкладке (аудит безопасности 01.08.2026,
 * находка 8). До выделения это правило не проверялось ничем.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({ disk: {} as Record<string, unknown> }));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, unknown>) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(defaults)) out[k] = store.disk[k] ?? v;
          return out;
        }),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store.disk, patch);
        }),
      },
    },
    runtime: { id: "x" },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { browser } from "@core/env";
import {
  HIDDEN_PLAYERS_KEY,
  MUTED_PLAYERS_KEY,
  TileMediaState,
} from "@content/features/player-notes/tile-media-state";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function make(over: Partial<{ onPersistError: (m: string) => void; onExternalMediaChange: () => void }> = {}) {
  return new TileMediaState({
    onPersistError: over.onPersistError ?? (() => undefined),
    onExternalMediaChange: over.onExternalMediaChange ?? (() => undefined),
  });
}

beforeEach(() => {
  store.disk = {};
  vi.clearAllMocks();
});

describe("мьют: общий для вкладок список", () => {
  test("чужой мьют с диска НЕ теряется при своей записи", async () => {
    store.disk[MUTED_PLAYERS_KEY] = ["сосед"];
    const s = make();
    s.toggleMute("Аня");
    await flush();
    expect((store.disk[MUTED_PLAYERS_KEY] as string[]).sort()).toEqual(["аня", "сосед"]);
  });

  test("снятый ЗДЕСЬ мьют не воскресает из дискового списка", async () => {
    store.disk[MUTED_PLAYERS_KEY] = ["аня"];
    const s = make();
    await s.loadMuted();
    expect(s.isMuted("Аня")).toBe(true);
    s.toggleMute("Аня"); // сняли здесь
    await flush();
    expect(store.disk[MUTED_PLAYERS_KEY]).toEqual([]);
  });

  test("toggleMute отвечает НОВЫМ состоянием — по нему красится кнопка", async () => {
    // Возврат используется в проде (player-notes: applyMuteState/sync), но
    // не проверялся ничем (adversarial 28.08.2026).
    const s = make();
    expect(s.toggleMute("Аня"), "включили").toBe(true);
    expect(s.toggleMute("Аня"), "выключили").toBe(false);
    await flush();
  });

  test("повторное включение после снятия снова пишется на диск", async () => {
    const s = make();
    s.toggleMute("Аня");
    await flush();
    s.toggleMute("Аня");
    await flush();
    s.toggleMute("Аня");
    await flush();
    expect(store.disk[MUTED_PLAYERS_KEY]).toEqual(["аня"]);
    expect(s.isMuted("аНя"), "регистр не важен").toBe(true);
  });

  test("отказ записи виден пользователю — иначе мьют молча слетает после F5", async () => {
    const said: string[] = [];
    vi.mocked(browser.storage.local.set).mockRejectedValueOnce(new Error("quota"));
    const s = make({ onPersistError: (m) => said.push(m) });
    s.toggleMute("Аня");
    await flush();
    expect(said.join(" ")).toContain("слетит");
  });

  test("список из другой вкладки заменяет свой и просит перекрасить плитки", () => {
    let repaints = 0;
    const s = make({ onExternalMediaChange: () => repaints++ });
    s.toggleMute("Аня");
    s.adoptExternalMuted(["боря", "", 42, null]);
    expect(s.isMuted("Боря")).toBe(true);
    expect(s.isMuted("Аня"), "чужой список авторитетен").toBe(false);
    expect(repaints).toBe(1);
  });

  test("SEAM-08: MixedNick из импортированного бэкапа находится lookup'ом", async () => {
    // Рантайм ищет lowercase; свои записи такими и пишутся, но импорт бэкапа
    // мог занести смешанный регистр — мьют «есть в списке», но не работал
    // (арх-аудит швов 29.08.2026).
    store.disk[MUTED_PLAYERS_KEY] = ["MixedNick"];
    store.disk[HIDDEN_PLAYERS_KEY] = ["ДругойНик"];
    const s = make();
    await s.loadMuted();
    await s.loadHidden();
    expect(s.isMuted("mixednick")).toBe(true);
    expect(s.isHidden("другойник")).toBe(true);
    s.adoptExternalMuted(["ЕщёНик"]);
    expect(s.isMuted("ещёник"), "и из чужой вкладки — тоже").toBe(true);
  });

  test("F1: «MixedNick» со старого диска МОЖНО снять — и он не воскресает", async () => {
    // adversarial 29.08.2026: lowercase был только на чтении, а слияние при
    // записи сравнивало сырые дисковые строки с lowercase-списком снятых —
    // мьют из старого импорта воскресал у пользователя на глазах, навсегда.
    store.disk[MUTED_PLAYERS_KEY] = ["MixedNick"];
    const s = make();
    await s.loadMuted();
    expect(s.isMuted("mixednick")).toBe(true);
    s.toggleMute("MixedNick"); // снять
    await flush();
    expect(store.disk[MUTED_PLAYERS_KEY], "сырой регистр не пережил снятие").toEqual([]);
    // echo своей же записи (storage.onChanged стреляет и в пишущей вкладке)
    s.adoptExternalMuted(store.disk[MUTED_PLAYERS_KEY]);
    expect(s.isMuted("mixednick"), "не воскрес").toBe(false);
  });

  test("F1: запись нормализует регистр диска — дублей в двух регистрах нет", async () => {
    store.disk[HIDDEN_PLAYERS_KEY] = ["MixedNick"];
    const s = make();
    await s.loadHidden();
    s.toggleHidden("Аня");
    await flush();
    expect((store.disk[HIDDEN_PLAYERS_KEY] as string[]).sort()).toEqual(["mixednick", "аня"]);
  });

  test("мусор вместо списка игнорируется молча", () => {
    const s = make();
    s.toggleMute("Аня");
    s.adoptExternalMuted("не массив");
    expect(s.isMuted("Аня"), "прежнее состояние не тронуто").toBe(true);
  });
});

describe("переворот камеры: sessionStorage вкладки", () => {
  test("переворот запоминается и снимается", () => {
    const s = make();
    expect(s.isFlipped("Аня")).toBe(false);
    s.setFlipped("аня", true);
    expect(s.isFlipped("АНЯ")).toBe(true);
    s.setFlipped("аня", false);
    expect(s.isFlipped("Аня")).toBe(false);
  });

  test("недоступный sessionStorage не роняет фичу", () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("приватный режим");
      },
    });
    try {
      const s = make();
      expect(() => s.loadFlipped()).not.toThrow();
      expect(() => s.setFlipped("аня", true)).not.toThrow();
    } finally {
      if (orig) Object.defineProperty(globalThis, "sessionStorage", orig);
    }
  });
});

describe("скрытие камеры: общий для вкладок список (персистентно с 9.54.0)", () => {
  test("переключается и отвечает новым состоянием", () => {
    const s = make();
    expect(s.toggleHidden("аня")).toBe(true);
    expect(s.isHidden("Аня")).toBe(true);
    expect(s.toggleHidden("аня")).toBe(false);
    expect(s.isHidden("Аня")).toBe(false);
  });

  test("скрытие доезжает до диска и загружается обратно", async () => {
    const s = make();
    s.toggleHidden("Аня");
    await flush();
    expect(store.disk[HIDDEN_PLAYERS_KEY]).toEqual(["аня"]);
    const s2 = make();
    await s2.loadHidden();
    expect(s2.isHidden("аня"), "новая вкладка видит скрытие").toBe(true);
  });

  test("чужое скрытие с диска НЕ теряется при своей записи", async () => {
    store.disk[HIDDEN_PLAYERS_KEY] = ["сосед"];
    const s = make();
    s.toggleHidden("Аня");
    await flush();
    expect(new Set(store.disk[HIDDEN_PLAYERS_KEY] as string[])).toEqual(
      new Set(["сосед", "аня"]),
    );
  });

  test("снятое ЗДЕСЬ скрытие не воскресает из дискового списка", async () => {
    store.disk[HIDDEN_PLAYERS_KEY] = ["аня"];
    const s = make();
    await s.loadHidden();
    s.toggleHidden("аня"); // снять
    await flush();
    expect(store.disk[HIDDEN_PLAYERS_KEY]).toEqual([]);
  });

  test("список из другой вкладки заменяет свой и просит перекрасить плитки", () => {
    let repaints = 0;
    const s = make({ onExternalMediaChange: () => repaints++ });
    s.toggleHidden("Аня");
    s.adoptExternalHidden(["боря", "", 42, null]);
    expect(s.isHidden("Боря")).toBe(true);
    expect(s.isHidden("Аня"), "чужой список авторитетен").toBe(false);
    expect(repaints).toBe(1);
  });

  test("отказ записи виден пользователю — иначе скрытие молча слетает после F5", async () => {
    const said: string[] = [];
    vi.mocked(browser.storage.local.set).mockRejectedValueOnce(new Error("quota"));
    const s = make({ onPersistError: (m) => said.push(m) });
    s.toggleHidden("Аня");
    await flush();
    expect(said.join(" ")).toContain("слетит");
  });

  test("reset забывает мьют и скрытие — фичу выключили", () => {
    const s = make();
    s.toggleMute("аня");
    s.toggleHidden("боря");
    s.reset();
    expect(s.isMuted("аня")).toBe(false);
    expect(s.isHidden("боря")).toBe(false);
  });
});
