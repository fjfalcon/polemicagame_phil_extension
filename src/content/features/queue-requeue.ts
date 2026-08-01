/**
 * Фича: автовозврат в поиск после развала собранного лобби.
 *
 * Боль (владелец, 30.07.2026): «встаём в поиск → лобби собралось, но не все
 * успели нажать готовность → лобби разваливается → заново нужно встать в
 * поиск». Большинство не успевает пройти путь «На главную → Поиск → Играть»
 * — и выпадает из ротации.
 *
 * Развал случается на ДВУХ этапах (флоу сверен с бандлами сайта и живой
 * распущенной комнатой 31.07.2026):
 *
 * ЭТАП 1 — страница поиска (/game-search): «Принять игру» → «Готовы: N/10»;
 *   кто-то не принял → группа падает, игрок остаётся на странице поиска с
 *   кнопкой «Играть». Детект принятия: блок `.p-play__profile-accept` теряет
 *   `cursor-pointer` (бандл game-search, ветка searchState.group).
 *   Машина: блок исчез → секундомер? (сайт сам вернул, выходим) →
 *   «Игра запускается»? (стартуем, ждём редиректа) → кнопка «Играть» в
 *   течение ARM_WINDOW_MS → развал: кликаем.
 *
 * ЭТАП 2 — комната (/game, POST-переход после on_game_found): игроки жмут
 *   кнопку «Готов» (vote {type: game_start}); не все успели → сервер шлёт
 *   on_game_disbandment, и комната показывает ОБРАТНЫЙ ОТСЧЁТ «Игра будет
 *   распущена через MM:SS» (`.disbandment-timer`, бандл комнаты). Когда он
 *   истекает, комната мертва, но экран сам по себе не меняется: игрок сидит
 *   и ждёт (жалоба 01.08.2026), а кнопка сайта «На главную» ведёт на origin
 *   (`finishGameLink: location.origin`) — оттуда до поиска ещё два клика.
 *   Поэтому: отсчёт + наша готовность (`.player.my-player .player__readiness`)
 *   → ставим одноразовый мост в sessionStorage → как отсчёт исчезнет и за
 *   DISBAND_GRACE_MS не появится игровая стадия (значит не «все успели»),
 *   сами уходим на /game-search. Если игрок ушёл раньше нас — мост
 *   отработает на любой другой странице (elsewhereTick) и доведёт до поиска.
 *   На странице поиска мост взводит ту же машину клика «Играть» со всеми
 *   предохранителями.
 *
 * ГЛАВНЫЙ ПРЕДОХРАНИТЕЛЬ (оба этапа): возвращаем ТОЛЬКО того, кто сам
 * подтвердил игру (принял / нажал «Готов»). Кто не подтвердил — сам решил
 * не играть или отошёл; вернув его, мы зациклим порчу лобби для остальных.
 *
 * Окна ограничены: клик «Играть» спустя произвольное время по забытому
 * состоянию — ровно тот сюрприз, которого быть не должно.
 */
import { onDomChange, safeClick, isVisible } from "@core/dom";
import { SITE, TEXT } from "@core/selectors";
import { isGameRoomPath, isSearchPath } from "@shared/routes";
import { log } from "@core/log";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const SCOPE = "queue-requeue";

/** Сколько ждём появления «Играть» после исчезновения блока принятия. */
const ARM_WINDOW_MS = 8000;
/** Кнопку могло перерисовать под кликом — повторяем, но не бесконечно. */
const MAX_CLICK_ATTEMPTS = 3;
/** Тики идут каждые ~250мс — без паузы 3 попытки улетели бы за секунду. */
const MIN_CLICK_INTERVAL_MS = 1200;
/** «Игра запускается» — стартующее лобби, а не развал (ветка processing). */
const GAME_STARTING_SELECTOR = ".p-play__profile-game-loader";
/**
 * Сайтовые модалки страницы поиска. Если после нашего клика сервер ответил
 * illegalState=game_search (рассинхрон: сервер ещё держит игрока в поиске),
 * сайт показывает модалку «Игра уже ищется» — дальше решает ИГРОК, повторные
 * клики под модалкой запрещены. Классы сверены с бандлом game-search:
 * компонент — `<modal class="modal modal-break-search" name="break-search">`
 * (vue-js-modal); generic `.modal` оставлен как страховка на другие модалки —
 * скрытые узлы отсеивает проверка видимости в siteModalOpen().
 */
