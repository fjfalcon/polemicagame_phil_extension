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
  // В jsdom нет вёрстки: любой узел «невидим». Видимость проверяется живьём,
  // здесь важна логика этапов.
  isVisible: vi.fn(() => true),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { queueRequeueFeature } from "@content/features/queue-requeue";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

const PENDING_KEY = "pn_requeue_pending";
const ctx = { settings: { requeue_after_lobby_fail_enabled: true } as Settings };

/**
 * Роллер в первые секунды после загрузки комнаты: состояние игры ещё не
 * пришло по сокету, поэтому сайт рисует ветку `.stage`. Внутри — РОВНО ТРИ
 * `.substage` (массив substages в data фиксирован: current/next/temp), но с
 * пустым текстом: подписи берутся из ещё не пришедшей стадии.
 */
function roomJustLoaded(): void {
  document.body.innerHTML = `
    <div class="roller">
      <span class="stage">
        <div class="substages">
          <div class="substage current"></div>
          <div class="substage next"></div>
          <div class="substage temp"></div>
        </div>
      </span>
    </div>
    <div class="player my-player"><div class="player__info"></div></div>`;
}

/** Экран «Идет набор игроков» + наша отметка «Готов» + отсчёт роспуска. */
function pregameWithCountdown(ready: boolean): void {
  document.body.innerHTML = `
    <div class="roller">
      <div class="new-stage">
        <div class="new-stage__name">Идет набор игроков</div>
        <span class="new-stage__readiness-count"><span class="current">7</span>/10</span>
      </div>
      <div class="disbandment-timer">Игра будет распущена через 00:28</div>
    </div>
    <div class="player my-player">
      ${ready ? '<div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>' : ""}
    </div>`;
}

/** Идущий матч: ночь. */
function matchRunning(): void {
  document.body.innerHTML = `
    <div class="roller">
      <span class="stage">
        <span class="time-of-day">Ночь 1</span>
        <span class="stage__icon"></span>
      </span>
    </div>`;
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  queueRequeueFeature.disable();
  domSubscriber = null;
});

