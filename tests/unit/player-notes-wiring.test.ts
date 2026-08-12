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

import { playerNotesFeature,
  REBUILD_COOLDOWN_MS,
  REBUILD_LIMIT,
  throttleRebuild,
} from "@content/features/player-notes";
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

  test("ряд кнопок встаёт в КОНТЕЙНЕР угла перед плашкой, а не внутрь плашки", () => {
    // Жалоба владельца 08.08.2026: в лобби кнопки ложились на плашку
    // рейтинга сайта — она живёт в той же колонке, а наш ряд висел над
    // плашкой ника абсолютом. В потоке колонки пересечений нет.
    document.body.innerHTML = `
      <div class="players">
        <div class="player" id="p1">
          <div class="player__botleftmenu">
            <div class="mmr-label">6821</div>
            <div class="player__info info">
              <div class="player-number player-0">1</div>
              <span class="info__name">fj</span>
            </div>
          </div>
        </div>
      </div>`;
    const tile = document.querySelector("#p1") as HTMLElement;
    fire([rec({ target: document.body, added: [tile] })]);

    const host = document.querySelector(".player__botleftmenu") as HTMLElement;
    const icons = host.querySelector(":scope > .player-icons");
    expect(icons, "ряд кнопок обязан лежать в колонке угла").not.toBeNull();
    expect(
      document.querySelector(".player__info > .player-icons"),
      "внутри плашки ряда быть не должно — он ложился на рейтинг",
    ).toBeNull();
    // Порядок: кнопки ПЕРЕД плашкой ника (привычный вид «кнопки над ником»).
    const kids = Array.from(host.children);
    expect(kids.indexOf(icons as Element)).toBeLessThan(
      kids.indexOf(host.querySelector(".player__info") as Element),
    );
  });

  test("нет контейнера угла — ряд кнопок всё равно появляется (в плашке)", () => {
    // Фолбэк: сайт может отдать плитку без колонки (другой экран, редизайн).
    document.body.innerHTML = `
      <div class="players">
        <div class="player" id="p1">
          <div class="player__info info">
            <div class="player-number player-0">1</div>
            <span class="info__name">fj</span>
          </div>
        </div>
      </div>`;
    const tile = document.querySelector("#p1") as HTMLElement;
    fire([rec({ target: document.body, added: [tile] })]);
    expect(document.querySelector(".player__info > .player-icons")).not.toBeNull();
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

describe("сторож шторма пересборки кнопок (жалоба 12.08.2026)", () => {
  test("обычный темп проходит целиком", () => {
    let state;
    for (let i = 0; i < REBUILD_LIMIT; i++) {
      const r = throttleRebuild(state, 1000 + i);
      expect(r.allowed, `пересборка ${i + 1} в пределах порога`).toBe(true);
      state = r.state;
    }
  });

  test("превышение порога включает паузу и сообщает о шторме", () => {
    let state;
    for (let i = 0; i < REBUILD_LIMIT; i++) state = throttleRebuild(state, 1000).state;
    const storm = throttleRebuild(state, 1000);
    expect(storm.allowed).toBe(false);
    expect(storm.stormed, "о шторме сообщаем — иначе в журнале снова тишина").toBe(true);

    // Пока пауза — молчим и больше НЕ жалуемся (одна строка на шторм).
    const during = throttleRebuild(storm.state, 1000 + REBUILD_COOLDOWN_MS - 1);
    expect(during.allowed).toBe(false);
    expect(during.stormed).toBe(false);
  });

  test("после паузы работа возобновляется", () => {
    let state;
    for (let i = 0; i < REBUILD_LIMIT; i++) state = throttleRebuild(state, 1000).state;
    const storm = throttleRebuild(state, 1000);
    const after = throttleRebuild(storm.state, 1000 + REBUILD_COOLDOWN_MS + 1);
    expect(after.allowed, "плитка не должна остаться без кнопок навсегда").toBe(true);
  });

  test("счётчик скользящий: редкие пересборки не копятся в шторм", () => {
    // Иначе за длинную игру любая плитка однажды упёрлась бы в порог и замерла.
    let state;
    for (let i = 0; i < REBUILD_LIMIT * 3; i++) {
      const r = throttleRebuild(state, 1000 + i * 1500);
      expect(r.allowed).toBe(true);
      state = r.state;
    }
  });
});
