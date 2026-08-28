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
 *
 * ПРИНЦИП ЖИВУЧЕСТИ (аудит автовозврата 03.08.2026, RQ-3): тики приходят от
 * мутаций DOM, а DOM распущенной комнаты и застывшей страницы поиска НЕ
 * мутирует. Поэтому каждая ветка «подождём и решим позже» обязана владеть
 * собственной точкой пробуждения — общим decision-таймером ниже. Ветка,
 * которая возвращает управление без таймера и без внешнего события
 * (visibilitychange, навигация), — это молчаливая смерть машины.
 */
import { onDomChange, safeClick, isVisible } from "@core/dom";
import { SITE, TEXT } from "@core/selectors";
import { isGameRoomPath, isSearchPath } from "@shared/routes";
import { log } from "@core/log";
import { showToast } from "@core/toast";
import { parseMark, refreshMark, validateMark, serializeMark } from "./requeue-pending";
import type { MarkFailure } from "./requeue-pending";
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
const GAME_STARTING_SELECTOR = SITE.gameStartingLoader;
/**
 * Сайтовые модалки страницы поиска. Если после нашего клика сервер ответил
 * illegalState=game_search (рассинхрон: сервер ещё держит игрока в поиске),
 * сайт показывает модалку «Игра уже ищется» — дальше решает ИГРОК, повторные
 * клики под модалкой запрещены. Классы сверены с бандлом game-search:
 * компонент — `<modal class="modal modal-break-search" name="break-search">`
 * (vue-js-modal); generic `.modal` оставлен как страховка на другие модалки —
 * скрытые узлы отсеивает проверка видимости в siteModalOpen().
 */
const SITE_MODAL_SELECTOR = SITE.siteModals;

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
/**
 * Период планового освежения метки на странице поиска. Нужен отдельный:
 * секундомер принятия сайт (Vue 2) обновляет через textContent текстового
 * узла — это characterData-мутация, которую наш общий наблюдатель НЕ слушает
 * (childList + class/style). Без своего пробуждения принятый блок не давал
 * бы ни одного тика, и метка протухала бы при живом условии (RQ-4).
 */
const PENDING_REFRESH_MS = 10_000;
/** Человекочитаемые причины отказа метки — в лог поддержки. */
const MARK_FAILURE_TEXT: Record<MarkFailure, string> = {
  corrupt: "метка повреждена",
  future: "метка из будущего",
  expired: "метка устарела",
  capped: "эпизод старше потолка",
};

let settings: Settings | null = null;
let unsubscribe: (() => void) | null = null;

// ── единый decision-таймер (RQ-3) ──

/**
 * Пауза перед ПЕРВЫМ решением после возвращения вкладки на экран. Игрок
 * возвращает фокус окну кликом В СТРАНИЦУ, и порядок pointerdown /
 * visibilitychange не определён: решать синхронно значит либо попасть в
 * бэкофф без следующего тика, либо навигировать поперёк живого клика
 * (аудит автовозврата 03.08.2026, RQ-6). Пауза даёт клику фокуса лечь в
 * бэкофф, а бэкофф — запланировать своё пробуждение.
 */
const FOREGROUND_GRACE_MS = 300;
/** Ниже не планируем: нулевые задержки складываются в горячий цикл. */
const MIN_DECISION_DELAY_MS = 50;

let decisionTimer: ReturnType<typeof setTimeout> | null = null;
/** Когда сработает запланированное решение (0 — не запланировано). */
let decisionAt = 0;

/**
 * Запланировать tick() через delayMs. Таймер ОДИН и коалесцированный:
 * побеждает самое раннее время. Ложное пробуждение безвредно — tick()
 * идемпотентен и пересчитывает всё из текущего состояния; ветка, которой
 * ещё рано, обязана перепланировать себя сама.
 */
function scheduleDecision(delayMs: number): void {
  const at = Date.now() + Math.max(delayMs, MIN_DECISION_DELAY_MS);
  if (decisionTimer && decisionAt <= at) return;
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionAt = at;
  decisionTimer = setTimeout(
    () => {
      decisionTimer = null;
      decisionAt = 0;
      tick();
    },
    Math.max(delayMs, MIN_DECISION_DELAY_MS),
  );
}

function cancelDecision(): void {
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionTimer = null;
  decisionAt = 0;
}

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

/** Последнее НАСТОЯЩЕЕ действие игрока (isTrusted) — автоклик обязан уступать
 *  дорогу человеку (инвариант AGENTS.md §4 п.2: бэкофф после ручных действий). */
let lastTrustedInputAt = 0;

/**
 * Отметить настоящее действие игрока. Доверенность (isTrusted) проверяет
 * слушатель; экспорт — тестовый шов: jsdom не умеет создавать доверенные
 * события, а бэкофф-ветки обязаны быть покрыты мутационными тестами.
 */
