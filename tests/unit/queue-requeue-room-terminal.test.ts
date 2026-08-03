// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let domSubscriber: (() => void) | null = null;

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: () => void) => {
    domSubscriber = cb;
    return () => {
      domSubscriber = null;
    };
  }),
  safeClick: vi.fn(),
  isVisible: vi.fn(() => true),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));

import {
  classifyIntentTarget,
  noteIntentClick,
  noteTrustedInput,
  queueRequeueFeature,
} from "@content/features/queue-requeue";
import { log } from "@core/log";
import { showToast } from "@core/toast";
import type { Settings } from "@shared/types";

const PENDING_KEY = "pn_requeue_pending";
const EXIT_MESSAGE = "комната распущена после готовности — уходим на страницу поиска";
const ctx = { settings: { requeue_after_lobby_fail_enabled: true } as Settings };

const infoHas = (needle: string) =>
  vi.mocked(log.info).mock.calls.some((args) => args.some((a) => String(a).includes(needle)));

function pregameWithCountdown(ready: boolean, seconds = "00:28"): void {
  document.body.innerHTML = `
    <div class="roller">
      <div class="new-stage"><div class="new-stage__name">Идет набор игроков</div></div>
      <div class="disbandment-timer">Игра будет распущена через ${seconds}</div>
    </div>
    <div class="player my-player">
      ${ready ? '<div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>' : ""}
    </div>`;
}

/** Комната без отсчёта: кнопка готовности в контролах. */
function pregameWithButton(active: boolean): void {
  document.body.innerHTML = `
    <div class="roller">
      <div class="new-stage"><div class="new-stage__name">Идет набор игроков</div></div>
    </div>
    <div class="controls">
      <div class="button preset-1 medium desktop-version${active ? " active" : ""}">Готов</div>
    </div>`;
}

/** Экран ошибки комнаты с заданными главными кнопками. */
function errorScreen(buttons: Array<{ href?: string; title: string }>): void {
  document.body.innerHTML = `
    <div class="error"><div class="error__main-buttons">
      ${buttons
        .map(
          (b) =>
            `<a class="error__main-buttons-item"${b.href ? ` href="${b.href}"` : ""}>${b.title}</a>`,
        )
        .join("")}
    </div></div>`;
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/game");
  vi.useFakeTimers();
  // Не с нуля: бэкофф сравнивает Date.now() с нулевой отметкой.
  vi.setSystemTime(new Date(1_800_000_000_000));
});

afterEach(() => {
  queueRequeueFeature.disable();
  domSubscriber = null;
  vi.useRealTimers();
});