const SITE_MODAL_SELECTOR = ".modal-break-search, .v--modal-overlay, .vm--overlay, .modal";

// ── этап 2: комната ──

/**
 * Сколько ждать после исчезновения отсчёта, прежде чем считать комнату
 * распущенной. Отсчёт исчезает в ДВУХ случаях: время вышло (роспуск) и
 * `gameDidStart` (все успели). Второй случай отсекается ДВАЖДЫ: по последнему
 * показанному значению (ниже) и по появлению игровой стадии за эту паузу.
 * 12с, а не 5: цена ошибки — выдернуть игрока из начавшегося матча, а первая
 * стадия может прийти отдельным сообщением уже после старта.
 */
const DISBAND_GRACE_MS = 12_000;
/**
 * Отсчёт, исчезнувший на значении больше этого, — признак СТАРТА игры, а не
 * роспуска: при роспуске он доходит до ~00:00. Три секунды запаса на то, что
 * между последним увиденным тиком и исчезновением прошло время.
 */
const DISBAND_ZERO_TOLERANCE_S = 3;
/** Одноразовый мост «комната умерла → страница поиска»: sessionStorage. */
const PENDING_KEY = "pn_requeue_pending";
/** Свежесть флага: переход + загрузка страницы поиска должны уложиться. */
const PENDING_TTL_MS = 45_000;

let settings: Settings | null = null;
let unsubscribe: (() => void) | null = null;

/** Игрок принял игру в ТЕКУЩЕМ сборе лобби. */
let accepted = false;
/** Взведение пришло мостом из распущенной комнаты (для честного тоста). */
let armedFromRoom = false;
/** Момент исчезновения accept-блока (0 — ещё виден/не был). */
let disappearedAt = 0;
let attempts = 0;
let lastClickAt = 0;

/** Есть ли на странице ВИДИМАЯ сайтовая модалка (у скрытых нет размеров). */
function siteModalOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(SITE_MODAL_SELECTOR)).some(
    (el) => el.offsetWidth > 0 && el.offsetHeight > 0,
  );
}

let toast: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Последнее НАСТОЯЩЕЕ действие игрока (isTrusted) — автоклик обязан уступать
 *  дорогу человеку (инвариант AGENTS.md §4 п.2: бэкофф после ручных действий). */
let lastTrustedInputAt = 0;
let trustedListener: ((e: Event) => void) | null = null;
/** Когда вкладку спрятали при живом accepted (окно сверяется на возврате). */
let hiddenAt = 0;
let visibilityListener: (() => void) | null = null;

// ── состояние этапа 2 (комната) ──

/**
 * Состояние комнаты живёт до `disable()`, а роутер (content/index.ts)
 * queue-requeue не перезапускает: вход в комнату — это полная загрузка
 * страницы. Если сайт когда-нибудь сделает комнату SPA-маршрутом, вторая
 * комната в той же вкладке унаследует `gameStarted = true` — то есть ровно тот
 * баг, который чинили 02.08.2026. Тогда состояние надо будет сбрасывать по
 * смене URL.
 */
