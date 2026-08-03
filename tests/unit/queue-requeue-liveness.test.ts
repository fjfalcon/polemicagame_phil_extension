// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game-search" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let domSubscriber: (() => void) | null = null;

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: () => void) => {
    domSubscriber = cb;
    return () => {
      domSubscriber = null;
    };
  }),
  safeClick: vi.fn(() => true),
  isVisible: vi.fn(() => true),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import { noteTrustedInput, queueRequeueFeature } from "@content/features/queue-requeue";
import { serializeMark } from "@content/features/requeue-pending";
import { safeClick } from "@core/dom";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

const PENDING_KEY = "pn_requeue_pending";
const ctx = { settings: { requeue_after_lobby_fail_enabled: true } as Settings };

const warnHas = (needle: string) =>
  vi.mocked(log.warn).mock.calls.some((args) => args.some((a) => String(a).includes(needle)));

/** Свежий мост из «распущенной комнаты» — так игрок попадает на поиск. */
function freshBridge(): void {
  sessionStorage.setItem(
    PENDING_KEY,
    serializeMark({ issuedAt: Date.now() - 5_000, refreshedAt: Date.now() - 1_000 }),
  );
}

function playButton(): void {
  document.body.innerHTML = `
    <div class="p-play__profile-panel">
      <div class="p-play-profile__wr"><button class="p-play__profile-button">Играть</button></div>
    </div>`;
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
});

afterEach(() => {
  queueRequeueFeature.disable();
  domSubscriber = null;
  vi.useRealTimers();
});

/**
 * Ядро RQ-3: DOM страницы поиска ЗАМЕР — ни одной мутации, ни одного тика от
 * наблюдателя. Всё, что ниже, обязано происходить от собственных пробуждений
 * машины. Каждый advanceTimersByTime здесь — «прошло время, DOM не менялся».
 */
describe("RQ-3: замороженный DOM не убивает машину", () => {
  test("кнопка так и не появилась — терминальный warn по собственному таймеру", () => {
    freshBridge();
    document.body.innerHTML = `<div class="p-play__profile-panel"></div>`; // скелетон
    queueRequeueFeature.enable(ctx);
    expect(warnHas("автовозврат остановлен")).toBe(false);

    vi.advanceTimersByTime(8_500);
    expect(warnHas("автовозврат остановлен: за"), "deadline обязан наступить без мутаций").toBe(
      true,
    );
  });

  test("ровно три попытки клика с паузами — без единой мутации DOM", () => {
    freshBridge();
    playButton();
    queueRequeueFeature.enable(ctx);
    expect(vi.mocked(safeClick)).toHaveBeenCalledTimes(1);

    // Сайт проглотил клик: ни секундомера, ни лоадера, ни перерисовки.
    vi.advanceTimersByTime(1_400);
    expect(vi.mocked(safeClick)).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_400);
    expect(vi.mocked(safeClick)).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_400);
    expect(vi.mocked(safeClick)).toHaveBeenCalledTimes(3);
    expect(warnHas("не сработала за"), "исчерпание попыток обязано объявить себя").toBe(true);
  });

  test("принятый блок освежает мост ПО ТАЙМЕРУ: секундомер сайта нам не виден", () => {
    // Vue 2 обновляет секундомер принятия через characterData — наш
    // наблюдатель таких мутаций не слушает, тиков от DOM тут НЕТ вообще.
    // Без планового пробуждения метка протухала бы при живом условии (RQ-4).
    document.body.innerHTML = `
      <div class="p-play__profile-game p-play__profile-accept">
        <div class="p-play__profile-accept-timer">0:60</div>
      </div>`;
    queueRequeueFeature.enable(ctx);
    const first = JSON.parse(sessionStorage.getItem(PENDING_KEY) as string) as {
      issuedAt: number;
      refreshedAt: number;
    };
    expect(first.refreshedAt).toBe(first.issuedAt);

    vi.advanceTimersByTime(40_000); // ни одной мутации DOM — только таймер
    const later = JSON.parse(sessionStorage.getItem(PENDING_KEY) as string) as {
      issuedAt: number;
      refreshedAt: number;
    };
    expect(later.issuedAt, "эпизод тот же").toBe(first.issuedAt);
    expect(
      later.refreshedAt - later.issuedAt,
      "метка обязана освежаться собственным пробуждением",
    ).toBeGreaterThanOrEqual(30_000);
  });

  test("бэкофф после действий игрока истекает сам и клик происходит", () => {
    freshBridge();
    playButton();
    queueRequeueFeature.enable(ctx);
    // Игрок действует сразу после первого клика машины (jsdom не умеет
    // доверенных событий — шов noteTrustedInput, isTrusted проверяет слушатель).
    noteTrustedInput();
    vi.mocked(safeClick).mockClear();
    domSubscriber?.(); // единственный тик: машина видит бэкофф и уступает
    expect(vi.mocked(safeClick)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_300);
    expect(vi.mocked(safeClick), "после бэкоффа машина обязана проснуться сама").toHaveBeenCalled();
  });
});
