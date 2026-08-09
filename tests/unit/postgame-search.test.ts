// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Кнопка «В поиск» после конца игры и машина «выйти из игры → Играть».
 *
 * Мутационный критерий (§процесс): каждый тест валит конкретную поломку —
 * снятый гейт условия показа, тавтологию текста кнопки, бесконечный бюджет,
 * вечное молчание в фоне, пережившую страницу метку.
 */
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

/** Захват ответчика пробы + управляемый сторож живого матча. */
let messageHandler: ((msg: unknown) => unknown) | null = null;
vi.mock("@core/messaging", () => ({
  onMessage: vi.fn((h: (msg: unknown) => unknown) => {
    messageHandler = h;
    return () => {
      messageHandler = null;
    };
  }),
  sendRuntime: vi.fn(async () => ({ live: false })),
}));

import {
  BUTTON_ID,
  POSTGAME_PENDING_KEY,
  jamReload,
  noteTrustedInput,
  QUEUES_ID,
  postgameSearchFeature,
} from "@content/features/postgame-search";
import { log } from "@core/log";
import { showToast } from "@core/toast";
import { safeClick } from "@core/dom";
import { sendRuntime } from "@core/messaging";
import type { Settings } from "@shared/types";

const ctx = { settings: { postgame_requeue_enabled: true } as Settings };

const infoHas = (needle: string) =>
  vi.mocked(log.info).mock.calls.some((args) => args.some((a) => String(a).includes(needle)));
const warnHas = (needle: string) =>
  vi.mocked(log.warn).mock.calls.some((args) => args.some((a) => String(a).includes(needle)));

/** Экран завершённой игры (роллер): размеры — как в selectors.test.ts. */
function endedScreen(classes = "ended ended-mafia"): HTMLElement {
  const roller = document.createElement("div");
  roller.className = "roller";
  const el = document.createElement("div");
  el.className = classes;
  Object.defineProperties(el, {
    offsetWidth: { configurable: true, value: 300 },
    offsetHeight: { configurable: true, value: 200 },
  });
  roller.append(el);
  document.body.append(roller);
  return el;
}

/**
 * Плитка игрока в комнате. `state` — класс выбытия сайта
 * (state-killed | state-voted | state-disqualified) или "" для живого.
 */
function playerTile(mine: boolean, state = ""): void {
  const tile = document.createElement("div");
  tile.className = `player${mine ? " my-player" : ""}`;
  tile.innerHTML = state
    ? `<span class="state not-transparent ${state}"><span class="state__text">Ночь 2 ☠ Убит</span></span>`
    : "";
  document.body.append(tile);
}

/** Идущий матч (непустая стадия) — как в комнате во время игры. */
function runningStage(): void {
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.innerHTML = `<div class="stage__name">День 3</div>`;
  document.body.append(stage);
}

/** Решающий блок страницы поиска («Продолжить игру» / «Покинуть игру»). */
function decideBlock(quitLabel = "Покинуть игру"): void {
  const div = document.createElement("div");
  div.className = "p-play__profile-game--decide";
  div.innerHTML = `
    <button type="button" class="p-play__profile-agree">Продолжить игру</button>
    <button type="button" class="p-play__profile-quit">${quitLabel}</button>`;
  document.body.append(div);
}

/** Модалка подтверждения выхода. */
function confirmQuitModal(label = "Покинуть лобби"): void {
  const div = document.createElement("div");
  div.className = "confirmQuit";
  div.innerHTML = `<button class="confirmQuit__content-btn">${label}</button>`;
  document.body.append(div);
}

/**
 * Модалка сайта «Вы уже играете» (второй путь выхода). `warning` — вариант
 * с угрозой блокировки (isWarning), который автокликать нельзя.
 */
function inProgressModal(warning = false, finishLabel = "Завершить последнюю игру"): void {
  const div = document.createElement("div");
  div.className = "modal modal-game-in-progress";
  Object.defineProperties(div, {
    offsetWidth: { configurable: true, value: 740 },
    offsetHeight: { configurable: true, value: 300 },
  });
  div.innerHTML = `
    <div class="modal-game-in-progress__wrapper">
      <div class="modal-game-in-progress__header"><span>Вы уже играете</span>
        <p>${
          warning
            ? "Если вы досрочно покинете игру из любого режима, за исключением лобби - вы получите автоматическую блокировку"
            : "Возможно вы уже играете в другой вкладке, либо на другом устройстве."
        }</p>
      </div>
      <div class="modal-game-in-progress__body">
        <button class="button button-orange">Вернуться в игру</button>
        <button class="button button-grey">${finishLabel}</button>
      </div>
    </div>`;
  document.body.append(div);
}