/** Игрок нажал «Готов» в ЭТОЙ комнате (отметка на своей плитке). */
let roomReady = false;
/** Видели игровую стадию — матч состоялся, возвраты запрещены до ухода. */
let gameStarted = false;
/** Переход на поиск уже инициирован — не кликать ссылку повторно. */
let roomExitDone = false;
/** Видели обратный отсчёт роспуска в этой комнате. */
let disbandmentSeen = false;
/** Про отсчёт уже написали в лог (пишем один раз на комнату, даже без готовности). */
let disbandmentLogged = false;
/** Момент исчезновения отсчёта (0 — виден или ещё не появлялся). */
let disbandmentGoneAt = 0;
/** Последнее прочитанное значение отсчёта в секундах (-1 — не читали). */
let disbandmentLastSeconds = -1;
/** Отложенный тик: DOM в распущенной комнате замирает, мутаций больше нет. */
let graceTimer: ReturnType<typeof setTimeout> | null = null;
/** Уход с посторонней страницы уже инициирован. */
let elsewhereDone = false;
/** Мост для этапа 1 уже поставлен в этом сборе лобби. */
let acceptArmed = false;

function isGameRoomPage(): boolean {
  return isGameRoomPath(location.pathname);
}

function norm(text: string | null | undefined): string {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Матч ИДЁТ (день/ночь/голосование), а не «комната только что открылась».
 *
 * Проверять сам `.stage` нельзя — и это была причина, по которой этап 2 не
 * работал НИКОГДА (жалоба 01.08.2026, разбор лога 02.08.2026). Роллер сайта
 * выбирает ветку `.new-stage` ровно при `stage.type === voting_for_game_start`,
 * а во ВСЕХ остальных случаях рисует `.stage` — включая первые секунды после
 * загрузки комнаты, пока состояние игры ещё не пришло по сокету. Узел в этот
 * момент пустой, но он ЕСТЬ: фича видела его на первом же тике, ставила
 * `gameStarted` и молча выключала себя на всю жизнь страницы.
 */
function matchIsRunning(): boolean {
  // Пауза/промах/итог игры рисуются вместо роллера, стадии там нет вообще —
  // но все три бывают только после старта матча (ревью 02.08.2026).
  if (document.querySelector(SITE.roomFixedState)) return true;
  // Экран набора игроков — доказательство, что матч ещё не начался.
  if (document.querySelector(SITE.pregameScreen)) return false;
  // Непустой текст обязателен: в свежезагруженной комнате сайт рисует ТРИ
  // пустых `.substage` (массив substages в data фиксирован: current/next/temp,
  // а текст берётся из ещё не пришедшей стадии).
  return Array.from(document.querySelectorAll<HTMLElement>(SITE.runningStageMarkers)).some(
    (el) => norm(el.textContent).length > 0,
  );
}

/**
 * Игрок подтвердил готовность в этой комнате. Два независимых признака:
 *  1. отметка «Готов» на своей плитке;
 *  2. кнопка готовности в контролах с классом `active` — сайт вешает его
 *     ровно при `votingForGameStart.voted`.
 * Второй нужен потому, что первый держится на вёрстке плитки и на её
 * ВИДИМОСТИ: старая проверка брала первый узел в документе и требовала
 * offsetWidth > 0 — то есть молча отвечала «не готов» на любую разметку, где
 * отметка отрисована иначе.
 */
function readyConfirmed(): boolean {
  const marks = Array.from(document.querySelectorAll<HTMLElement>(SITE.myReadinessMark));
  if (marks.some((el) => el.offsetWidth > 0 || isVisible(el))) return true;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SITE.readyButton))) {
    // Текст опознаёт КНОПКУ (точное совпадение, §4 п.2 — никаких подстрок:
    // «Не готов» содержит «готов»), класс active — НАЖАТА ли готовность. Обе
    // подписи кнопки одинаковы («Готов»), без класса состояние не отличить.
    // Хрупкость: в шаблоне ControlsButton есть спан хоткея button__command,
    // сейчас ЗАКОММЕНТИРОВАННЫЙ. Если сайт его включит, textContent станет
    // «RГотов» и признак молча умрёт — останется только отметка на плитке.
    if (!(TEXT.readyButton as readonly string[]).includes(norm(el.textContent))) continue;
    if (el.classList.contains(SITE.readyButtonActiveClass)) return true;
  }
  return false;
}