export function noteTrustedInput(): void {
  lastTrustedInputAt = Date.now();
}
let trustedListener: ((e: Event) => void) | null = null;
/** Слушатель доверенных кликов для латча намерения (RQ-2). */
let intentListener: ((e: Event) => void) | null = null;
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
/**
 * Когда значение отсчёта в ПОСЛЕДНИЙ РАЗ МЕНЯЛОСЬ. Именно менялось, а не
 * читалось: в спрятанной вкладке сайт останавливает анимационный цикл, текст
 * замирает, и повторное чтение того же значения «освежало» бы протухший
 * сэмпл. По возвращении вкладки сайт одним колбэком вычитает всю паузу и
 * убирает отсчёт БЕЗ промежуточного «00:00» — старое значение >3 с тогда
 * значит «мы проспали конец», а не «игра стартует» (аудит 03.08.2026, RQ-1).
 */
let disbandmentSampleChangedAt = 0;
/**
 * Свежесть сэмпла: отсчёт при видимой вкладке меняется раз в секунду, тики
 * дросселируются на 250 мс — 3 секунды покрывают оба зазора с запасом.
 */
const SAMPLE_FRESH_MS = 3000;
/** Уход с посторонней страницы уже инициирован. */
let elsewhereDone = false;
/** Про недоступное хранилище на главной уже сказали (не на каждый тик). */
let elsewhereStorageWarned = false;
/** Про невозможность сохранить мост уже сказали (освежение идёт на каждом тике). */
let armStorageWarned = false;
/** Мост для этапа 1 уже поставлен в этом сборе лобби. */
let acceptArmed = false;
/** Про отложенный из-за действий игрока клик уже сказали (не на каждый тик). */
let backoffLogged = false;
/**
 * Про отложенный выход из распущенной комнаты уже сказали — ОТДЕЛЬНО по
 * каждой причине: один общий латч глушил бы две другие до конца жизни
 * страницы, и в файле оставалась бы не та причина (ревью 02.08.2026).
 */
const roomExitDeferLogged = { hidden: false, userInput: false, retryScreen: false };
/** Про «лобби стартует» уже сказали. */
let gameStartingLogged = false;
/** Про неоднозначный экран ошибки уже сказали (один исход на эпизод). */
let ambiguousErrorLogged = false;
/** Неготовому игроку уже ответили (лог + тост, один раз на эпизод). */
let notReadyAnnounced = false;

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
/** Текст стадии говорит об ИДУЩЕМ матче (а не об ожидании его начала). */
export function isRunningStageText(text: string): boolean {
  if (text.length === 0) return false;
  return !(TEXT.waitingForGameStage as readonly string[]).some((m) => text.includes(m));
}