/** Кнопка «Играть». */
function playButton(disabled = false): void {
  const btn = document.createElement("button");
  btn.className = "p-play__profile-button";
  btn.textContent = "Играть";
  if (disabled) btn.setAttribute("disabled", "");
  document.body.append(btn);
}

/** Видимая ЧУЖАЯ модалка (родовая обёртка с размерами). */
function foreignModal(): void {
  const div = document.createElement("div");
  div.className = "modal";
  Object.defineProperties(div, {
    offsetWidth: { configurable: true, value: 300 },
    offsetHeight: { configurable: true, value: 200 },
  });
  document.body.append(div);
}

/** Свежий мост в sessionStorage (как его пишет клик по кнопке). */
function plantMark(ageMs = 0, extra: Record<string, unknown> = {}): void {
  const at = Date.now() - ageMs;
  sessionStorage.setItem(
    POSTGAME_PENDING_KEY,
    JSON.stringify({ issuedAt: at, refreshedAt: at, ...extra }),
  );
}

/** Лоадер на месте кнопки «Играть». */
function playLoader(): HTMLElement {
  const div = document.createElement("div");
  div.className = "p-play__profile-game p-play__profile-game--search p-play__profile-game-loader-gradient";
  document.body.append(div);
  return div;
}

function enableOnSearch(): void {
  history.replaceState(null, "", "/game-search");
  postgameSearchFeature.enable(ctx);
}

const clicked = (): Element[] => vi.mocked(safeClick).mock.calls.map((c) => c[0] as Element);

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/game");
  vi.useFakeTimers();
  // Не с нуля: бэкофф сравнивает Date.now() с нулевой отметкой.
  vi.setSystemTime(new Date(1_800_000_000_000));
});

let realJamReload: () => void;

beforeEach(() => {
  realJamReload = jamReload.run;
  jamReload.run = vi.fn();
});

afterEach(() => {
  jamReload.run = realJamReload;
  postgameSearchFeature.disable();
  domSubscriber = null;
  vi.useRealTimers();
});

describe("комната: условия показа кнопки", () => {
  test("победа мафии → кнопка есть, рендер идемпотентен", () => {
    endedScreen("ended ended-mafia");
    postgameSearchFeature.enable(ctx);
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
    domSubscriber?.();
    domSubscriber?.();
    // Мутант «безусловный append на каждый тик» — инвариант §4 п.1.
    expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
  });

  test("пауза и промах мафии кнопку НЕ показывают", () => {
    endedScreen("ended ended-pause");
    postgameSearchFeature.enable(ctx);
    expect(document.getElementById(BUTTON_ID)).toBeNull();
    document.body.innerHTML = "";
    endedScreen("ended ended-mafia-missed");
    domSubscriber?.();
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });

  test("живой матч без ended-экрана кнопку не показывает, конец игры — показывает, уход экрана — убирает", () => {
    postgameSearchFeature.enable(ctx);
    expect(document.getElementById(BUTTON_ID)).toBeNull();
    const el = endedScreen("ended ended-civilian");
    domSubscriber?.();
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
    el.remove();
    domSubscriber?.();
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });

  test.each([
    ["state-voted", "заголосован"],
    ["state-killed", "убит ночью"],
    ["state-disqualified", "дисквалифицирован"],
  ])("выбывший игрок (%s, %s) видит кнопку посреди идущего матча", (state) => {
    // Жалоба 07.08.2026: сайт НЕ уводит выбывшего из комнаты и не даёт ему
    // ?role=viewer — он сидит мёртвым, а кнопки не было.
    runningStage();
    playerTile(true, state);
    postgameSearchFeature.enable(ctx);
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
    expect(infoHas("игрок выбыл из матча")).toBe(true);
  });

  test("выбыл СОСЕД, а не я — кнопки нет: мой матч продолжается", () => {
    // Мутант «селектор без .my-player»: кнопка вылезала бы живому игроку
    // при первой же смерти за столом — прямой путь сорвать чужую игру.
    runningStage();
    playerTile(true);
    playerTile(false, "state-killed");
    postgameSearchFeature.enable(ctx);
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });

  test("выбывший не считается «живым матчем» — иначе сторож запретит ему выход", () => {
    runningStage();
    playerTile(true, "state-voted");
    postgameSearchFeature.enable(ctx);
    const probe = messageHandler?.({ type: "postgame_live_probe" }) as Promise<{ live: boolean }>;
    return expect(probe).resolves.toEqual({ live: false });
  });

  test("живой игрок в идущем матче — «живой матч» для сторожа", () => {
    runningStage();
    playerTile(true);
    postgameSearchFeature.enable(ctx);
    const probe = messageHandler?.({ type: "postgame_live_probe" }) as Promise<{ live: boolean }>;
    return expect(probe).resolves.toEqual({ live: true });
  });

  test("мост выбывшего — обычный свежий мост, без флага перезагрузки", () => {
    runningStage();
    playerTile(true, "state-killed");
    postgameSearchFeature.enable(ctx);
    document.getElementById(BUTTON_ID)?.dispatchEvent(new MouseEvent("click"));
    const mark = JSON.parse(sessionStorage.getItem(POSTGAME_PENDING_KEY) as string);
    expect(mark.issuedAt).toBe(Date.now());
    expect(mark.reloaded).toBe(false);
  });

  test("режим зрителя (role=viewer) → кнопка есть и без ended-экрана", () => {
    history.replaceState(null, "", "/game?role=viewer&game_id=123");
    postgameSearchFeature.enable(ctx);
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
  });

  test("клик по кнопке кладёт мост в sessionStorage и логирует уход", () => {
    endedScreen();
    postgameSearchFeature.enable(ctx);
    document.getElementById(BUTTON_ID)?.dispatchEvent(new MouseEvent("click"));
    const raw = sessionStorage.getItem(POSTGAME_PENDING_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).issuedAt).toBe(Date.now());
    expect(infoHas("кнопка «В поиск» нажата")).toBe(true);
  });

  test("stream window стримера: кнопки нет даже на экране победы (блокер A)", () => {
    // Сайт сам открывает живому игроку окно захвата с ?role=viewer:
    // window.open(..., "streamWindow"). Кнопка там — мусор в эфире и
    // мисклик-выход из идущего матча.
    const original = window.name;
    try {
      window.name = "streamWindow";
      history.replaceState(null, "", "/game?role=viewer&game_id=123");
      endedScreen();
      postgameSearchFeature.enable(ctx);
      domSubscriber?.();
      expect(document.getElementById(BUTTON_ID)).toBeNull();
    } finally {
      window.name = original;
    }
  });

  test("выключенная настройка — кнопки нет", () => {
    endedScreen();
    postgameSearchFeature.enable({
      settings: { postgame_requeue_enabled: false } as Settings,
    });
    domSubscriber?.();
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });
});