/** Тик комнаты: следим за готовностью и смертью комнаты. */
function roomTick(): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) return;
  if (gameStarted) return;

  if (matchIsRunning()) {
    gameStarted = true;
    disbandmentSeen = false;
    disbandmentGoneAt = 0;
    disbandmentLastSeconds = -1;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    // Игра всё-таки началась — мост обязан умереть, иначе он утащил бы
    // игрока в поиск прямо из матча (или после его конца).
    clearPending();
    log.info(SCOPE, "матч начался — возвраты в поиск выключены до ухода со страницы");
    return;
  }

  if (!roomReady && readyConfirmed()) {
    roomReady = true;
    log.info(SCOPE, "готовность подтверждена — этап 2 на страже");
  }

  // ── обратный отсчёт роспуска ──
  const timer = document.querySelector<HTMLElement>(SITE.disbandmentTimer);
  const timerVisible = !!timer && isVisible(timer);
  // Отсчёт логируем ДО гейта готовности: иначе по логу пользователя нельзя
  // отличить «сайт не показал отсчёт» от «мы не увидели готовность», и
  // разбор жалобы упирается в догадки (разбор лога 02.08.2026).
  if (timerVisible && !disbandmentLogged) {
    disbandmentLogged = true;
    log.info(SCOPE, "виден обратный отсчёт роспуска; готовность подтверждена:", roomReady);
  }
  if (!roomReady || roomExitDone) return;

  if (timer && timerVisible) {
    if (!disbandmentSeen) {
      disbandmentSeen = true;
      log.info(SCOPE, "идёт обратный отсчёт роспуска — готовимся вернуться в поиск");
      // Мост ставим СРАЗУ, а не в момент ухода: дальше игрока может увести
      // сам сайт или он сам нажмёт «На главную» (кнопка ведёт на origin, а
      // не на страницу поиска) — тогда наш код в комнате уже не выполнится.
      armPending();
    }
    // Непонятую строку НЕ записываем: -1 неотличим от «досчитал до нуля», а
    // это ветка «комнату распустили» — то есть игрока выдернуло бы из,
    // возможно, стартующего матча. Держим последнее прочитанное значение.
    // Ограничение: если сайт сменит формат ЦЕЛИКОМ, первое же чтение даст -1
    // и держать будет нечего — тогда поведение прежнее, как до этой правки.
    const seconds = parseCountdownSeconds(timer.textContent);
    if (seconds >= 0) disbandmentLastSeconds = seconds;
    disbandmentGoneAt = 0;
    return;
  }
  // Отсчёт был и пропал: либо время вышло (роспуск), либо все успели и игра
  // стартовала.
  if (disbandmentSeen && !disbandmentGoneAt) {
    // Первый дискриминатор — последнее показанное значение: при роспуске
    // отсчёт доходит до ~00:00, при старте игры гаснет на произвольном.
    if (disbandmentLastSeconds > DISBAND_ZERO_TOLERANCE_S) {
      log.info(
        SCOPE,
        "отсчёт погас на",
        disbandmentLastSeconds,
        "с — игра стартует, не вмешиваемся",
      );
      gameStarted = true;
      clearPending();
      return;
    }
    disbandmentGoneAt = Date.now();
    // DOM распущенной комнаты замирает: мутаций больше не будет, а tick()
    // ходит только от них — без своего таймера пауза не истекла бы НИКОГДА
    // (ровно то «ничего не происходит», ради чего фича и переписана).
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      tick();
    }, DISBAND_GRACE_MS + 250);
    return;
  }

  const deadLink = document.querySelector<HTMLElement>(SITE.roomDeadLink);
  const errorScreenDead = !!deadLink && isVisible(deadLink);
  const graceExpired =
    disbandmentSeen && disbandmentGoneAt > 0 && Date.now() - disbandmentGoneAt > DISBAND_GRACE_MS;
  if (!errorScreenDead && !graceExpired) return;

  // «Попробовать снова» = обрыв СВЯЗИ, а не распуск: комната может быть
  // жива, и наш уход в очередь бросил бы девятерых ждать десятого.
  const retry = document.querySelector<HTMLElement>(SITE.roomRetryButton);
  if (retry && isVisible(retry)) {
    log.debug(SCOPE, "экран с «Попробовать снова» — обрыв связи, не вмешиваемся");
    return;
  }

  // Те же правила, что и на поиске: не в фоне и не поперёк живого человека.
  if (document.hidden) return;
  if (Date.now() - lastTrustedInputAt < USER_BACKOFF_MS) return;

  roomExitDone = true;
  armPending();
  // Тост здесь не рисуем: страница сейчас сменится, плашка мелькнёт на
  // миллисекунды. О возврате скажет тост на странице поиска (armedFromRoom).
  log.info(SCOPE, "комната распущена после готовности — уходим на страницу поиска");
  if (deadLink && isVisible(deadLink)) {
    // Если сайт показал свою ссылку — идём по ней (обычная навигация сайта).
    deadLink.click();
  } else {
    // Обычный случай: комната просто «умерла» без экрана ошибки, и уйти с
    // неё может только тот, кто знает куда. Кнопка сайта «На главную» ведёт
    // на origin, откуда игроку пришлось бы жать «Поиск» руками — ради этого
    // фича и делалась.
    location.assign("/game-search");
  }
}

