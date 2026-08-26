// @vitest-environment jsdom
/**
 * Диагностический дамп + сторож контракта селекторов (решение владельца
 * 26.08.2026 после внешнего арх-ревью).
 *
 * Главные стражи: приватность снимка (пароль OBS маскируется, содержимое
 * заметок не раскрывается — только метрики) и честность сторожа (нули там,
 * где их не бывает, — warn; здоровая комната — info; уход до замера — тишина).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

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
vi.mock("@core/selectors", () => ({
  SITE: {
    playerDesktop: ".pd",
    playerVideo: ".pv",
    obsGameControls: ".gc",
    roleSymbols: "symbol#civilian, symbol#sheriff, symbol#mafia, symbol#godfather",
    roleUse: "use",
  },
}));

import { log } from "@core/log";
import { formatSettings, section, storageMetrics } from "@core/diag-snapshot";
import {
  SETTLE_MS,
  contractLooksBroken,
  contractWatchFeature,
  evaluateRoomContract,
  syncContractWatchRoute,
} from "@content/features/contract-watch";
import type { Settings } from "@shared/types";
import type { FeatureContext } from "@core/feature";

describe("снимок: настройки", () => {
  test("пароль OBS маскируется, остальное — как есть", () => {
    const lines = formatSettings({
      obs_password: "секрет",
      statistics_enabled: true,
      twitch_channel_name: "streamer",
    } as unknown as Settings);
    const joined = lines.join("\n");
    expect(joined).not.toContain("секрет");
    expect(joined).toContain("obs_password: <задан>");
    expect(joined).toContain('statistics_enabled: true');
  });
  test("креды и токены в obs_host не доезжают до снимка", () => {
    // В адресе бывают ws://user:pass@host/?token=… — snapshot обязан
    // резать до схема+хост+порт (тот же safeEndpoint, что в OBS-логе).
    const lines = formatSettings({
      obs_host: "ws://admin:hunter2@10.0.0.5:4455/?token=SECRET",
    } as unknown as Settings).join("\n");
    expect(lines).toContain("obs_host: ws://10.0.0.5:4455");
    expect(lines).not.toContain("hunter2");
    expect(lines).not.toContain("admin");
    expect(lines).not.toContain("SECRET");
  });

  test("пустой пароль честно помечен пустым", () => {
    const lines = formatSettings({ obs_password: "" } as unknown as Settings);
    expect(lines.join("\n")).toContain("obs_password: <пуст>");
  });
});

describe("снимок: метрики хранилища", () => {
  test("заметки — счётчиком и размером, БЕЗ текста", () => {
    const metrics = storageMetrics({
      playerNotes: { "u:1": { text: "тайная заметка про игрока" }, "u:2": { text: "ещё" } },
      "polemica:logs:content-abc": ["line1", "line2"],
      "polemica:logs:bg": ["x"],
      pn_own_user_id: 13509,
    });
    const text = metrics.map((m) => `${m.label} ${m.count}`).join("\n");
    expect(text).toContain("заметки (playerNotes) 2");
    expect(text).not.toContain("тайная");
    expect(text).toContain("журнал (буферы) 2");
    expect(text).toContain("pn_own_user_id 1");
  });
});

describe("снимок: секции", () => {
  test("пустая секция не исчезает — видно, что собирали", () => {
    expect(section("OBS", [])).toContain("<пусто>");
  });
});

// ─────────── сторож контракта ───────────

function mountRoom(tiles: number, controls: number): void {
  document.body.innerHTML = "";
  for (let i = 0; i < tiles; i++) {
    const d = document.createElement("div");
    d.className = "pd";
    document.body.appendChild(d);
  }
  for (let i = 0; i < controls; i++) {
    const d = document.createElement("div");
    d.className = "gc";
    document.body.appendChild(d);
  }
}

beforeEach(() => {
  contractWatchFeature.disable();
  syncContractWatchRoute(false);
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

describe("сторож контракта комнаты", () => {
  test("замер селекторов: счётчики и источник спрайта", () => {
    mountRoom(10, 1);
    const c = evaluateRoomContract();
    expect(c.tiles).toBe(10);
    expect(c.controls).toBe(1);
    expect(c.spriteSource).toBe("fallback"); // в фикстуре спрайта нет
    expect(contractLooksBroken(c)).toBe(false);
  });

  test("нули там, где их не бывает, — контракт под вопросом", () => {
    expect(contractLooksBroken({ tiles: 0, controls: 1, cameras: 0, spriteSource: "dom" })).toBe(true);
    expect(contractLooksBroken({ tiles: 10, controls: 0, cameras: 0, spriteSource: "dom" })).toBe(true);
  });

  test("здоровая комната — одна info-строка через 15 секунд", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    mountRoom(10, 1);
    contractWatchFeature.enable({ settings: {} } as unknown as FeatureContext);
    syncContractWatchRoute(true);
    expect(log.info, "до паузы — тишина: комната ещё монтируется").not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("пустая комната через 15 секунд — warn про смену разметки", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    contractWatchFeature.enable({ settings: {} } as unknown as FeatureContext);
    syncContractWatchRoute(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(log.warn).toHaveBeenCalled();
    expect(String((log.warn as ReturnType<typeof vi.fn>).mock.calls[0].join(" "))).toContain(
      "плитки=0",
    );
    vi.unstubAllGlobals();
  });

  test("ушёл из комнаты до замера — тишина (ложных нулей нет)", () => {
    mountRoom(10, 1);
    contractWatchFeature.enable({ settings: {} } as unknown as FeatureContext);
    syncContractWatchRoute(true);
    vi.advanceTimersByTime(SETTLE_MS - 1000);
    syncContractWatchRoute(false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("выключенная фича не мерит ничего", () => {
    mountRoom(10, 1);
    syncContractWatchRoute(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(log.info).not.toHaveBeenCalled();
  });
});
