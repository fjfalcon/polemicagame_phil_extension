// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game-search" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const seam = vi.hoisted(() => ({
  // У auto-start НЕСКОЛЬКО подписчиков (принятие + игровая страница) —
  // держим всех и дёргаем всех, как это делает настоящий наблюдатель.
  subs: [] as Array<(muts: Array<{ addedNodes: unknown[] }>) => void>,
}));
vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: (muts: Array<{ addedNodes: unknown[] }>) => void) => {
    seam.subs.push(cb);
    return () => {
      seam.subs = seam.subs.filter((s) => s !== cb);
    };
  }),
  safeClick: vi.fn(() => true),
  isVisible: vi.fn(() => true),
}));
vi.mock("@core/env", () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    runtime: { id: "x", getManifest: () => ({ version: "9.3.1" }) },
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
vi.mock("@core/keyboard", () => ({
  keyboard: { register: vi.fn(() => () => {}), registerHold: vi.fn(() => () => {}) },
}));

import {
  autoStartFeature,
  hidesRolesByDay,
  shouldRehideAfterPeek,
} from "@content/features/auto-start";
import { keyboard } from "@core/keyboard";
import { safeClick } from "@core/dom";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

const ctx = {
  settings: {
    auto_accept_enabled: true,
    skip_start_screen_enabled: true,
  } as unknown as Settings,
};

const warnHas = (needle: string) =>
  vi.mocked(log.warn).mock.calls.some((args) => args.some((a) => String(a).includes(needle)));
const infoCount = (needle: string) =>
  vi.mocked(log.info).mock.calls.filter((args) => args.some((a) => String(a).includes(needle)))
    .length;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
  // Не с нуля: бэкофф после кликов игрока сравнивает Date.now() с нулём.
  vi.setSystemTime(new Date(1_800_000_000_000));
});