/** Одноразовый мост «комната распускается → страница поиска». */
function armPending(): void {
  try {
    sessionStorage.setItem(PENDING_KEY, String(Date.now()));
  } catch {
    /* приватный режим — просто перейдём без автоклика на поиске */
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* приватный режим */
  }
}

/**
 * «MM:SS» → секунды; -1, если распарсить не удалось.
 *
 * Границы по цифрам обязательны: без них «100:30» матчилось внутренним куском
 * «00:30» и трёхминутный отсчёт читался как тридцать секунд. Секунды строго
 * `[0-5]\d` — «1:60» такого времени не бывает, и принимать его за 120 с
 * значит доверять строке, которую мы не поняли (тест-набор 01.08.2026, №7).
 */
export function parseCountdownSeconds(text: string | null): number {
  const m = /(?<!\d)(\d{1,3}):([0-5]\d)(?!\d)/.exec(text || "");
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Мы НЕ в комнате и НЕ на поиске (например, сайт увёл на главную или игрок
 * сам нажал «На главную»), но мост из распускающейся комнаты свежий — значит
 * человек нажал «Готов», лобби развалилось, и он ждёт возврата в поиск.
 * Доводим его до страницы поиска; клик «Играть» сделает этап 1.
 */
function elsewhereTick(): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) return;
  if (elsewhereDone) return;
  // ТОЛЬКО корень сайта — именно туда ведёт кнопка выхода из комнаты
  // (`finishGameLink: location.origin`). На профиле, странице матча и прочих
  // мост игнорируем: игрок ушёл туда сам и не ждёт, что его куда-то унесёт.
  if (location.pathname !== "/") return;
  if (document.hidden) return;
  if (Date.now() - lastTrustedInputAt < USER_BACKOFF_MS) return;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  const age = Date.now() - Number(raw);
  if (!Number.isFinite(age) || age < 0 || age > PENDING_TTL_MS) return;
  elsewhereDone = true;
  log.info(SCOPE, "мост из распущенной комнаты — ведём на страницу поиска");
  location.assign("/game-search");
}

/**
 * Мост с этапа 2: комната умерла → мы перешли на поиск → если флаг свежий,
 * взводим машину клика «Играть» (все её предохранители работают как обычно).
 * Флаг одноразовый: снимается при первом же чтении.
 */