describe("поиск: машина «выйти из игры → Играть»", () => {
  test("мост + решающий блок → сторож → «Покинуть игру» → модалка → «Покинуть лобби» → «Играть»", async () => {
    plantMark();
    decideBlock();
    // Скрытая родовая обёртка модалки сидит в DOM всегда (v-show сайта):
    // сторож чужих модалок обязан смотреть на РАЗМЕРЫ, не на присутствие.
    const hiddenShell = document.createElement("div");
    hiddenShell.className = "basemodal";
    document.body.append(hiddenShell);
    enableOnSearch();
    expect(infoHas("мост «В поиск» из комнаты")).toBe(true);
    expect(sessionStorage.getItem(POSTGAME_PENDING_KEY), "метка одноразовая").toBeNull();
    // Квит уходит только ПОСЛЕ ответа сторожа живого матча (он асинхронный).
    expect(clicked()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(vi.mocked(sendRuntime)).toHaveBeenCalledWith({ type: "postgame_live_query" });
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");

    // Сайт открыл модалку подтверждения.
    confirmQuitModal();
    await vi.advanceTimersByTimeAsync(1400);
    domSubscriber?.();
    expect(clicked().at(-1)?.className).toBe("confirmQuit__content-btn");

    // POST прошёл: блок и модалка исчезли, рисуются очереди с «Играть».
    document.body.innerHTML = "";
    playButton();
    await vi.advanceTimersByTimeAsync(1400);
    domSubscriber?.();
    expect(clicked().at(-1)?.className).toBe("p-play__profile-button");
    expect(vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("Снова встаю"))).toBe(
      true,
    );

    // Секундомер очереди — успех, эпизод закрыт.
    document.body.innerHTML = `
      <div class="p-play__profile-game--search"><div class="p-play__profile-game-search-time">0:03</div></div>`;
    domSubscriber?.();
    expect(infoHas("поиск запущен: секундомер очереди подтверждён")).toBe(true);
  });

  test("модалка подтверждается быстро: следующий шаг не ждёт секунду повтора", async () => {
    // Лог 07.08, 20:57: машина кликнула «Покинуть игру» и замолчала на
    // секунду с лишним — игрок успел дожать модалку и «Играть» сам, решив,
    // что расширение не работает. Новый шаг обязан идти сразу за прошлым.
    plantMark();
    decideBlock();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");

    document.body.innerHTML = "";
    confirmQuitModal();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(400);
    expect(clicked().at(-1)?.className, "модалку жмём в пределах ~0.3 с").toBe(
      "confirmQuit__content-btn",
    );
  });

  test("повтор ТОГО ЖЕ шага по-прежнему ждёт секунду с лишним", async () => {
    // Обратная сторона: не долбить одну кнопку в упор.
    plantMark();
    decideBlock();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().length).toBe(1);
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(clicked().length, "второй клик по той же кнопке — не раньше 1.2 с").toBe(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(clicked().length).toBe(2);
  });

  test("о начале выхода из игры говорим плашкой — молчащая машина выглядит сломанной", async () => {
    plantMark();
    decideBlock();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(200);
    expect(
      vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("Выхожу из игры")),
    ).toBe(true);
  });

  test("второй путь: модалка «Вы уже играете» → жмём «Завершить последнюю игру»", async () => {
    // Сайт открывает её в ответ на «Играть», когда сервер сказал in_game и
    // режим разрешает искать из игры. Раньше машина считала её чужой и
    // сдавалась — ровно вопрос владельца 07.08.2026 про этот диалог.
    plantMark();
    inProgressModal();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(300);
    const clickedEl = clicked().at(-1) as HTMLElement | undefined;
    expect(clickedEl?.textContent).toBe("Завершить последнюю игру");
    expect(warnHas("открыта модалка сайта"), "это не чужая модалка").toBe(false);
  });

  test("«Вернуться в игру» не жмём никогда: это противоположность просьбе игрока", async () => {
    plantMark();
    inProgressModal(false, "Закончить игру"); // подпись выхода уехала
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("не нашлась кнопка завершения игры")).toBe(true);
  });

  test("угроза блокировки в модалке — автоклик запрещён, решает игрок", async () => {
    // Цена ошибки здесь — бан аккаунта, поэтому предохранитель fails-closed.
    plantMark();
    inProgressModal(true);
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("предупреждает о блокировке")).toBe(true);
  });

  test("сторож живого матча работает и на этой модалке", async () => {
    vi.mocked(sendRuntime).mockResolvedValueOnce({ live: true });
    plantMark();
    inProgressModal();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("в другой вкладке идёт ваш матч")).toBe(true);
  });

  test("настройка «оставить модалку игроку» действует и на «Вы уже играете»", async () => {
    plantMark();
    inProgressModal();
    history.replaceState(null, "", "/game-search");
    postgameSearchFeature.enable({
      settings: {
        postgame_requeue_enabled: true,
        postgame_skip_confirm_enabled: false,
      } as Settings,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked()).toHaveLength(0);
    expect(infoHas("оставлена игроку (настройка)")).toBe(true);
  });

  test("без моста машина не делает НИЧЕГО", () => {
    decideBlock();
    enableOnSearch();
    vi.advanceTimersByTime(5000);
    domSubscriber?.();
    expect(clicked()).toHaveLength(0);
  });

  test("протухший мост (старше TTL) пропускается с причиной", () => {
    plantMark(60_000);
    decideBlock();
    enableOnSearch();
    expect(infoHas("метка устарела")).toBe(true);
    expect(clicked()).toHaveLength(0);
  });

  test("подпись «Покинуть игру» изменилась — ни одного клика, честный warn", async () => {
    // Мутант-тавтология: снять проверку текста — клик уйдёт по чужой кнопке.
    plantMark();
    decideBlock("Выйти навсегда");
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("подпись кнопки шага «Покинуть игру» не совпала")).toBe(true);
    expect(vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("вручную"))).toBe(
      true,
    );
  });

  test("бюджет шага: три попытки и терминальный warn, не бесконечность", async () => {
    plantMark();
    decideBlock();
    enableOnSearch();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1400);
      domSubscriber?.();
    }
    expect(clicked().length).toBe(3);
    expect(warnHas("«Покинуть игру» не сработал за 3 попытки")).toBe(true);
  });

  test("чужая модалка (капча/«Ошибка!») останавливает машину насовсем", () => {
    plantMark();
    decideBlock();
    foreignModal();
    enableOnSearch();
    expect(clicked()).toHaveLength(0);
    expect(warnHas("открыта модалка сайта")).toBe(true);
  });

  test("модалка подтверждения выхода ЧУЖОЙ не считается", async () => {
    // Мутант «любая модалка = стоп»: наш же confirmQuit убил бы машину.
    plantMark();
    confirmQuitModal();
    foreignModal(); // родовая обёртка вокруг живого confirmQuit
    enableOnSearch();
    // Модалка открыта НЕ нашим quit-шагом → сторож бегает и здесь.
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().at(-1)?.className).toBe("confirmQuit__content-btn");
  });

  test("сторож и в confirm-ветке: модалку открыл сам игрок, матч жив — не подтверждаем", async () => {
    // Последний путь квита мимо пробы (контрольное ревью 07.08): игрок сам
    // кликнул «Покинуть игру» до нашего шага, модалка открыта, quitAttempts=0.
    vi.mocked(sendRuntime).mockResolvedValueOnce({ live: true });
    plantMark();
    confirmQuitModal();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("в другой вкладке идёт ваш матч")).toBe(true);
  });

  test("бэкофф после действий игрока: уступаем и продолжаем сами", async () => {
    plantMark();
    decideBlock();
    history.replaceState(null, "", "/game-search");
    postgameSearchFeature.enable(ctx);
    // Первый клик уходит после ответа сторожа; дальше игрок трогает клавиатуру.
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().length).toBe(1);
    vi.mocked(safeClick).mockClear();
    vi.mocked(log.info).mockClear();

    noteTrustedInput();
    await vi.advanceTimersByTimeAsync(1400);
    domSubscriber?.();
    expect(clicked()).toHaveLength(0);
    expect(infoHas("игрок только что действовал сам")).toBe(true);
    // Бэкофф истёк — машина обязана проснуться БЕЗ единой мутации DOM
    // (повторы в пределах бюджета допустимы — важно само пробуждение).
    await vi.advanceTimersByTimeAsync(2_400);
    expect(clicked().length).toBeGreaterThanOrEqual(1);
  });

  test("«Играть» недоступна (не выбраны очереди) — решение за игроком", async () => {
    plantMark();
    playButton(true);
    enableOnSearch();
    // Выдержка статуса (8 с) идёт ДО терминального вердикта.
    await vi.advanceTimersByTimeAsync(8200);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("не выбраны очереди")).toBe(true);
  });

  test("терминальность giveUp: ожившая кнопка НЕ оживляет машину (ревью 07.08, H)", async () => {
    // Мутант «resetEpisode() удалён из giveUp» переживал старый набор:
    // «решение за игроком» обязано ОСТАВАТЬСЯ решением за игроком.
    plantMark();
    playButton(true);
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(8200);
    expect(warnHas("не выбраны очереди")).toBe(true);
    document.querySelector(".p-play__profile-button")?.removeAttribute("disabled");
    await vi.advanceTimersByTimeAsync(5000);
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(clicked()).toHaveLength(0);
  });

  test("выдержка статуса: «Играть» не трогаем, пока сайт не определится (8 с)", async () => {
    // Разбор лога 07.08 (18:29): мгновенный клик уходил при userInGame,
    // сервер отвечал in_game и сайт зажимал кнопку вечным лоадером. Владелец
    // шёл ровно с экрана победы — то есть короткой выдержки там мало.
    plantMark();
    playButton();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(3000);
    expect(clicked(), "три секунды — ещё рано").toHaveLength(0);
    expect(infoHas("ждём, пока сайт определит статус игрока")).toBe(true);
    await vi.advanceTimersByTimeAsync(5500);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-button");
  });

  test("выдержка статуса: за время ожидания появился решающий блок — идём в quit-флоу", async () => {
    plantMark();
    playButton();
    enableOnSearch();
    // 5 секунд — «Играть» на месте, но мы её не трогаем (умерший почти
    // наверняка ещё в игре, сайт просто ещё не знает).
    await vi.advanceTimersByTimeAsync(5000);
    expect(clicked()).toHaveLength(0);
    // Сайт узнал: решающий блок. Машина идёт по quit-пути, не по «Играть».
    decideBlock();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");
  });

  test("выдержка не нужна, если решающий блок уже видели: игрок разрулил его сам", async () => {
    // Мутант «decideSeen не ставится»: viewer-мост зря ждал бы 8 секунд
    // после того, как статус игрока УЖЕ был известен и разрешён человеком.
    plantMark();
    decideBlock();
    enableOnSearch(); // проба ушла, машина ждёт вердикта
    document.body.innerHTML = ""; // игрок сам вышел из игры быстрее нас
    playButton();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-button");
  });

  test("самолечение: вечный лоадер вместо «Играть» → один reload с перевзводом моста", async () => {
    plantMark();
    playLoader();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(jamReload.run)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(jamReload.run)).toHaveBeenCalledTimes(1);
    expect(warnHas("зажата лоадером")).toBe(true);
    const raw = sessionStorage.getItem(POSTGAME_PENDING_KEY);
    expect(raw, "мост перевзведён до перезагрузки").not.toBeNull();
    const mark = JSON.parse(raw as string);
    expect(mark.reloaded).toBe(true);
  });

  test("самолечение одноразовое: мост после перезагрузки второй reload не получает", async () => {
    plantMark(0, { reloaded: true });
    playLoader();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(9000);
    expect(vi.mocked(jamReload.run)).not.toHaveBeenCalled();
    expect(warnHas("не вернулась и после перезагрузки")).toBe(true);
  });

  test("настройка: модалку подтверждения можно оставить игроку", async () => {
    plantMark();
    decideBlock();
    history.replaceState(null, "", "/game-search");
    postgameSearchFeature.enable({
      settings: {
        postgame_requeue_enabled: true,
        postgame_skip_confirm_enabled: false,
      } as Settings,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");

    // Модалка открыта — машина ЖДЁТ человека, не кликает.
    confirmQuitModal();
    await vi.advanceTimersByTimeAsync(5000);
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");
    expect(
      vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("Подтвердите выход")),
    ).toBe(true);
    // Обычный 30-секундный дедлайн НЕ убивает ожидание человека.
    await vi.advanceTimersByTimeAsync(25_000);
    domSubscriber?.();
    expect(warnHas("эпизод не завершился")).toBe(false);

    // Игрок подтвердил сам: модалки и блока нет, рисуется «Играть».
    document.body.innerHTML = "";
    playButton();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(1500);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-button");
  });

  test("ожидание модалки в фоне не крутит горячий цикл (ревью, раунд 3)", async () => {
    // Мутант «hidden планирует по БАЗОВОМУ дедлайну»: после 30 с задержка
    // уходит в минус, кламцается в 50 мс — 20 тиков/с до конца ожидания.
    plantMark();
    decideBlock();
    confirmQuitModal();
    history.replaceState(null, "", "/game-search");
    postgameSearchFeature.enable({
      settings: {
        postgame_requeue_enabled: true,
        postgame_skip_confirm_enabled: false,
      } as Settings,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(infoHas("ждём подтверждения")).toBe(true);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    // Тики считаем по обращениям к DOM: латчи логов молчат со второго раза,
    // а таймер всегда один — оба «счётчика» слепы к горячему циклу.
    const qs = vi.spyOn(document, "querySelector");
    try {
      // Уже за базовым дедлайном: тут мутант и разгоняется.
      await vi.advanceTimersByTimeAsync(31_000);
      qs.mockClear();
      domSubscriber?.(); // фоновая мутация сеет тик
      await vi.advanceTimersByTimeAsync(5_000);
      expect(
        qs.mock.calls.length,
        "в фоне машина не должна тикать десятки раз в секунду",
      ).toBeLessThan(10);
    } finally {
      qs.mockRestore();
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
    }
  });

  test("игрок закрыл модалку сам — не переоткрываем её (ревью, раунд 3)", async () => {
    // Мутант «сброс waitingForConfirm без проверки decide»: машина заново
    // кликала «Покинуть игру» и переоткрывала отвергнутое окно.
    plantMark();
    decideBlock();
    history.replaceState(null, "", "/game-search");
    postgameSearchFeature.enable({
      settings: {
        postgame_requeue_enabled: true,
        postgame_skip_confirm_enabled: false,
      } as Settings,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().length).toBe(1); // наш «Покинуть игру»
    confirmQuitModal();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(500);

    // Игрок закрыл модалку крестиком: решающий блок остался — он передумал.
    document.querySelector(".confirmQuit")?.remove();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(5_000);
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(clicked().length, "второго клика по «Покинуть игру» быть не должно").toBe(1);
    expect(warnHas("отменён игроком")).toBe(true);
  });

  test("смена настройки на лету будит машину, стоящую у модалки", async () => {
    plantMark();
    decideBlock();
    history.replaceState(null, "", "/game-search");
    const manual = {
      settings: {
        postgame_requeue_enabled: true,
        postgame_skip_confirm_enabled: false,
      } as Settings,
    };
    postgameSearchFeature.enable(manual);
    await vi.advanceTimersByTimeAsync(200);
    confirmQuitModal();
    domSubscriber?.();
    // Даём истечь ВСЕМ хвостовым таймерам (после quit-клика стоит 1.3 с):
    // иначе «пробуждение» пришло бы от них, и тест был бы вакуумным.
    await vi.advanceTimersByTimeAsync(3_000);
    const beforeFlip = clicked().length;

    // Игрок передумал и включил автопропуск, страница при этом статична.
    postgameSearchFeature.update?.({
      settings: {
        postgame_requeue_enabled: true,
        postgame_skip_confirm_enabled: true,
      } as Settings,
    });
    // Секунды достаточно: пробудить обязан сам update(), а не дедлайн (150 с).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clicked().length).toBe(beforeFlip + 1);
    expect(clicked().at(-1)?.className).toBe("confirmQuit__content-btn");
  });

  test("счёт «лоадер висит подряд» обнуляется на каждой фазе, а не копится", async () => {
    // Мутант «loaderSince не сбрасывается в decide/confirm»: транзиентные
    // лоадеры разных фаз складываются и дают преждевременную перезагрузку
    // посреди легитимного quit-флоу (ревью 07.08.2026, раунд 3).
    plantMark();
    playLoader();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(5_000); // лоадер коннекта: 5 с из 8
    expect(vi.mocked(jamReload.run)).not.toHaveBeenCalled();

    // Сайт узнал статус: решающий блок. Счёт лоадера обязан обнулиться.
    document.body.innerHTML = "";
    decideBlock();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");

    // Лоадер quit-POST: ещё 5 с. Суммарно 10 с — мутант перезагрузил бы.
    document.body.innerHTML = "";
    playLoader();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(jamReload.run)).not.toHaveBeenCalled();
  });

  test("счёт лоадера обнуляется и после модалки подтверждения", async () => {
    plantMark();
    playLoader();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(5_000);

    document.body.innerHTML = "";
    confirmQuitModal();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked().at(-1)?.className).toBe("confirmQuit__content-btn");

    document.body.innerHTML = "";
    playLoader();
    domSubscriber?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(jamReload.run)).not.toHaveBeenCalled();
  });

  test("сторож: живой матч в другой вкладке — из игры не выходим (блокер A)", async () => {
    vi.mocked(sendRuntime).mockResolvedValueOnce({ live: true });
    plantMark();
    decideBlock();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(300);
    expect(clicked()).toHaveLength(0);
    expect(warnHas("в другой вкладке идёт ваш матч")).toBe(true);
    // Терминально: решающий блок больше не трогаем до нового моста.
    await vi.advanceTimersByTimeAsync(5000);
    domSubscriber?.();
    expect(clicked()).toHaveLength(0);
  });

  test("сторож: канал мёртв (undefined) — fail-open, явный клик игрока важнее", async () => {
    vi.mocked(sendRuntime).mockResolvedValueOnce(undefined);
    plantMark();
    decideBlock();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");
  });

  test("сторож: ответ завис — таймаут канала, машина не умирает молча", async () => {
    vi.mocked(sendRuntime).mockImplementationOnce(() => new Promise(() => {}));
    plantMark();
    decideBlock();
    enableOnSearch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(clicked()).toHaveLength(0);
    // 3с таймаут + собственное пробуждение: fail-open и клик.
    await vi.advanceTimersByTimeAsync(3000);
    expect(clicked().at(-1)?.className).toBe("p-play__profile-quit");
  });

  test("замершая страница: дедлайн истекает сам, без мутаций, с тостом", () => {
    plantMark();
    enableOnSearch(); // на странице вообще нет ни блока, ни кнопки
    vi.advanceTimersByTime(31_000);
    expect(warnHas("эпизод не завершился за 30 с")).toBe(true);
    expect(vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("вручную"))).toBe(
      true,
    );
  });

  test("фоновая вкладка не кликает, но дедлайн истекает и в фоне", () => {
    plantMark();
    decideBlock();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    try {
      enableOnSearch();
      vi.advanceTimersByTime(5000);
      domSubscriber?.();
      expect(clicked()).toHaveLength(0);
      expect(infoHas("вкладка в фоне")).toBe(true);
      vi.advanceTimersByTime(31_000);
      expect(warnHas("эпизод не завершился")).toBe(true);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
    }
  });

  test("ответчик пробы: живой матч ⇔ позитивные доказательства идущей игры", async () => {
    postgameSearchFeature.enable(ctx);
    const probe = async () =>
      (await messageHandler?.({ type: "postgame_live_probe" })) as { live: boolean };

    // Идущая стадия с текстом — живой.
    document.body.innerHTML = `<div class="stage"><div class="stage__name">Ночь</div></div>`;
    expect((await probe()).live).toBe(true);
    // Набор игроков — живой (увод сломал бы лобби остальным).
    document.body.innerHTML = `<div class="new-stage"><div class="new-stage__name">Идет набор</div></div>`;
    expect((await probe()).live).toBe(true);
    // Экран победы — НЕ живой: quit только что доигравшего безопасен.
    document.body.innerHTML = "";
    endedScreen("ended ended-mafia");
    expect((await probe()).live).toBe(false);
    // Мёртвая комната (экран ошибки, кейс vendettka) — НЕ живой: залежавшаяся
    // вкладка не имеет права блокировать легитимный выход умершего.
    document.body.innerHTML = `<div class="error"><div class="error__main-buttons"></div></div>`;
    expect((await probe()).live).toBe(false);
    // Зритель — НЕ живой (в т.ч. stream window).
    document.body.innerHTML = `<div class="stage"><div class="stage__name">День</div></div>`;
    history.replaceState(null, "", "/game?role=viewer&game_id=1");
    expect((await probe()).live).toBe(false);
    // Не игровая страница — НЕ живой.
    history.replaceState(null, "", "/game-search");
    document.body.innerHTML = `<div class="stage"><div class="stage__name">День</div></div>`;
    expect((await probe()).live).toBe(false);
  });

  test("SPA-вход на поиск потребляет мост, смена страницы сбрасывает эпизод", () => {
    postgameSearchFeature.enable(ctx); // мы в комнате
    plantMark();
    history.replaceState(null, "", "/game-search");
    decideBlock();
    domSubscriber?.();
    expect(infoHas("мост «В поиск» из комнаты")).toBe(true);
    expect(sessionStorage.getItem(POSTGAME_PENDING_KEY)).toBeNull();

    history.replaceState(null, "", "/");
    document.body.innerHTML = "";
    domSubscriber?.();
    expect(infoHas("эпизод «В поиск» сброшен: смена страницы")).toBe(true);
    // Возврат на поиск БЕЗ нового моста: машина обязана быть мёртвой.
    // Мутант «armed переживает смену маршрута» кликал бы по решающему блоку.
    history.replaceState(null, "", "/game-search");
    vi.mocked(safeClick).mockClear();
    decideBlock();
    vi.advanceTimersByTime(2000);
    domSubscriber?.();
    expect(clicked()).toHaveLength(0);
  });
});