function matchIsRunning(): boolean {
  // Пауза/промах/итог игры рисуются вместо роллера, стадии там нет вообще —
  // но все три бывают только после старта матча (ревью 02.08.2026).
  if (document.querySelector(SITE.roomFixedState)) return true;
  // Экран набора игроков — доказательство, что матч ещё не начался.
  if (document.querySelector(SITE.pregameScreen)) return false;
  // Непустой текст обязателен: в свежезагруженной комнате сайт рисует ТРИ
  // пустых `.substage` (массив substages в data фиксирован: current/next/temp,
  // а текст берётся из ещё не пришедшей стадии).
  //
  // И этого мало: пока состояние комнаты не пришло, `gameView` не определён,
  // тернарник роллера уходит в ветку ОБЫЧНОЙ стадии (не «набор игроков») и
  // пишет «Ожидание начала игры». Такой текст непустой — и лобби, в которое
  // мы только что вошли, читалось как идущий матч (жалоба 09.08.2026).
  return Array.from(document.querySelectorAll<HTMLElement>(SITE.runningStageMarkers)).some(
    (el) => isRunningStageText(norm(el.textContent)),
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
    disbandmentSampleChangedAt = 0;
    // Запланированное решение не отменяем: лишний tick() увидит gameStarted
    // и выйдет. Игра всё-таки началась — мост обязан умереть, иначе он
    // утащил бы игрока в поиск прямо из матча (или после его конца).
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
  if (roomExitDone) return;

  // Трекинг отсчёта идёт и БЕЗ готовности (RQ-7): терминальный роспуск надо
  // уметь доказать для любого игрока — неготовому мы обязаны честно сказать,
  // почему возврата не будет, а не промолчать. Готовность гейтит только
  // ДЕЙСТВИЯ: мост и уход.
  if (timer && timerVisible) {
    if (!disbandmentSeen) {
      disbandmentSeen = true;
      if (roomReady) {
        log.info(SCOPE, "идёт обратный отсчёт роспуска — готовимся вернуться в поиск");
      }
    }
    // Мост ставим СРАЗУ, а не в момент ухода: дальше игрока может увести сам
    // сайт или он сам нажмёт «На главную» — тогда наш код в комнате уже не
    // выполнится. И на КАЖДОМ тике, а не однажды: видимый отсчёт — живое
    // условие, TTL скользит от последнего подтверждения (RQ-4), иначе
    // серверный отсчёт длиннее 45 с протушил бы метку ещё до роспуска.
    if (roomReady) armPending();
    // Непонятую строку НЕ записываем: -1 неотличим от «досчитал до нуля», а
    // это ветка «комнату распустили» — то есть игрока выдернуло бы из,
    // возможно, стартующего матча. Держим последнее прочитанное значение.
    // Ограничение: если сайт сменит формат ЦЕЛИКОМ, первое же чтение даст -1
    // и держать будет нечего — тогда поведение прежнее, как до этой правки.
    const seconds = parseCountdownSeconds(timer.textContent);
    if (seconds >= 0 && seconds !== disbandmentLastSeconds) {
      disbandmentLastSeconds = seconds;
      // Метка времени — по СМЕНЕ значения (см. комментарий у поля).
      disbandmentSampleChangedAt = Date.now();
    }
    disbandmentGoneAt = 0;
    return;
  }
  // Экран ошибки классифицируется РАНЬШЕ веток отсчёта: сайт убирает отсчёт
  // и рисует экран ОДНИМ рендером, то есть одним нашим тиком. Уйди мы сперва
  // в грейс-паузу — метка исключённого игрока жила бы ещё ~12 секунд, ровно
  // пока он читает кнопку «На главную» (контрольное ревью 04.08.2026).
  // «Попробовать снова» проверяется первым: обрыв СВЯЗИ, а не распуск —
  // комната может быть жива, мост не гасим (отсчёт может продолжиться).
  const retry = document.querySelector<HTMLElement>(SITE.roomRetryButton);
  if (retry && isVisible(retry)) {
    if (!roomExitDeferLogged.retryScreen) {
      roomExitDeferLogged.retryScreen = true;
      log.info(SCOPE, "обнаружен обрыв связи (кнопка «Попробовать снова») — в поиск не уводим");
    }
    return;
  }
  const screen = classifyRoomErrorScreen();
  if (screen?.kind === "ambiguous") {
    // Экран ошибки есть, но развала он НЕ доказывает: исключение игрока
    // рисует home+search, потеря сессии — один action без ссылок. Клик по
    // search здесь вернул бы в очередь игрока, которого сервер только что
    // исключил (аудит 03.08.2026, RQ-5). Неоднозначный экран сильнее
    // отсчёта: исключить могли и ВО ВРЕМЯ него — и тогда мост уже лежит в
    // sessionStorage. Не погасить его В ЭТОМ ЖЕ тике = вернуть исключённого
    // в очередь через «На главную» → elsewhereTick (ревью 04.08, блокер 1).
    clearPending();
    if (!ambiguousErrorLogged) {
      ambiguousErrorLogged = true;
      log.info(SCOPE, "автовозврат не выполнен: экран ошибки комнаты не подтверждает развал");
    }
    return;
  }

  // Отсчёт был и пропал: либо время вышло (роспуск), либо все успели и игра
  // стартовала. Узкая форма экрана смерти решает сама — дискриминатор по
  // сэмплу и грейс-пауза нужны только когда экрана нет.
  if (!screen && disbandmentSeen && !disbandmentGoneAt) {
    // Первый дискриминатор — последнее показанное значение: при роспуске
    // отсчёт доходит до ~00:00, при старте игры гаснет на произвольном.
    // Дискриминатору можно верить, только пока сэмпл СВЕЖИЙ: после hidden-
    // паузы сайт убирает отсчёт одним catch-up колбэком, и старое «00:28»
    // доказывает лишь то, что мы проспали конец (RQ-1).
    const sampleFresh =
      disbandmentSampleChangedAt > 0 &&
      Date.now() - disbandmentSampleChangedAt <= SAMPLE_FRESH_MS;
    if (sampleFresh && disbandmentLastSeconds > DISBAND_ZERO_TOLERANCE_S) {
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
    if (!sampleFresh && disbandmentLastSeconds > DISBAND_ZERO_TOLERANCE_S) {
      // Один info на эпизод: без него по файлу не отличить «поверили
      // протухшему сэмплу» от «пошли ждать подтверждение стадии».
      log.info(SCOPE, "отсчёт исчез после паузы вкладки — ждём подтверждение стадии");
    }
    disbandmentGoneAt = Date.now();
    // DOM распущенной комнаты замирает: мутаций больше не будет, а tick()
    // ходит только от них — без своего пробуждения пауза не истекла бы
    // НИКОГДА (ровно то «ничего не происходит», ради чего фича переписана).
    // Если за паузу появится игровая стадия, matchIsRunning() выключит нас
    // раньше — старт игры она доказывает надёжнее любого сэмпла.
    scheduleDecision(DISBAND_GRACE_MS + 250);
    return;
  }

  const graceExpired =
    disbandmentSeen && disbandmentGoneAt > 0 && Date.now() - disbandmentGoneAt > DISBAND_GRACE_MS;
  if (screen?.kind !== "disbandment" && !graceExpired) {
    // Ложное пробуждение до конца паузы (например, foreground grace):
    // перепланировать остаток обязана сама ждущая ветка — таймер один.
    if (disbandmentGoneAt > 0) {
      scheduleDecision(disbandmentGoneAt + DISBAND_GRACE_MS - Date.now() + 250);
    }
    return;
  }

  // Развал ДОКАЗАН: отсчётом до ~нуля с выдержанной паузой либо узкой формой
  // экрана смерти. Неготовому игроку — честный ответ вместо молчания (RQ-7):
  // предохранитель «возвращаем только подтвердившего» остаётся в силе.
  if (!roomReady) {
    if (!notReadyAnnounced) {
      notReadyAnnounced = true;
      // Эпизод закрыт: чужая метка (например, от принятия на поиске) не
      // должна утащить неготового игрока с главной сразу после этого тоста.
      clearPending();
      log.info(SCOPE, "возврат не выполнен: готовность не была подтверждена игроком");
      showToast("Возврат в поиск не выполнен: вы не подтвердили готовность", {
        key: "requeue-not-ready",
      });
    }
    return;
  }

  // Те же правила, что и на поиске: не в фоне и не поперёк живого человека.
  // Обе отсрочки — по фронту: DOM распущенной комнаты замер, повторной точки
  // решения может не быть, и молчание тут неотличимо от поломки (QR-2).
  if (document.hidden) {
    if (!roomExitDeferLogged.hidden) {
      roomExitDeferLogged.hidden = true;
      log.info(SCOPE, "выход из распущенной комнаты отложен: вкладка в фоне");
    }
    return;
  }
  if (Date.now() - lastTrustedInputAt < USER_BACKOFF_MS) {
    if (!roomExitDeferLogged.userInput) {
      roomExitDeferLogged.userInput = true;
      log.info(SCOPE, "выход из распущенной комнаты отложен: игрок только что действовал сам");
    }
    // DOM мёртвой комнаты больше не мутирует: без собственного пробуждения
    // эта отсрочка была бы НАВСЕГДА (аудит 03.08.2026, RQ-6).
    scheduleDecision(lastTrustedInputAt + USER_BACKOFF_MS - Date.now() + 100);
    return;
  }

  roomExitDone = true;
  armPending(true); // force: метка обязана лечь до навигации
  // Тост здесь не рисуем: страница сейчас сменится, плашка мелькнёт на
  // миллисекунды. О возврате скажет тост на странице поиска (armedFromRoom).
  log.info(SCOPE, "комната распущена после готовности — уходим на страницу поиска");
  if (screen?.kind === "disbandment") {
    // Сайт показал ссылку узкой формы развала — идём по ней (обычная
    // навигация сайта).
    screen.link.click();
  } else {
    // Обычный случай: комната просто «умерла» без экрана ошибки, и уйти с
    // неё может только тот, кто знает куда. Кнопка сайта «На главную» ведёт
    // на origin, откуда игроку пришлось бы жать «Поиск» руками — ради этого
    // фича и делалась.
    location.assign("/game-search");
  }
}

/**
 * Структурная классификация экрана ошибки комнаты (RQ-5).
 *
 * Развал (`on_stop_game`) сайт рисует ЕДИНСТВЕННОЙ главной кнопкой — ссылкой
 * на /game-search. Любая другая комбинация (home+search у исключения,
 * search+reload у ошибок медиа/авторизации, один action без href у потери
 * сессии) — «ambiguous»: решает игрок. Тексты не читаем — только структуру:
 * подписи локализуются, а строки сервера нам не принадлежат.
 */
function classifyRoomErrorScreen():
  | { kind: "disbandment"; link: HTMLElement }
  | { kind: "ambiguous" }
  | null {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>(SITE.roomErrorButtons),
  ).filter((el) => isVisible(el));
  if (buttons.length === 0) return null;
  if (buttons.length === 1 && buttons[0].getAttribute("href") === "/game-search") {
    return { kind: "disbandment", link: buttons[0] };
  }
  return { kind: "ambiguous" };
}

/**
 * Одноразовый мост «комната распускается → страница поиска».
 *
 * Повторный вызов ОСВЕЖАЕТ метку, не начиная эпизод заново: живое условие
 * (видимый отсчёт, принятый блок) обязано звать это на каждом своём тике —
 * TTL скользит от последнего подтверждения, а не от постановки (RQ-4).
 * Потолок эпизода держит issuedAt, который освежение не трогает.
 */
/** Последняя запись метки (0 — не писали). Дроссель освежения ниже. */
let lastArmWriteAt = 0;
/**
 * Освежать чаще незачем: TTL скользит 45 секундами, а синхронная пара
 * get+parse+stringify+set в sessionStorage шла на КАЖДОМ тике живого условия
 * — до 4 записей/с (перф-аудит 06.08.2026, PERF-6). Принудительная запись
 * (force) — для точек, где метка обязана лечь СЕЙЧАС: латч намерения и
 * перевзвод перед уходом.
 */
const ARM_REFRESH_MIN_MS = 5000;

function armPending(force = false): void {
  try {
    const now = Date.now();
    if (!force && now - lastArmWriteAt < ARM_REFRESH_MIN_MS) return;
    lastArmWriteAt = now;
    const verdict = validateMark(sessionStorage.getItem(PENDING_KEY), now);
    // issuedAt наследуем ТОЛЬКО у живой метки. Остаток мёртвого эпизода
    // (страница поиска живёт между сборами лобби без перезагрузки) отравил
    // бы потолок: новый честный мост рождался бы уже «старше 10 минут»
    // (ревью 04.08.2026, блокер 2).
    const prior = verdict?.ok ? verdict.mark : null;
    sessionStorage.setItem(PENDING_KEY, serializeMark(refreshMark(prior, now)));
  } catch {
    // Приватный режим/запрет хранилища: перейдём без автоклика на поиске.
    // Раньше отказ был нем, и «мост не сработал» не отличалось от «мост не
    // ставили» (аудит наблюдаемости 02.08.2026, QR-3). Латч обязателен:
    // освежение зовётся на каждом тике живого условия, без него это был бы
    // warn-флуд на весь отсчёт (ревью 04.08.2026).
    if (!armStorageWarned) {
      armStorageWarned = true;
      log.warn(SCOPE, "не удалось сохранить мост автовозврата — хранилище страницы недоступно");
    }
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
 * сам нажал «На главную»), но мост свежий — значит человек ПОДТВЕРДИЛ игру
 * («Готов» в распускавшейся комнате ИЛИ принятие на поиске: мост этапа 1
 * тоже жив до 45 с после ухода со страницы — известное поведение, ревью
 * 04.08.2026), и лобби развалилось. Доводим до страницы поиска; клик
 * «Играть» сделает этап 1.
 */
function elsewhereTick(): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) return;
  if (elsewhereDone) return;
  // ТОЛЬКО корень сайта — именно туда ведёт кнопка выхода из комнаты
  // (`finishGameLink: location.origin`). На профиле, странице матча и прочих
  // мост игнорируем: игрок ушёл туда сам и не ждёт, что его куда-то унесёт.
  if (location.pathname !== "/") return;
  if (document.hidden) return;
  if (Date.now() - lastTrustedInputAt < USER_BACKOFF_MS) {
    // Главная после мёртвой комнаты статична: без пробуждения бэкофф был бы
    // вечным (RQ-6).
    scheduleDecision(lastTrustedInputAt + USER_BACKOFF_MS - Date.now() + 100);
    return;
  }
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
  } catch {
    // Хранилище недоступно на всей странице — эпизод для нас закрыт. Один
    // warn, не на каждый тик (RQ-8: раньше корень молчал).
    if (!elsewhereStorageWarned) {
      elsewhereStorageWarned = true;
      log.warn(SCOPE, "мост автовозврата недоступен на главной: хранилище страницы недоступно");
    }
    return;
  }
  const verdict = validateMark(raw, Date.now());
  if (!verdict) return; // метки нет — обычное состояние, не эпизод и не лог
  if (!verdict.ok) {
    // Негодную метку снимаем и говорим почему: раньше она лежала молча до
    // конца сессии, и «мост не сработал» было неотличимо от «моста не было».
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* прочитать смогли — удаление здесь не критично */
    }
    log.info(SCOPE, "мост автовозврата снят на главной:", MARK_FAILURE_TEXT[verdict.reason]);
    return;
  }
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
    log.warn(SCOPE, "мост автовозврата пропущен: хранилище страницы недоступно");
    return;
  }
  const verdict = validateMark(raw, Date.now());
  if (!verdict) return;
  if (!verdict.ok) {
    // Почему мост не сработал — четыре разных случая, и раньше они были
    // неразличимы. Сырое время не пишем: sessionStorage принадлежит сайту
    // (AGENTS.md §5; про метку из будущего — аудит безопасности 01.08, №15).
    log.info(SCOPE, "мост автовозврата пропущен:", MARK_FAILURE_TEXT[verdict.reason]);
    return;
  }
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