function consumePendingFromRoom(): void {
  if (!isSearchPage()) return;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
    if (raw !== null) sessionStorage.removeItem(PENDING_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  const ts = Number(raw);
  const age = Date.now() - ts;
  // age < 0 — метка из БУДУЩЕГО: sessionStorage принадлежит сайту (AGENTS.md
  // §5), и значение Date.now()+1e12 выглядело «вечно свежим» (аудит
  // безопасности 01.08.2026, №15).
  if (!Number.isFinite(ts) || age < 0 || age > PENDING_TTL_MS) return;
  accepted = true;
  armedFromRoom = true;
  disappearedAt = Date.now();
  log.info(SCOPE, "пришли из распущенной комнаты — взводим автоклик «Играть»");
}

/** Пауза после ручного действия: игрок у панели — не вмешиваемся. */
const USER_BACKOFF_MS = 2000;

function isSearchPage(): boolean {
  return isSearchPath(location.pathname);
}

function reset(): void {
  accepted = false;
  acceptArmed = false;
  armedFromRoom = false;
  disappearedAt = 0;
  attempts = 0;
  lastClickAt = 0;
}

function showToast(text: string): void {
  removeToast();
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483600;
    background: #161c2c; color: #e6e9f0; border: 1px solid rgba(255,255,255,.15);
    border-radius: 10px; padding: 10px 14px; font: 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 8px 30px rgba(0,0,0,.45); max-width: 300px;
  `;
  document.body.appendChild(el);
  toast = el;
  toastTimer = setTimeout(removeToast, 4000);
}

function removeToast(): void {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toast?.remove();
  toast = null;
}

function tick(): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) {
    reset();
    return;
  }
  if (!isSearchPage()) {
    reset();
    // Этап 2: в комнате своя машина (готовность → роспуск → уход).
    if (isGameRoomPage()) roomTick();
    // Прочие страницы (главная и т.п.): довести до поиска, если мост свежий.
    else elsewhereTick();
    return;
  }

  const acceptEl = document.querySelector<HTMLElement>(SITE.profileAccept);
  if (acceptEl) {
    disappearedAt = 0;
    attempts = 0;
    // ДВУСТОРОННЕЕ присваивание, не «односторонний if»: если развал лобби A
    // и сборка лобби B уложились в один тик, cursor-pointer на месте — это
    // НОВОЕ, не принятое лобби, и accepted обязан сброситься. Иначе клик
    // «Играть» ушёл бы за игрока, который решил B не принимать (ревью №2).
    accepted = !acceptEl.classList.contains("cursor-pointer");
    // Мост переживает ПЕРЕЗАГРУЗКУ: сайт на `on_stop_game_search` с причиной
    // game_not_accepted делает window.location.reload() (сверено с бандлом
    // game-search), и наши accepted/disappearedAt умирали вместе со страницей
    // — этап 1 не срабатывал вообще (аудит устойчивости 01.08.2026, №3).
    if (accepted && !acceptArmed) {
      acceptArmed = true;
      armPending();
    }
    return;
  }
  if (!accepted) return;

  // Блок принятия исчез — выясняем, куда всё повернулось.
  if (document.querySelector(SITE.searchInProgress)) {
    // Сайт сам вернул игрока в очередь — не дублируем.
    clearPending();
    reset();
    return;
  }
  if (document.querySelector(GAME_STARTING_SELECTOR)) {
    // Все приняли, игра запускается — сейчас уведут со страницы. Мост обязан
    // умереть: иначе возврат на страницу поиска в пределах TTL (например,
    // игрок вышел из начавшейся игры) принял бы его за развал лобби.
    clearPending();
    disappearedAt = 0;
    return;
  }

  const now = Date.now();
  if (!disappearedAt) disappearedAt = now;
  if (now - disappearedAt > ARM_WINDOW_MS) {
    log.debug(SCOPE, "окно возврата истекло — не вмешиваемся");
    reset();
    return;
  }

  // Сайт открыл модалку (например «Вы уже в поиске» при рассинхроне с
  // сервером) — дальше решает игрок, автоклики прекращаем.
  if (siteModalOpen()) {
    log.warn(SCOPE, "открыта модалка сайта — прекращаем автоповтор");
    reset();
    return;
  }

  const play = document.querySelector<HTMLButtonElement>(SITE.profileSearchButton);
  if (!play || !isVisible(play)) return; // скелетон загрузки — ждём в пределах окна
  if (play.disabled || play.hasAttribute("disabled")) {
    // Не выбраны очереди — решение за игроком, не за нами.
    reset();
    return;
  }
  if (attempts >= MAX_CLICK_ATTEMPTS) {
    log.warn(SCOPE, "«Играть» не сработала за", MAX_CLICK_ATTEMPTS, "попытки — сдаёмся");
    reset();
    return;
  }
  if (now - lastClickAt < MIN_CLICK_INTERVAL_MS) return; // пауза между попытками
  // Игрок только что кликал/печатал сам — он у панели, дорога его (ревью №3).
  if (now - lastTrustedInputAt < USER_BACKOFF_MS) return;
  // Фоновая вкладка = игрока может не быть у экрана: клик запрещён, но гейт
  // стоит ИМЕННО ЗДЕСЬ, в кликовой секции — состояние и окно выше живут и в
  // фоне (dom.ts тикает таймером), и окно честно истекает. Ранний return в
  // начале tick замораживал disappearedAt=0 — возврат на вкладку спустя
  // минуты начинал окно заново и кликал по забытому состоянию (ревью, р.3).
  if (document.hidden) return;
  attempts++;
  lastClickAt = now;
  log.info(SCOPE, "лобби развалилось — возвращаем в поиск, попытка", attempts);
  // Формулировка без аванса: подтверждение старта — секундомер сайта.
  // Для пути «из комнаты» текст свой: про развал лобби поиска он бы врал.
  if (attempts === 1) {
    showToast(
      armedFromRoom ? "Снова встаю в поиск… 🔁" : "Лобби развалилось — возвращаю в поиск… 🔁",
    );
  }
  safeClick(play);
  // accepted намеренно не сбрасываем: успех виден по секундомеру поиска
  // (ветка searchInProgress выше сделает reset), а неуспех повторит клик.
}

export const queueRequeueFeature: Feature = {
  id: "queue-requeue",
  settingKey: "requeue_after_lobby_fail_enabled",

  enable(ctx: FeatureContext) {
    settings = ctx.settings;
    // isTrusted отсекает наши же синтетические клики (как в auto-start).
    trustedListener = (e: Event) => {
      if (e.isTrusted) lastTrustedInputAt = Date.now();
    };
    document.addEventListener("pointerdown", trustedListener, true);
    document.addEventListener("keydown", trustedListener, true);
    // Герметичность окна в фоне: тики идут от мутаций, а в совсем тихой
    // фоновой вкладке их может не быть вовсе — тогда disappearedAt не
    // проверился бы ни разу. На возврат сверяем окно явно.
    visibilityListener = () => {
      if (document.hidden) {
        if (accepted) hiddenAt = Date.now();
        return;
      }
      // Отсутствовали дольше окна — контекст протух независимо от того, что
      // происходило в фоне; пусть игрок решает сам.
      if (accepted && hiddenAt && Date.now() - hiddenAt > ARM_WINDOW_MS) reset();
      hiddenAt = 0;
      tick();
    };
    document.addEventListener("visibilitychange", visibilityListener);
    // Пришли на страницу поиска из распущенной комнаты? (одноразовый флаг)
    consumePendingFromRoom();
    unsubscribe = onDomChange(() => tick());
    tick();
  },

  update(ctx: FeatureContext) {
    settings = ctx.settings;
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    if (trustedListener) {
      document.removeEventListener("pointerdown", trustedListener, true);
      document.removeEventListener("keydown", trustedListener, true);
      trustedListener = null;
    }
    if (visibilityListener) {
      document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
    }
    hiddenAt = 0;
    roomReady = false;
    gameStarted = false;
    roomExitDone = false;
    disbandmentSeen = false;
    disbandmentLogged = false;
    disbandmentGoneAt = 0;
    disbandmentLastSeconds = -1;
    elsewhereDone = false;
    acceptArmed = false;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    removeToast();
    reset();
    settings = null;
  },
};