describe("RQ-1: протухший сэмпл отсчёта не доказывает старт игры", () => {
  test("отсчёт замер в фоне на 00:28 и исчез — это роспуск, уходим после паузы", () => {
    // Сайт в спрятанной вкладке останавливает анимационный цикл; по
    // возвращении один catch-up колбэк убирает отсчёт БЕЗ промежуточного
    // «00:00». Старое «28 > 3» раньше объявляло старт матча и хоронило фичу.
    pregameWithCountdown(true);
    queueRequeueFeature.enable(ctx);
    // Сорок секунд «фона»: текст не меняется, тиков нет.
    vi.advanceTimersByTime(40_000);
    document.querySelector(".disbandment-timer")?.remove();
    domSubscriber?.();

    expect(infoHas("ждём подтверждение стадии"), "stale-сэмпл обязан объявить ожидание").toBe(true);
    expect(infoHas("игра стартует"), "стартом это считать нельзя").toBe(false);

    vi.advanceTimersByTime(12_500);
    expect(infoHas(EXIT_MESSAGE), "после паузы без стадии — роспуск и уход").toBe(true);
  });

  test("свежий сэмпл >3 с по-прежнему означает старт (защита от выдёргивания из матча)", () => {
    pregameWithCountdown(true, "00:20");
    queueRequeueFeature.enable(ctx);
    document.querySelector(".disbandment-timer")?.remove();
    domSubscriber?.();
    expect(infoHas("игра стартует")).toBe(true);
    expect(sessionStorage.getItem(PENDING_KEY), "мост обязан погаснуть").toBeNull();
  });

  test("если за паузу появилась игровая стадия — из матча не выдёргиваем", () => {
    // Тот же stale-путь, но игра действительно стартовала, пока вкладка была
    // в фоне: стадия в DOM сильнее любых сэмплов.
    pregameWithCountdown(true);
    queueRequeueFeature.enable(ctx);
    vi.advanceTimersByTime(40_000);
    document.body.innerHTML = `
      <div class="roller"><span class="stage"><span class="time-of-day">Ночь 1</span></span></div>`;
    domSubscriber?.();
    vi.advanceTimersByTime(12_500);
    expect(infoHas(EXIT_MESSAGE)).toBe(false);
    expect(infoHas("матч начался")).toBe(true);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe("RQ-2: латч намерения по клику", () => {
  test("classifyIntentTarget: точная неактивная «Готов» — room-ready", () => {
    pregameWithButton(false);
    const btn = document.querySelector(".controls .button") as HTMLElement;
    expect(classifyIntentTarget(btn)).toBe("room-ready");
  });

  test("classifyIntentTarget: активная кнопка и «Не готов» — не намерение", () => {
    pregameWithButton(true);
    const active = document.querySelector(".controls .button") as HTMLElement;
    expect(classifyIntentTarget(active)).toBeNull();

    document.body.innerHTML = `<div class="controls"><div class="button preset-1">Не готов</div></div>`;
    const notReady = document.querySelector(".controls .button") as HTMLElement;
    expect(classifyIntentTarget(notReady), "подстроки запрещены (§4.2)").toBeNull();
  });

  test("classifyIntentTarget: непринятый блок принятия — search-accept", () => {
    document.body.innerHTML = `<div class="p-play__profile-accept cursor-pointer"><span>Принять игру</span></div>`;
    const inner = document.querySelector("span") as HTMLElement;
    expect(classifyIntentTarget(inner), "клик по вложенному узлу — тоже принятие").toBe(
      "search-accept",
    );
    document.body.innerHTML = `<div class="p-play__profile-accept"><span>Готовы: 9/10</span></div>`;
    expect(classifyIntentTarget(document.querySelector("span") as HTMLElement)).toBeNull();
  });

  test("недоверенный клик страницы НЕ латчит готовность", () => {
    // Страница умеет генерировать любые синтетические клики — в том числе по
    // нашей же кнопке. jsdom-события недоверенные, ровно как синтетические.
    pregameWithButton(false);
    queueRequeueFeature.enable(ctx);
    const btn = document.querySelector(".controls .button") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector(".roller")
      ?.insertAdjacentHTML(
        "beforeend",
        '<div class="disbandment-timer">Игра будет распущена через 00:15</div>',
      );
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("зафиксированное намерение переживает мгновенный сброс DOM (250-мс окно)", () => {
    // Игрок нажал «Готов» в последние миллисекунды окна: сайт успел убрать и
    // кнопку, и отметку до нашего ближайшего тика. Клик — синхронный, его
    // дроссель не съест.
    pregameWithButton(false);
    queueRequeueFeature.enable(ctx);
    const btn = document.querySelector(".controls .button") as HTMLElement;
    noteIntentClick(btn); // доверенность проверяет слушатель; здесь — суть
    // Vue уже всё снёс: ни кнопки, ни отметки — только отсчёт роспуска.
    pregameWithCountdown(false, "00:10");
    domSubscriber?.();
    expect(
      sessionStorage.getItem(PENDING_KEY),
      "мост обязан взвестись: намерение залатчено кликом",
    ).not.toBeNull();
  });
});

describe("RQ-4: живой отсчёт освежает мост", () => {
  test("минутный серверный отсчёт не протушивает метку", () => {
    // TTL моста — 45 с. Метка ставится в начале отсчёта; без освежения на
    // каждом тике серверный отсчёт длиннее TTL хоронил бы автоклик ещё до
    // роспуска. Ждать нельзя: длительность отсчёта задаёт сервер.
    pregameWithCountdown(true, "01:00");
    queueRequeueFeature.enable(ctx);
    const timer = document.querySelector(".disbandment-timer") as HTMLElement;
    for (let left = 50; left >= 0; left -= 10) {
      vi.advanceTimersByTime(10_000);
      timer.textContent = `Игра будет распущена через 00:${String(left).padStart(2, "0")}`;
      domSubscriber?.();
    }
    const mark = JSON.parse(sessionStorage.getItem(PENDING_KEY) as string) as {
      issuedAt: number;
      refreshedAt: number;
    };
    expect(
      mark.refreshedAt - mark.issuedAt,
      "refreshedAt обязан идти за живым отсчётом, issuedAt — стоять",
    ).toBeGreaterThanOrEqual(50_000);
  });
});

describe("RQ-5: экран ошибки должен ДОКАЗЫВАТЬ развал", () => {
  test("экран исключения (home + search) не возвращает игрока в очередь", () => {
    pregameWithButton(true); // готовность залатчена по active-кнопке
    queueRequeueFeature.enable(ctx);
    errorScreen([
      { href: "https://polemicagame.com", title: "На главную" },
      { href: "/game-search", title: "Поиск игры" },
    ]);
    domSubscriber?.();
    expect(infoHas("не подтверждает развал")).toBe(true);
    expect(infoHas(EXIT_MESSAGE)).toBe(false);
    expect(sessionStorage.getItem(PENDING_KEY), "мост для исключённого — запрещён").toBeNull();
  });

  test("узкая форма (единственная ссылка на поиск) — развал, уходим", () => {
    pregameWithButton(true);
    queueRequeueFeature.enable(ctx);
    errorScreen([{ href: "/game-search", title: "Поиск игры" }]);
    domSubscriber?.();
    expect(infoHas(EXIT_MESSAGE)).toBe(true);
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
  });

  test("потеря сессии (один action без href) — решает игрок", () => {
    // Такой экран перехватывает вето «Попробовать снова»: action-кнопка без
    // ссылки — признак восстановимой ошибки, комната может быть жива.
    pregameWithButton(true);
    queueRequeueFeature.enable(ctx);
    errorScreen([{ title: "Перезагрузить" }]);
    domSubscriber?.();
    expect(infoHas(EXIT_MESSAGE)).toBe(false);
    expect(infoHas("обрыв связи")).toBe(true);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe("RQ-7: честный ответ неготовому игроку", () => {
  test("доказанный роспуск без готовности — тост и лог, но БЕЗ возврата", () => {
    pregameWithCountdown(false, "00:02");
    queueRequeueFeature.enable(ctx);
    domSubscriber?.();
    document.querySelector(".disbandment-timer")?.remove();
    domSubscriber?.();
    vi.advanceTimersByTime(12_500);

    expect(infoHas("готовность не была подтверждена")).toBe(true);
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.stringContaining("вы не подтвердили готовность"),
      expect.anything(),
    );
    expect(infoHas(EXIT_MESSAGE), "предохранитель в силе: возврата нет").toBe(false);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("пока отсчёт идёт, тоста нет — игрок ещё может нажать «Готов»", () => {
    pregameWithCountdown(false, "00:20");
    queueRequeueFeature.enable(ctx);
    domSubscriber?.();
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });
});

describe("RQ-6: возвращение вкладки кликом в страницу", () => {
  function setHidden(value: boolean): void {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
  }

  afterEach(() => {
    setHidden(false);
  });

  test("visibilitychange не решает синхронно; после grace и бэкоффа — ровно один уход", () => {
    pregameWithCountdown(true, "00:01");
    queueRequeueFeature.enable(ctx);
    domSubscriber?.();
    setHidden(true);
    document.querySelector(".disbandment-timer")?.remove();
    domSubscriber?.();
    vi.advanceTimersByTime(12_500);
    // Комната мертва, но вкладка в фоне — отложено с латчем.
    expect(infoHas("вкладка в фоне")).toBe(true);
    expect(infoHas(EXIT_MESSAGE)).toBe(false);

    // Игрок возвращает фокус КЛИКОМ В СТРАНИЦУ: pointerdown и
    // visibilitychange приходят рядом, порядок не определён.
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    // Синхронного решения быть не должно — иначе мы либо навигируем поперёк
    // клика, либо (при обратном порядке) замолкаем навсегда.
    expect(infoHas(EXIT_MESSAGE), "решение до foreground grace запрещено").toBe(false);

    // jsdom не умеет доверенных событий — используем тот же шов, что и латч
    // намерения: доверенность проверяет слушатель, суть проверяем напрямую.
    noteTrustedInput();

    // Grace: решение попадает в бэкофф и планирует себя само.
    vi.advanceTimersByTime(400);
    expect(infoHas("игрок только что действовал сам")).toBe(true);
    expect(infoHas(EXIT_MESSAGE)).toBe(false);
    // Бэкофф истёк — машина обязана проснуться БЕЗ единой мутации DOM.
    vi.advanceTimersByTime(2_200);
    expect(infoHas(EXIT_MESSAGE)).toBe(true);
  });
});

describe("RQ-8/RQ-9: эпизоды и маршруты", () => {
  test("смена маршрута обрывает эпизод и объявляет это", () => {
    pregameWithCountdown(true);
    queueRequeueFeature.enable(ctx);
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    sessionStorage.clear();

    history.replaceState(null, "", "/");
    document.body.innerHTML = "";
    domSubscriber?.();
    expect(infoHas("эпизод автовозврата сброшен")).toBe(true);

    // Старый latch готовности не должен пережить возврат в комнату.
    history.replaceState(null, "", "/game");
    pregameWithCountdown(false, "00:10");
    domSubscriber?.();
    expect(
      sessionStorage.getItem(PENDING_KEY),
      "готовность прошлой комнаты не наследуется",
    ).toBeNull();
  });

  test("сто тиков на главной без метки — ноль строк про мост", () => {
    // Обычное отсутствие метки — не эпизод (RQ-8): иначе кольцо лога
    // затапливается и вытесняет первопричину.
    history.replaceState(null, "", "/");
    document.body.innerHTML = "";
    queueRequeueFeature.enable(ctx);
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    for (let i = 0; i < 100; i++) domSubscriber?.();
    const bridgeLines = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls]
      .flat()
      .filter((a) => String(a).includes("мост"));
    expect(bridgeLines).toEqual([]);
  });
});