// ── латч намерения (RQ-2) ──

/**
 * Что за цель у клика игрока — с точки зрения предохранителя автовозврата.
 *
 * Зачем: подтверждение по DOM живёт в 250-мс дроссель-окне общего
 * наблюдателя, а сайт СБРАСЫВАЕТ и отметку готовности, и класс active на
 * `voting_finished` — готовность, нажатая в последние миллисекунды окна,
 * могла появиться и исчезнуть между двумя нашими тиками. Клик — синхронный,
 * его не съест ни дроссель, ни перезагрузка (аудит 03.08.2026, RQ-2).
 *
 * «room-ready» — НЕактивная кнопка «Готов» (точное совпадение текста, §4.2:
 * «Не готов» содержит «готов», подстроки запрещены). Активную не считаем:
 * готовность уже нажата и залатчена по DOM.
 * «search-accept» — ещё не принятый блок принятия (с cursor-pointer).
 *
 * Чистая функция — вынесена для прямых тестов: jsdom не умеет isTrusted=true,
 * поэтому доверенность проверяет слушатель, а классификацию — тесты.
 */
export function classifyIntentTarget(target: Element): "room-ready" | "search-accept" | null {
  const btn = target.closest(SITE.readyButton);
  if (
    btn &&
    (TEXT.readyButton as readonly string[]).includes(norm(btn.textContent)) &&
    !btn.classList.contains(SITE.readyButtonActiveClass)
  ) {
    return "room-ready";
  }
  const accept = target.closest(SITE.profileAccept);
  if (accept && accept.classList.contains("cursor-pointer")) return "search-accept";
  return null;
}

