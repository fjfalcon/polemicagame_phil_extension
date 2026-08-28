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
  MUTED_PLAYERS_KEY,
  TileMediaState,
} from "@content/features/player-notes/tile-media-state";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function make(over: Partial<{ onPersistError: (m: string) => void; onExternalMuteChange: () => void }> = {}) {
  return new TileMediaState({
    onPersistError: over.onPersistError ?? (() => undefined),
    onExternalMuteChange: over.onExternalMuteChange ?? (() => undefined),
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
    const s = make({ onExternalMuteChange: () => repaints++ });
    s.toggleMute("Аня");
    s.adoptExternalMuted(["боря", "", 42, null]);
    expect(s.isMuted("Боря")).toBe(true);
    expect(s.isMuted("Аня"), "чужой список авторитетен").toBe(false);
    expect(repaints).toBe(1);
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

describe("скрытие видео: только память", () => {
  test("переключается и отвечает новым состоянием", () => {
    const s = make();
    expect(s.toggleHidden("аня")).toBe(true);
    expect(s.isHidden("Аня")).toBe(true);
    expect(s.toggleHidden("аня")).toBe(false);
    expect(s.isHidden("Аня")).toBe(false);
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