describe("этап 2: комната до старта игры", () => {
  test("пустой .stage сразу после загрузки комнаты не считается начавшимся матчем", () => {
    // Регрессия: роллер рисует .stage всегда, когда стадия не «набор игроков»
    // — в том числе ДО прихода состояния игры. Фича ловила этот пустой узел на
    // первом же тике, ставила gameStarted и выключала себя на всю жизнь
    // страницы. Этап 2 не работал НИКОГДА (жалоба 01.08.2026).
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);

    // Состояние пришло: экран набора игроков, мы готовы, идёт отсчёт роспуска.
    pregameWithCountdown(true);
    domSubscriber?.();

    expect(
      sessionStorage.getItem(PENDING_KEY),
      "мост в поиск обязан взвестись, когда игрок готов и идёт отсчёт роспуска",
    ).not.toBeNull();
  });

  test("без подтверждённой готовности мост не взводится", () => {
    // Главный предохранитель: возвращаем только того, кто сам подтвердил игру.
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    pregameWithCountdown(false);
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  /** Предигровой экран с кнопкой готовности: ControlsButton, `active` = нажата. */
  function pregameWithButton(active: boolean): void {
    document.body.innerHTML = `
      <div class="roller">
        <div class="new-stage"><div class="new-stage__name">Идет набор игроков</div></div>
        <div class="disbandment-timer">Игра будет распущена через 00:15</div>
      </div>
      <div class="controls">
        <div class="button preset-1 medium desktop-version${active ? " active" : ""}">
          <img class="button__icon" src="/room/bundle/img/9c1f0a2b41d7e5.svg">Готов
        </div>
        <div class="button preset-1 medium desktop-version active">
          <img class="button__icon" src="/room/bundle/img/1a2b3c4d5e6f70.svg">Микрофон
        </div>
      </div>`;
  }

  test("готовность видна по кнопке контролов, даже если отметки на плитке нет", () => {
    // Подписи кнопки одинаковы в обоих состояниях («Готов»), нажатую готовность
    // выдаёт только класс active (:class="{active: votingForGameStart.voted}").
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    pregameWithButton(true);
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
  });

  test("кнопка готовности без active — готовность ещё НЕ подтверждена", () => {
    // Соседняя активная кнопка (микрофон) не должна сойти за готовность.
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    pregameWithButton(false);
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("пустые .substage в свежей комнате не считаются стадией матча", () => {
    // Ядро правки: маркер стадии должен быть НЕПУСТЫМ. Сайт рисует три пустых
    // .substage сразу после загрузки — на них фича и спотыкалась.
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    // Экран набора игроков ещё не пришёл, но отметка готовности уже есть,
    // и отсчёт роспуска идёт — единственное, что отделяет нас от действия,
    // это правильный разбор пустой стадии.
    document.body.innerHTML = `
      <div class="roller">
        <span class="stage">
          <div class="substages">
            <div class="substage current"></div>
            <div class="substage next"></div>
            <div class="substage temp"></div>
          </div>
        </span>
        <div class="disbandment-timer">Игра будет распущена через 00:20</div>
      </div>
      <div class="player my-player">
        <div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>
      </div>`;
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
  });

  test("«Ожидание начала игры» — это НЕ идущий матч (жалоба 09.08.2026)", () => {
    // Пока состояние комнаты не пришло, gameView не определён, тернарник
    // роллера уходит в ветку ОБЫЧНОЙ стадии (а не «набор игроков») и пишет
    // «Ожидание начала игры». Текст непустой — и лобби, в которое игрок
    // только что вошёл, читалось как идущий матч: фича выключала себя через
    // секунду после входа, а развал лобби потом никто не ловил.
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    document.body.innerHTML = `
      <div class="roller">
        <span class="stage">
          <div class="stage__name">Ожидание начала игры</div>
        </span>
        <div class="disbandment-timer">Игра будет распущена через 00:20</div>
      </div>
      <div class="player my-player">
        <div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>
      </div>`;
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY), "возврат обязан остаться взведённым").not.toBeNull();
  });

  test("английский интерфейс: «Waiting for game» тоже не матч", () => {
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    document.body.innerHTML = `
      <div class="roller">
        <span class="stage"><div class="stage__name">Waiting for game</div></span>
        <div class="disbandment-timer">Игра будет распущена через 00:20</div>
      </div>
      <div class="player my-player">
        <div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>
      </div>`;
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
  });

  test("настоящая стадия матча по-прежнему выключает возвраты", () => {
    // Обратная сторона правки: исключение не должно съесть живые стадии.
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    document.body.innerHTML = `
      <div class="roller">
        <span class="stage"><div class="stage__name">Речь игрока</div></span>
        <div class="disbandment-timer">Игра будет распущена через 00:20</div>
      </div>
      <div class="player my-player">
        <div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>
      </div>`;
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("пауза и итог игры рисуются вместо роллера — это тоже идущий матч", () => {
    // fixedState (пауза/промах/победа) подменяет роллер целиком: ни .stage,
    // ни .new-stage там нет, и без этого правила F5 прямо в паузу оставлял бы
    // фичу «на страже» до конца жизни страницы (ревью 02.08.2026).
    document.body.innerHTML = `
      <div class="roller"><div class="ended ended-pause"><div class="ended__title">Пауза</div></div></div>
      <div class="player my-player">
        <div class="player__topleftmenu"><div class="player__readiness"><span>Готов</span></div></div>
      </div>`;
    queueRequeueFeature.enable(ctx);
    document.querySelector(".roller")?.insertAdjacentHTML(
      "beforeend",
      '<div class="disbandment-timer">Игра будет распущена через 00:05</div>',
    );
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("кнопка «Не готов» с классом active не считается готовностью (§4.2)", () => {
    // Подстрочный матч тут запрещён инвариантом: «Не готов» содержит «готов».
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    document.body.innerHTML = `
      <div class="roller">
        <div class="new-stage"><div class="new-stage__name">Идет набор игроков</div></div>
        <div class="disbandment-timer">Игра будет распущена через 00:15</div>
      </div>
      <div class="controls">
        <div class="button preset-1 medium desktop-version active">
          <img class="button__icon" src="/room/bundle/img/9c1f0a2b41d7e5.svg">Не готов
        </div>
      </div>`;
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("идущий матч по-прежнему выключает возвраты и гасит мост", () => {
    // Цена ошибки в другую сторону — выдернуть игрока из живого матча.
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    pregameWithCountdown(true);
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();

    matchRunning();
    domSubscriber?.();
    expect(sessionStorage.getItem(PENDING_KEY), "мост обязан умереть с началом матча").toBeNull();
  });
});

describe("этап 2: развал комнаты доводится до конца", () => {
  const EXIT_MESSAGE = "комната распущена после готовности — уходим на страницу поиска";

  /** Отсчёт исчез, показав напоследок `lastSeconds`. */
  function countdownVanishesAt(lastSeconds: string): void {
    roomJustLoaded();
    queueRequeueFeature.enable(ctx);
    pregameWithCountdown(true);
    domSubscriber?.();
    const timer = document.querySelector(".disbandment-timer") as HTMLElement;
    timer.textContent = `Игра будет распущена через ${lastSeconds}`;
    domSubscriber?.();
    timer.remove();
    domSubscriber?.();
    // DOM распущенной комнаты замирает — паузу отсчитывает собственный таймер.
    vi.advanceTimersByTime(12_500);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Не с нуля: бэкофф после ручных действий игрока сравнивает Date.now()
    // с нулевой отметкой и на «нулевом» времени запретил бы любое действие.
    vi.setSystemTime(new Date(1_800_000_000_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("досчитал до нуля и погас — уходим на страницу поиска", () => {
    // Весь смысл фичи, и он спрятан за четырьмя предохранителями: пауза 12с,
    // фоновая вкладка, бэкофф после действий человека, экран «Попробовать
    // снова». До этой проверки ни один тест до ухода не доходил.
    countdownVanishesAt("00:01");
    expect(vi.mocked(log.info).mock.calls.some((args) => args.includes(EXIT_MESSAGE))).toBe(true);
  });

  test("погас на 00:20 — игра стартует, из матча никого не выдёргиваем", () => {
    // Отсчёт исчезает в ДВУХ случаях: время вышло (роспуск) и «все успели».
    // Второй отличается по последнему показанному значению.
    countdownVanishesAt("00:20");
    expect(vi.mocked(log.info).mock.calls.some((args) => args.includes(EXIT_MESSAGE))).toBe(false);
    expect(sessionStorage.getItem(PENDING_KEY), "мост обязан погаснуть").toBeNull();
  });
});