/**
 * Зафиксировать намерение игрока по клику (уже проверенному на isTrusted —
 * или пришедшему из НАШЕГО успешного автоклика, см. noteAutoAcceptDispatched).
 *
 * Смысл предохранителя — «возвращаем только того, кто сам подтвердил игру».
 * Явный клик по «Готов»/«Принять» и ЕСТЬ это подтверждение, даже если сервер
 * не успел его засчитать: развал случился не по вине игрока. Решение
 * согласовано с владельцем (ревью аудита 03.08.2026).
 */
export function noteIntentClick(target: Element): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) return;
  const kind = classifyIntentTarget(target);
  if (kind === "room-ready" && isGameRoomPage()) {
    if (!roomReady && !gameStarted) {
      roomReady = true;
      log.info(SCOPE, "готовность подтверждена по клику игрока — этап 2 на страже");
    }
    return;
  }
  if (kind === "search-accept" && isSearchPage()) {
    // Синхронно, прямо в обработчике клика: reload от game_not_accepted
    // может прийти раньше ближайшего тика, а мост обязан пережить его.
    accepted = true;
    if (!acceptArmed) {
      acceptArmed = true;
      log.info(SCOPE, "принятие игры зафиксировано по клику — возврат после развала взведён");
    }
    armPending(true); // force: reload может прийти раньше любого тика
  }
}