afterEach(() => {
  autoStartFeature.disable();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("автопринятие: принятый блок — путь успеха, а не отказа", () => {
  test("блок БЕЗ cursor-pointer (уже принят) не кликается и не сжигает бюджет", () => {
    // Лог 04.08.2026: «3 клика по цели карточка не дали результата» за 1.7 с
    // при УСПЕШНОМ принятии. Принятый блок остаётся в DOM («Готовы: N/10»),
    // cursor-pointer сайт держит ровно до принятия — клики по принятому
    // лишь врали терминальным warn в лог поддержки.
    document.body.innerHTML = `
      <div class="p-play__profile-panel"><div class="p-play-profile__wr">
        <div class="p-play__profile-game p-play__profile-accept">
          <div class="p-play__profile-accept-timer">0:22</div>
          Готовы: 7/10
        </div>
      </div></div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(4_500); // четыре тика интервала
    expect(vi.mocked(safeClick)).not.toHaveBeenCalled();
    expect(warnHas("не дали результата"), "warn на пути успеха запрещён").toBe(false);
  });

  test("блок С cursor-pointer (ещё не принят) кликается как раньше", () => {
    document.body.innerHTML = `
      <div class="p-play__profile-panel"><div class="p-play-profile__wr">
        <div class="p-play__profile-game p-play__profile-accept cursor-pointer">
          <div class="p-play__profile-accept-timer">0:22</div>
          Принять игру
        </div>
      </div></div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(vi.mocked(safeClick)).toHaveBeenCalled();
  });
});

describe("PERF-3: единый планировщик сканов принятия", () => {
  test("наблюдатель и интервал не дают второго скана внутри 250 мс", () => {
    // Раньше это были независимые пути: наблюдатель кликал через 250 мс от
    // мутации, интервал — сам по себе; в худшем случае двойной скан (и
    // двойной клик) внутри одного окна.
    document.body.innerHTML = `
      <div class="p-play__profile-panel"><div class="p-play-profile__wr">
        <div class="p-play__profile-game p-play__profile-accept cursor-pointer">Принять игру</div>
      </div></div>`;
    autoStartFeature.enable(ctx);
    vi.mocked(safeClick).mockClear();

    // Шквал: три «мутации» подряд + тик интервала внутри того же окна.
    const fire = () => seam.subs.forEach((s) => s([{ addedNodes: [document.createElement("div")] }]));
    fire();
    fire();
    fire();
    vi.advanceTimersByTime(260);
    expect(vi.mocked(safeClick).mock.calls.length, "ровно один скан за окно").toBe(1);

    vi.advanceTimersByTime(1_100); // следующий интервал-тик — новый скан легитимен
    expect(vi.mocked(safeClick).mock.calls.length).toBe(2);
  });
});

describe("стартовое окно: один клик на попытку", () => {
  test("кнопка и текстовый дубль — клик ровно один, по кнопке", () => {
    // Лог 04.08.2026: «клик по кнопке» и «клик по тексту» одной миллисекундой
    // — окно получало два синтетических клика подряд. Текстовая ветка — это
    // фолбэк для окна без <button>, а не второй клик.
    document.body.innerHTML = `
      <div class="common-room-modal">
        <p>Добро пожаловать</p>
        <button>НАЧАТЬ ИГРУ</button>
        <div class="button">НАЧАТЬ ИГРУ</div>
      </div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(infoCount("клик по кнопке")).toBe(1);
    expect(infoCount("клик по тексту"), "текстовый дубль запрещён").toBe(0);
    expect(vi.mocked(safeClick), "safeClick — путь текстовой ветки").not.toHaveBeenCalled();
  });

  test("выключенная кнопка не съедает попытку — текстовый фолбэк спасает", () => {
    // Ранний return кнопочной ветки глушит фолбэк: без фильтра !disabled
    // клик по мёртвой кнопке молча съедал бы попытку целиком.
    document.body.innerHTML = `
      <div class="common-room-modal">
        <p>Добро пожаловать</p>
        <button disabled>НАЧАТЬ ИГРУ</button>
        <div class="button">НАЧАТЬ ИГРУ</div>
      </div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(infoCount("клик по кнопке")).toBe(0);
    expect(infoCount("клик по тексту")).toBe(1);
  });

  test("текст «Принять игру» внутри ПРИНЯТОГО блока не кликается (симметрия фильтра)", () => {
    // Сегодня принятая карточка меняет подпись, но защита текстового пути
    // не должна держаться на подписи сайта.
    history.replaceState(null, "", "/game-search");
    document.body.innerHTML = `
      <div class="p-play__profile-panel"><div class="p-play-profile__wr">
        <div class="p-play__profile-game p-play__profile-accept">
          <div class="animation-on-active-child">Принять игру</div>
        </div>
      </div></div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(2_200);
    expect(vi.mocked(safeClick)).not.toHaveBeenCalled();
  });

  test("окно без <button> — текстовый фолбэк работает", () => {
    document.body.innerHTML = `
      <div class="common-room-modal">
        <p>Добро пожаловать</p>
        <div class="button">НАЧАТЬ ИГРУ</div>
      </div>`;
    autoStartFeature.enable(ctx);
    vi.advanceTimersByTime(1_100);
    expect(infoCount("клик по тексту")).toBe(1);
    expect(vi.mocked(safeClick)).toHaveBeenCalledTimes(1);
  });
});

describe("подсматривание ролей: возврат скрытия (самопроверка 12.08.2026)", () => {
  test("клавиша скрытия не действует во время подсматривания — и говорит об этом", () => {
    // Обе клавиши трогают одно и то же скрытие. Нажатие D под зажатым V
    // ушло бы в ветку «игрок сам показал роли» и перевернуло бы учёт.
    const kb = vi.mocked(keyboard);
    autoStartFeature.enable({ settings: { auto_hide_roles_enabled: true } } as never);
    const holdCall = kb.registerHold.mock.calls.at(-1);
    const roleKeyCall = kb.register.mock.calls.find((c) => c[0] === "KeyD");
    expect(holdCall, "клавиша подсматривания зарегистрирована").toBeTruthy();
    expect(roleKeyCall, "клавиша скрытия зарегистрирована").toBeTruthy();

    // Скрытие ставится не мгновенно, а первым тиком интервала — без него
    // подсматривать нечего, и гейт не сработал бы по другой причине.
    vi.advanceTimersByTime(1_100);
    expect(document.getElementById("polemica-role-hide"), "роли скрыты").not.toBeNull();

    (holdCall![1] as () => void)();
    vi.mocked(log.info).mockClear();
    (roleKeyCall![1] as (e?: KeyboardEvent) => void)();
    expect(
      vi.mocked(log.info).mock.calls.some((args) =>
        args.some((a) => String(a).includes("не действует, пока удерживается")),
      ),
      "молчаливое бездействие человек читает как поломку",
    ).toBe(true);
    (holdCall![2] as () => void)();
    autoStartFeature.disable();
  });

  test("«подсмотреть» показывает и СВОЮ роль, скрытую нативно (жалоба стримера 27.08.2026)", () => {
    // Скрытие живёт двумя слоями: CSS прячет роли ВСЕХ, а свою роль сайт
    // прячет ещё и сам (#stop вместо иконки). Клавиша снимала только CSS —
    // стример видел роли всех, КРОМЕ своей, то есть ровно ту, ради которой
    // клавишу и держат.
    const kb = vi.mocked(keyboard);
    document.body.innerHTML = `
      <div class="players">
        <div class="player my-player">
          <div class="player__role role role my-role"><svg><use href="#stop"></use></svg></div>
        </div>
      </div>`;
    const dKeys: string[] = [];
    // Сайт на свой D переворачивает иконку роли — без этого проверка возврата
    // была бы ложно-зелёной: «уже скрыто» и без нашего участия.
    const use = document.querySelector("use") as SVGElement;
    const spy = vi.spyOn(document, "dispatchEvent").mockImplementation((e: Event) => {
      if (e.type === "keydown") {
        dKeys.push((e as KeyboardEvent).code);
        const now = use.getAttribute("href") ?? "";
        use.setAttribute("href", now.includes("#stop") ? "#role-mafia" : "#stop");
      }
      return true;
    });
    autoStartFeature.enable({ settings: { auto_hide_roles_enabled: true } } as never);
    vi.advanceTimersByTime(1_100);
    expect(document.getElementById("polemica-role-hide"), "роли скрыты CSS").not.toBeNull();

    const holdCall = kb.registerHold.mock.calls.at(-1)!;
    dKeys.length = 0;
    (holdCall[1] as () => void)();
    expect(document.getElementById("polemica-role-hide"), "CSS снят").toBeNull();
    expect(dKeys, "сайту дослан D — иначе своя роль осталась бы под #stop").toContain("KeyD");

    // Отпускание обязано вернуть ОБА слоя: роль, оставшаяся на экране, уедет
    // в эфир — это ровно то, от чего фича защищает.
    dKeys.length = 0;
    (holdCall[2] as () => void)();
    expect(document.getElementById("polemica-role-hide"), "CSS вернулся").not.toBeNull();
    expect(dKeys, "нативное скрытие вернулось").toContain("KeyD");
    spy.mockRestore();
    autoStartFeature.disable();
  });

  test("после отпускания прячем ВСЕГДА, когда авто-скрытие включено", () => {
    // Решение считается по настройкам и фазе, а не по «роли сейчас видны»:
    // во время удержания они видны по определению, и сверка с DOM успевала
    // записать «показаны» — отпускание тогда ничего не прятало, и роль
    // оставалась на экране (то есть уезжала в эфир).
    expect(shouldRehideAfterPeek({ autoHideRoles: true, rolePhaseSwitch: false }, "day")).toBe(true);
    expect(shouldRehideAfterPeek({ autoHideRoles: true, rolePhaseSwitch: false }, "night")).toBe(true);
    expect(shouldRehideAfterPeek({ autoHideRoles: true, rolePhaseSwitch: false }, null)).toBe(true);
  });

  test("ночью с автосменой решение остаётся за фазовой логикой", () => {
    expect(shouldRehideAfterPeek({ autoHideRoles: true, rolePhaseSwitch: true }, "night")).toBe(false);
    expect(shouldRehideAfterPeek({ autoHideRoles: true, rolePhaseSwitch: true }, "day")).toBe(true);
  });

  test("когда не прячем вовсе — возвращать нечего", () => {
    expect(shouldRehideAfterPeek({ autoHideRoles: false, rolePhaseSwitch: false }, "night")).toBe(false);
    expect(shouldRehideAfterPeek({ autoHideRoles: false, rolePhaseSwitch: false }, "day")).toBe(false);
  });

  test("автосмена работает САМА, без авто-скрытия (просьба Ильи 12.08.2026)", () => {
    // Раньше тумблер автосмены в одиночку не делал ничего: код гейтил его
    // авто-скрытием. Днём прячем, ночью показываем — и с одной настройкой.
    expect(hidesRolesByDay({ autoHideRoles: false, rolePhaseSwitch: true })).toBe(true);
    expect(hidesRolesByDay({ autoHideRoles: true, rolePhaseSwitch: false })).toBe(true);
    expect(hidesRolesByDay({ autoHideRoles: false, rolePhaseSwitch: false })).toBe(false);

    expect(shouldRehideAfterPeek({ autoHideRoles: false, rolePhaseSwitch: true }, "day")).toBe(true);
    expect(shouldRehideAfterPeek({ autoHideRoles: false, rolePhaseSwitch: true }, "night")).toBe(false);
  });
});

describe("автосмена ролей без авто-скрытия (просьба Ильи 12.08.2026)", () => {
  /** Комната с явной фазой: сайт вешает класс на body. */
  function roomWithPhase(phase: "day" | "night"): void {
    document.body.className = phase;
    document.body.innerHTML = `
      <div class="player my-player">
        <span class="player__role role my-role red"><svg><use href="#sheriff"></use></svg></span>
      </div>`;
  }

  test("днём роли прячутся, хотя авто-скрытие выключено", () => {
    // Раньше тумблер автосмены в одиночку не делал НИЧЕГО: код гейтил его
    // авто-скрытием, и человек считал настройку сломанной.
    roomWithPhase("day");
    autoStartFeature.enable({
      settings: { auto_hide_roles_enabled: false, role_phase_auto_switch_enabled: true },
    } as never);
    // Фазовая проверка идёт через интервал + отложенный разбор — даём обоим.
    vi.advanceTimersByTime(2_500);
    expect(document.getElementById("polemica-role-hide"), "днём скрыто").not.toBeNull();
    autoStartFeature.disable();
  });

  test("обе выключены — не трогаем роли вовсе", () => {
    roomWithPhase("day");
    autoStartFeature.enable({
      settings: { auto_hide_roles_enabled: false, role_phase_auto_switch_enabled: false },
    } as never);
    vi.advanceTimersByTime(2_500);
    expect(document.getElementById("polemica-role-hide")).toBeNull();
    autoStartFeature.disable();
  });
});
