// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Проводка ответа на пинг владения автосценой — через НАСТОЯЩИЙ жизненный
 * цикл фичи. Чистый предикат drivesAutoScene покрыт соседним файлом; здесь
 * убиваются мутанты входов в него (контрольное ревью 04.08.2026, находка 3):
 * захардкоженный phaseSeenLive, пропавшие сбросы, фолбэк-«распознание».
 */
const seam = vi.hoisted(() => ({
  storage: {} as Record<string, unknown>,
  obsStatus: null as unknown,
  onMsg: null as ((msg: unknown) => unknown) | null,
  setSceneCalls: [] as string[],
}));

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn(() => () => {}),
  safeClick: vi.fn(),
  isVisible: () => true,
}));
vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in seam.storage) out[k] = seam.storage[k];
          return out;
        }),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { id: "x", getManifest: () => ({ version: "9.3.0" }) },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn((cb: (msg: unknown) => unknown) => {
    seam.onMsg = cb;
    return () => {
      seam.onMsg = null;
    };
  }),
  sendRuntime: vi.fn(async (msg: unknown) => {
    const m = msg as { type?: string; command?: string; data?: { sceneName?: string } };
    if (m?.type === "obs_command" && m.command === "get_status") return seam.obsStatus;
    if (m?.type === "obs_command" && m.command === "set_scene") {
      seam.setSceneCalls.push(m.data?.sceneName || "");
      return { success: true };
    }
    return { success: true };
  }),
  broadcastToGameTabs: vi.fn(),
  sendToActiveTabStrict: vi.fn(),
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { obsPanelFeature } from "@content/panels/obs-panel";
import type { Settings } from "@shared/types";

const ctx = {
  settings: {
    obs_floating_panel_enabled: false,
    obs_auto_mode_enabled: true,
    obs_day_scene: "день",
    obs_night_scene: "я",
  } as unknown as Settings,
};

/** OBS подключён, фаза «day» уже лежит в общем storage (её писала ДРУГАЯ вкладка). */
function seedRestoredDay(ageMs = 1000): void {
  seam.obsStatus = {
    success: true,
    data: { connected: true, sessionId: "s1", currentScene: "день", scenes: ["день", "я"] },
  };
  seam.storage["obs_auto_scene_state"] = {
    sessionId: "s1",
    currentTimeOfDay: "day",
    lastAppliedRoleVisibility: null,
    timestamp: Date.now() - ageMs,
  };
}

function nightMarkers(): void {
  document.body.innerHTML = `
    <div class="roller"><span class="stage">
      <div class="substages"><div class="substage current">Ночь 1</div></div>
    </span></div>`;
}

async function ping(): Promise<boolean> {
  const answer = (await seam.onMsg?.({ type: "obs_scene_owner_ping" })) as
    | { owning: boolean }
    | undefined;
  return answer?.owning === true;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  seam.storage = {};
  seam.obsStatus = null;
  seam.setSceneCalls = [];
  document.body.innerHTML = "";
  history.replaceState(null, "", "/game");
});

afterEach(() => {
  obsPanelFeature.disable();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("пинг владения: только живая фаза делает вкладку владельцем", () => {
  test("восстановленная из storage фаза — «не веду», и фолбэк её не оживляет", async () => {
    // Ядро жалобы 04.08: вкладка без единого распознанного маркера, но с
    // чужой фазой из obs_auto_scene_state, отвечала «веду» весь вечер.
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    expect(await ping(), "restore не делает фазу живой").toBe(false);

    // Комната без маркеров стадий: детектор ходит и падает в фолбэк-«day».
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await ping(), "фолбэк-«day» — не распознание").toBe(false);
  });

  test("живые маркеры ночи делают вкладку владельцем — и F5-сценарий с ними же", async () => {
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    nightMarkers();
    await vi.advanceTimersByTimeAsync(4_000); // опрос → распознание → подтверждение
    expect(await ping(), "живое распознание — владение защищено").toBe(true);
  });

  test("живое распознание БЕЗ смены фазы тоже оживляет владение (F5 владельца)", async () => {
    // Контрольное ревью, блокер 2: после F5 restore уже дал актуальную фазу,
    // детектор видит ТУ ЖЕ — смены не будет всю дневную фазу. Привязка флага
    // к «подтверждённой смене» оставляла владельца беззащитным.
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    document.body.innerHTML = `
      <div class="roller"><span class="stage">
        <div class="substages"><div class="substage current">День. Обсуждение</div></div>
      </span></div>`;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await ping(), "распознание той же фазы — владение защищено").toBe(true);
  });

  test("obs_disconnected гасит «живость», и фолбэк после него не воскрешает её", async () => {
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    nightMarkers();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await ping()).toBe(true);

    await seam.onMsg?.({ type: "obs_event", eventType: "obs_disconnected", data: null });
    document.body.innerHTML = ""; // комната без маркеров
    await vi.advanceTimersByTimeAsync(9_000); // фолбэк снова заполнит фазу
    expect(await ping(), "после разрыва OBS прежняя «живость» не в счёт").toBe(false);
  });

  test("выключение фичи сбрасывает «живость» — повторный enable начинает с нуля", async () => {
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    nightMarkers();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await ping()).toBe(true);

    obsPanelFeature.disable();
    document.body.innerHTML = "";
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    expect(await ping(), "новая жизнь фичи — только restore, не живьём").toBe(false);
  });

  test("SPA-переход в другую комнату делает фазу «не живой»", async () => {
    seedRestoredDay();
    await obsPanelFeature.enable(ctx);
    nightMarkers();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await ping()).toBe(true);

    history.replaceState(null, "", "/game/777");
    document.body.innerHTML = ""; // новая комната, маркеров ещё нет
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await ping(), "фаза прошлой комнаты не защищает владение в новой").toBe(false);
  });

  test("запись старше потолка не восстанавливается и не трогает сцену эфира", async () => {
    // Контрольное ревью, находка 5: часовая запись проходила проверку
    // sessionId и уезжала в autoSwitchScene.
    seam.obsStatus = {
      success: true,
      data: { connected: true, sessionId: "s1", currentScene: "день", scenes: ["день", "я"] },
    };
    seam.storage["obs_auto_scene_state"] = {
      sessionId: "s1",
      currentTimeOfDay: "night", // сцена бы сменилась: «день» → «я»
      lastAppliedRoleVisibility: null,
      timestamp: Date.now() - 11 * 60_000,
    };
    await obsPanelFeature.enable(ctx);
    expect(seam.setSceneCalls, "древняя фаза не должна уехать в эфир").toEqual([]);
    expect(await ping()).toBe(false);
  });
});