/**
 * Хук для автопринятия (auto-start): наш собственный клик по блоку принятия
 * прошёл синхронный dispatch без исключения. Слушатель кликов его НЕ увидит
 * (isTrusted=false — и это правильно: страница может генерировать любые
 * синтетические клики), поэтому автопринятие говорит нам напрямую.
 */
export function noteAutoAcceptDispatched(): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) return;
  if (!isSearchPage()) return;
  accepted = true;
  if (!acceptArmed) {
    acceptArmed = true;
    log.info(SCOPE, "принятие игры зафиксировано автокликом — возврат после развала взведён");
  }
  armPending(true); // force: как и клик игрока — синхронная гарантия
}

function reset(): void {
  accepted = false;
  acceptArmed = false;
  backoffLogged = false;
  armedFromRoom = false;
  disappearedAt = 0;
  attempts = 0;
  lastClickAt = 0;
}


/** pathname последнего тика: "" — ещё не тикали (первый проход не сбрасывает). */
let lastPathname = "";

/**
 * Смена маршрута ВНУТРИ одного документа (RQ-9). Сегодня сайт делает полную
 * загрузку (POST в комнату, reload поиска) и модульное состояние умирает само;
 * но SPA-переход унаследовал бы `gameStarted`/`roomExitDone` от прошлой
 * комнаты и молча подавил бы следующий эпизод — не ждём, пока сайт переедет.
 */