describe("панель очередей у кнопки", () => {
  /** Ответ сервиса очередей — как на живом /api/search. */
  function serveQueues(standard: number): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      ok: true,
      json: async () => ({ queues: { standard: { players: standard } } }),
    }));
  }

  test("появляется и исчезает вместе с кнопкой", async () => {
    vi.stubGlobal("fetch", serveQueues(3));
    endedScreen("ended ended-mafia");
    postgameSearchFeature.enable(ctx);
    const panel = document.getElementById(QUEUES_ID);
    expect(panel).not.toBeNull();
    await vi.waitFor(() => expect(panel!.textContent).toContain("Обычный 3"));

    document.body.innerHTML = "";
    domSubscriber?.();
    expect(document.getElementById(QUEUES_ID), "кнопки нет — и панели нет").toBeNull();
    vi.unstubAllGlobals();
  });

  test("нажатие даёт отклик, а не тихо блокирует кнопку", async () => {
    // Цифры при повторной загрузке те же, и без смены подписи человек не
    // понимает, сработал ли клик.
    let release: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      return { ok: true, json: async () => ({ queues: { standard: { players: 5 } } }) };
    }));
    endedScreen("ended ended-mafia");
    postgameSearchFeature.enable(ctx);
    const refresh = document.querySelector<HTMLButtonElement>(`#${QUEUES_ID} button`)!;
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(refresh.textContent, "во время запроса подпись меняется").toBe("Обновляю…");
    expect(refresh.disabled).toBe(true);

    release!();
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    expect(refresh.textContent).toContain("Обновить");
    vi.unstubAllGlobals();
  });

  test("панель сняли во время запроса — в неё уже не пишем", async () => {
    // Игрок ушёл со страницы конца игры, пока летел ответ. Запись в снятый
    // узел бесполезна, а следующий показ грузит заново.
    let release: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      return { ok: true, json: async () => ({ queues: { standard: { players: 7 } } }) };
    }));
    endedScreen("ended ended-mafia");
    postgameSearchFeature.enable(ctx);
    const panel = document.getElementById(QUEUES_ID)!;
    await vi.waitFor(() => expect(release).not.toBeNull());

    document.body.innerHTML = "";
    domSubscriber?.();
    release!();
    // Ответ доезжает через несколько микрозадач (fetch → json → разбор):
    // двух await не хватало, и тест проходил даже без защиты.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(panel.textContent, "в снятую панель ничего не дописано").not.toContain("Обычный 7");
    vi.unstubAllGlobals();
  });

  test("кнопка обновления подписана словом, а не одним значком", async () => {
    // Глиф рисуется системным шрифтом и на части машин выходит квадратиком —
    // промахнуться по единственной кнопке панели нельзя.
    vi.stubGlobal("fetch", serveQueues(1));
    endedScreen("ended ended-mafia");
    postgameSearchFeature.enable(ctx);
    const refresh = document.querySelector<HTMLButtonElement>(`#${QUEUES_ID} button`)!;
    // В покое, а не во время первой загрузки: там подпись своя.
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    expect(refresh.textContent).toMatch(/Обновить/);
    vi.unstubAllGlobals();
  });
});