function syncRoute(): void {
  if (location.pathname === lastPathname) return;
  const firstRun = lastPathname === "";
  lastPathname = location.pathname;
  if (firstRun) return;
  const episodeActive = disbandmentSeen || roomReady || accepted || attempts > 0;
  if (episodeActive) log.info(SCOPE, "эпизод автовозврата сброшен: смена страницы");
  resetRoomEpisode();
  reset();
  elsewhereDone = false;
  hiddenAt = 0;
  armStorageWarned = false;
  // Мост потребляется на ВХОДЕ на страницу поиска — SPA-переход не проходит
  // через enable(), а метка одноразовая и ждать её больше некому.
  if (isSearchPage()) consumePendingFromRoom();
}

/** Сброс состояния комнатного эпизода (уход со страницы / выключение). */
function resetRoomEpisode(): void {
  roomReady = false;
  gameStarted = false;
  roomExitDone = false;
  disbandmentSeen = false;
  disbandmentLogged = false;
  disbandmentGoneAt = 0;
  disbandmentLastSeconds = -1;
  disbandmentSampleChangedAt = 0;
  roomExitDeferLogged.hidden = false;
  roomExitDeferLogged.userInput = false;
  roomExitDeferLogged.retryScreen = false;
  gameStartingLogged = false;
  ambiguousErrorLogged = false;
  notReadyAnnounced = false;
}

function tick(): void {
  if (!settings || settings.requeue_after_lobby_fail_enabled === false) {
    reset();
    return;
  }
  syncRoute();
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
    if (accepted) {
      if (!acceptArmed) {
        acceptArmed = true;
        log.info(SCOPE, "принятие игры подтверждено — возврат после развала взведён");
      }
      // Освежение на каждом тике + плановое пробуждение: секундомер сайта
      // обновляется через characterData, наш наблюдатель таких мутаций не
      // видит, и без таймера принятый блок не дал бы ни одного тика — метка
      // протухла бы при живом условии (RQ-4).
      armPending();
      scheduleDecision(PENDING_REFRESH_MS);
    }
    return;
  }
  if (!accepted) return;

  // Блок принятия исчез — выясняем, куда всё повернулось.
  if (document.querySelector(SITE.searchInProgress)) {
    // Сайт сам вернул игрока в очередь — не дублируем.
    // Строка успеха: без неё в файле не было ДОКАЗАТЕЛЬСТВА, что всё
    // закончилось хорошо, и «работает» не отличалось от «молча сдались»
    // (аудит наблюдаемости 02.08.2026, QR-1).
    if (attempts > 0 || armedFromRoom) {
      log.info(SCOPE, "поиск возобновлён: секундомер очереди подтверждён");
    }
    clearPending();
    reset();
    return;
  }
  if (document.querySelector(GAME_STARTING_SELECTOR)) {
    // Все приняли, игра запускается — сейчас уведут со страницы. Мост обязан
    // умереть: иначе возврат на страницу поиска в пределах TTL (например,
    // игрок вышел из начавшейся игры) принял бы его за развал лобби.
    // Ветка СБРАСЫВАЕТ окно, поэтому терминального warn тут не будет никогда:
    // если лоадер подвиснет, машина молча сидела бы до ухода со страницы
    // (ревью 02.08.2026). Говорим по фронту.
    if (!gameStartingLogged) {
      gameStartingLogged = true;
      log.info(SCOPE, "лобби стартует — не вмешиваемся");
    }
    clearPending();
    disappearedAt = 0;
    return;
  }

  const now = Date.now();
  if (!disappearedAt) disappearedAt = now;
  if (now - disappearedAt > ARM_WINDOW_MS) {
    // Терминальный исход №1: окно кончилось, кнопку так и не увидели.
    // Эпизод закрыт — метка гасится: иначе ручная перезагрузка в пределах
    // TTL реанимировала бы уже сдавшуюся машину (ревью 04.08.2026).
    clearPending();
    log.warn(
      SCOPE,
      "автовозврат остановлен: за",
      `${Math.round(ARM_WINDOW_MS / 1000)} с`,
      "кнопка «Играть» не появилась",
    );
    reset();
    return;
  }

  // Сайт открыл модалку (например «Вы уже в поиске» при рассинхроне с
  // сервером) — дальше решает игрок, автоклики прекращаем.
  if (siteModalOpen()) {
    clearPending();
    log.warn(SCOPE, "открыта модалка сайта — прекращаем автоповтор");
    reset();
    return;
  }

  const play = document.querySelector<HTMLButtonElement>(SITE.profileSearchButton);
  if (!play || !isVisible(play)) {
    // Скелетон загрузки — ждём в пределах окна. Появление кнопки — это
    // мутация, она разбудит сама; таймер нужен ТЕРМИНАЛЬНОМУ исходу: без
    // него на замёрзшей странице warn «кнопка не появилась» был недостижим
    // (аудит 03.08.2026, RQ-3).
    scheduleDecision(disappearedAt + ARM_WINDOW_MS - now + 250);
    return;
  }
  if (play.disabled || play.hasAttribute("disabled")) {
    // Не выбраны очереди — решение за игроком, не за нами. Раньше выходили
    // молча, и в файле это не отличалось от «машина перестала тикать» (QR-1).
    clearPending();
    log.info(SCOPE, "автовозврат остановлен: кнопка «Играть» недоступна — не выбраны очереди");
    reset();
    return;
  }
  if (attempts >= MAX_CLICK_ATTEMPTS) {
    clearPending();
    log.warn(SCOPE, "«Играть» не сработала за", MAX_CLICK_ATTEMPTS, "попытки — сдаёмся");
    reset();
    return;
  }
  if (now - lastClickAt < MIN_CLICK_INTERVAL_MS) {
    // Пауза между попытками. Сайт мог НЕ отреагировать на клик ни одной
    // мутацией — повтор обязан разбудить себя сам (RQ-3).
    scheduleDecision(lastClickAt + MIN_CLICK_INTERVAL_MS - now + 50);
    return;
  }
  // Игрок только что кликал/печатал сам — он у панели, дорога его (ревью №3).
  if (now - lastTrustedInputAt < USER_BACKOFF_MS) {
    // По фронту, не на каждый тик: строка нужна, чтобы отличить «мы уступили
    // человеку» от «машина умерла», но тиков тут четыре в секунду (QR-1).
    if (!backoffLogged) {
      backoffLogged = true;
      log.info(SCOPE, "автовозврат отложен: игрок только что действовал сам");
    }
    scheduleDecision(lastTrustedInputAt + USER_BACKOFF_MS - now + 100);
    return;
  }
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
      // Ключ с номером попытки: дедуп в 30 с иначе съедал бы плашку у
      // ВТОРОГО развала лобби подряд, а он вполне возможен (ревью 02.08.2026).
      { key: `requeue-acting-${Date.now()}` },
    );
  }
  safeClick(play);
  // accepted намеренно не сбрасываем: успех виден по секундомеру поиска
  // (ветка searchInProgress выше сделает reset), а неуспех повторит клик.
  // Проверка результата — своя: сайт мог проглотить клик без единой мутации,
  // и тогда ни повтор, ни терминальный warn не наступили бы (RQ-3).
  scheduleDecision(MIN_CLICK_INTERVAL_MS + 100);
}

export const queueRequeueFeature: Feature = {
  id: "queue-requeue",
  settingKey: "requeue_after_lobby_fail_enabled",

  enable(ctx: FeatureContext) {
    settings = ctx.settings;
    // isTrusted отсекает наши же синтетические клики (как в auto-start).
    trustedListener = (e: Event) => {
      if (e.isTrusted) noteTrustedInput();
    };
    document.addEventListener("pointerdown", trustedListener, true);
    document.addEventListener("keydown", trustedListener, true);
    // Латч намерения (RQ-2): только НАСТОЯЩИЙ клик игрока. Синтетические
    // клики страницы и наши собственные не проходят — их isTrusted=false;
    // автопринятие сообщает о себе явным хуком noteAutoAcceptDispatched.
    intentListener = (e: Event) => {
      if (!e.isTrusted) return;
      if (e.target instanceof Element) noteIntentClick(e.target);
    };
    document.addEventListener("click", intentListener, true);
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
      // НЕ решать синхронно: игрок возвращает фокус окну кликом В СТРАНИЦУ,
      // и порядок pointerdown/visibilitychange не определён. Синхронный tick
      // либо навигирует поперёк живого клика, либо попадает в бэкофф без
      // следующего пробуждения (RQ-6). Пауза даёт клику осесть в бэкофф,
      // а бэкофф-ветки планируют своё продолжение сами.
      scheduleDecision(FOREGROUND_GRACE_MS);
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
    if (intentListener) {
      document.removeEventListener("click", intentListener, true);
      intentListener = null;
    }
    if (visibilityListener) {
      document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
    }
    hiddenAt = 0;
    resetRoomEpisode();
    elsewhereDone = false;
    elsewhereStorageWarned = false;
    armStorageWarned = false;
    // Без этого сброса бэкофф пережил бы выключение фичи, а в тестах —
    // соседний тест (ревью 04.08.2026: вакуумность «ста тиков без строк»).
    lastTrustedInputAt = 0;
    lastPathname = "";
    lastArmWriteAt = 0;
    cancelDecision();
    reset();
    settings = null;
  },
};
