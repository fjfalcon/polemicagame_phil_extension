/**
 * Фича: кнопка «В поиск» после конца игры и для умершего игрока.
 *
 * Боль (владелец, 07.08.2026): после конца игры (или смерти — убитого сайт
 * сам переводит в зрители) путь обратно в очередь — это «куча окон»: модалка
 * статистики → «Поиск игры» в её футере → страница поиска → там сервер ещё
 * держит игрока в игре → «Покинуть игру» → модалка подтверждения →
 * «Покинуть лобби» → и только потом «Играть».
 *
 * Флоу сверен с живыми бандлами (07.08.2026):
 *  - конец игры: роллер рисует `.ended.ended-mafia|ended-civilian`
 *    (RollerFixedState), затем `game_statistics_saved` сам открывает модалку
 *    статистики; в её футере есть «Поиск игры» → goToUrl("/game-search") —
 *    но «Играть» она за игрока не жмёт;
 *  - смерть: `on_self_strike` (killed/voted при начавшейся игре) →
 *    location="/game?role=viewer&game_id=…" — игрок смотрит игру зрителем,
 *    но `userInGame` на сервере остаётся;
 *  - страница поиска при `userInGame`: вместо «Играть» рисуется блок
 *    `.p-play__profile-game--decide` («Продолжить игру» / «Покинуть игру»);
 *    «Покинуть игру» = quitGame(false) — только открывает модалку
 *    подтверждения `.confirmQuit`; её кнопка «Покинуть лобби» =
 *    quitGame(true) → POST /api/games/quit → userInGame сброшен → рисуются
 *    очереди и «Играть».
 *
 * Наша механика — в два шага, соединённых одноразовым мостом sessionStorage
 * (формат и TTL — общий модуль requeue-pending):
 *  1. В комнате: плавающая кнопка «В поиск» — ТОЛЬКО когда матч завершён
 *     (победа одной из сторон) или вкладка в режиме зрителя. Живому игроку
 *     посреди матча кнопка не показывается никогда: увести его — значит
 *     сорвать игру остальным. Кнопка плавающая и поверх модалок: модалка
 *     статистики открывается сама, и кнопка в `.ended` была бы под ней.
 *  2. На поиске: свежий мост взводит машину «выйти и встать в поиск»:
 *     [решающий блок? → «Покинуть игру» → «Покинуть лобби»] → «Играть».
 *     Без моста машина не делает НИЧЕГО — автоклики только как продолжение
 *     явного клика игрока по нашей кнопке секунды назад.
 *
 * Почему автоклик по модалке подтверждения здесь допустим (осознанное
 * исключение из правила «модалка сайта — решает игрок»): эта модалка —
 * ровно одно из «окон», которые игрок попросил пропустить, нажав нашу
 * кнопку с явной подписью. Исключение узкое: ТОЛЬКО `.confirmQuit`, только
 * при живом мосте; любая другая модалка (капча подтверждения почты, «Ошибка!»
 * после неудачного quit) останавливает машину насовсем.
 *
 * ПРИНЦИП ЖИВУЧЕСТИ — как в queue-requeue (RQ-3): тики идут от мутаций DOM,
 * а страница может замереть (лоадер quit-а завис, блок не перерисовался).
 * Каждая ждущая ветка обязана планировать собственное пробуждение общим
 * decision-таймером; дедлайн эпизода — терминальный warn, а не молчание.
 */
import { onDomChange, safeClick, isVisible } from "@core/dom";
import { SITE, TEXT, matchFinishedVisible } from "@core/selectors";
import { isGameRoomPath, isSearchPath } from "@shared/routes";
import { log } from "@core/log";
import { onMessage, sendRuntime } from "@core/messaging";
import { showToast } from "@core/toast";
import { refreshMark, validateMark } from "./requeue-pending";
import type { MarkFailure } from "./requeue-pending";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const SCOPE = "postgame-search";

/** Мост «клик по кнопке в комнате → машина на странице поиска». Ключ СВОЙ:
 *  мост queue-requeue (pn_requeue_pending) несёт другую семантику — «лобби
 *  развалилось», и его потребитель не умеет в выход из игры. */
export const POSTGAME_PENDING_KEY = "pn_postgame_pending";

/** Наша кнопка в комнате. */
export const BUTTON_ID = "pn-postgame-search";

/**
 * Дедлайн эпизода на странице поиска. Внутри должны уместиться: рендер
 * решающего блока, два наших клика, POST /api/games/quit и перерисовка
 * очередей. 30 с — с запасом; дольше значит что-то пошло не так, и честный
 * warn с тостом лучше вечного ожидания.
 */
const EPISODE_WINDOW_MS = 30_000;
/**
 * Добавка к дедлайну, пока машина ЖДЁТ подтверждения модалки человеком
 * (настройка postgame_skip_confirm_enabled=false): думать над «Покинуть
 * лобби» можно дольше, чем машине — кликать. Конечная: вечное ожидание —
 * это молчаливая смерть, которой быть не должно.
 */
const CONFIRM_WAIT_EXTRA_MS = 120_000;
/**
 * Выдержки перед кликом «Играть» (разбор лога 07.08.2026, 18:29): сайт
 * узнаёт «игрок ещё в игре» ЛЕНИВО — от сервера в ответ на попытку поиска
 * или от списка лобби. В первую секунду после загрузки он рисует «Играть»
 * даже умершему, и наш мгновенный клик уходил `toggleSearch`-ом при
 * userInGame: сервер отвечал in_game, а `searchBtnLoading` сайт в этой
 * ветке НЕ сбрасывает — после выхода из игры вместо кнопки оставалась
 * вечная крутилка (лечится только F5). Поэтому:
 *  - мост из viewer-вкладки (умерший — почти наверняка ещё в игре): ждём
 *    решающий блок до DECIDE_WAIT_MS и только потом трогаем «Играть»;
 *  - мост с экрана победы (сервер уже отпустил): короткая выдержка.
 * Выдержка не нужна вовсе, когда решающий блок уже видели или наш quit-шаг
 * уже ходил: статус игрока серверу известен.
 */
const PLAY_SETTLE_FINISHED_MS = 2500;
const PLAY_SETTLE_VIEWER_MS = 8000;
/**
 * Самолечение зависшей крутилки (второй пояс того же разбора): лоадер на
 * месте кнопки «Играть» без секундомера дольше этого срока — страница
 * зажата (`searchBtnLoading` уже не сбросится никогда). Одна перезагрузка
 * с перевзводом моста; повторное зажатие — честная сдача.
 */
const JAM_RELOAD_AFTER_MS = 8000;
/** Пауза между автокликами: сайт должен успеть отреагировать. */
const MIN_CLICK_INTERVAL_MS = 1200;
/** Бюджет попыток НА КАЖДЫЙ шаг (quit / confirm / play). */
const MAX_STAGE_ATTEMPTS = 3;
/** Игрок только что действовал сам — дорога его (инвариант §4 п.2). */
const USER_BACKOFF_MS = 2000;
/** Ниже не планируем: нулевые задержки складываются в горячий цикл. */
const MIN_DECISION_DELAY_MS = 50;
/** Пауза перед решением после возврата вкладки (порядок событий не определён). */
const FOREGROUND_GRACE_MS = 300;

/**
 * Родовые обёртки модалок страницы поиска (vue-js-modal + собственный
 * BaseModal сайта). Нужны для стоп-гейта «чужая модалка»: например, у
 * игрока с неподтверждённой почтой «Играть» шлёт капчу подтверждения —
 * появившуюся капчу машина обязана распознать как «дальше решает игрок».
 */
const SITE_MODAL_SELECTOR = ".modal, .v--modal-overlay, .vm--overlay, .basemodal";

/** Человекочитаемые причины отказа метки — в лог поддержки. */
const MARK_FAILURE_TEXT: Record<MarkFailure, string> = {
  corrupt: "метка повреждена",
  future: "метка из будущего",
  expired: "метка устарела",
  capped: "эпизод старше потолка",
};

let settings: Settings | null = null;
let unsubscribe: (() => void) | null = null;
let visibilityListener: (() => void) | null = null;
let trustedListener: ((e: Event) => void) | null = null;
let messageUnsub: (() => void) | null = null;

// ── общий decision-таймер (паттерн queue-requeue, RQ-3) ──

let decisionTimer: ReturnType<typeof setTimeout> | null = null;
/** Когда сработает запланированное решение (0 — не запланировано). */
let decisionAt = 0;

/** Запланировать tick(); таймер один, побеждает самое раннее время. */
function scheduleDecision(delayMs: number): void {
  const delay = Math.max(delayMs, MIN_DECISION_DELAY_MS);
  const at = Date.now() + delay;
  if (decisionTimer && decisionAt <= at) return;
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionAt = at;
  decisionTimer = setTimeout(() => {
    decisionTimer = null;
    decisionAt = 0;
    tick();
  }, delay);
}

function cancelDecision(): void {
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionTimer = null;
  decisionAt = 0;
}

// ── состояние машины страницы поиска ──

/** Мост потреблён — машина взведена. */
let armed = false;
/** Момент взвода (начало эпизода, точка отсчёта дедлайна). */
let armedAt = 0;
/** Попытки по шагам. */
let quitAttempts = 0;
let confirmAttempts = 0;
let playAttempts = 0;
let lastClickAt = 0;
/** Последнее НАСТОЯЩЕЕ действие игрока (isTrusted проверяет слушатель). */
let lastTrustedInputAt = 0;
/** Латчи «сказали один раз» — машина тикает четыре раза в секунду. */
let backoffLogged = false;
let hiddenLogged = false;
let waitConfirmLogged = false;
let settleLogged = false;
/** Модалку подтверждения в этом эпизоде уже видели (чья бы она ни была). */
let confirmSeen = false;
/** Машина стоит перед модалкой и ждёт человека (расширенный дедлайн). */
let waitingForConfirm = false;
/** Откуда пришёл мост (см. PLAY_SETTLE_*): по умолчанию — осторожный viewer. */
let markSource: "finished" | "viewer" = "viewer";
/** Мост уже переживал самолечебную перезагрузку — второй не будет. */
let markReloaded = false;
/** issuedAt потреблённого моста: перевзвод обязан сохранить потолок эпизода. */
let markIssuedAt = 0;
/** Решающий блок видели в этом эпизоде — статус игрока серверу известен. */
let decideSeen = false;
/** С какого момента на месте «Играть» висит лоадер (0 — не висит). */
let loaderSince = 0;
/** pathname последнего тика: "" — ещё не тикали. */
let lastPathname = "";

// ── сторож живого матча (ревью 07.08.2026, блокер A) ──

/**
 * Результат опроса «держит ли другая вкладка живой матч». Опрос обязателен
 * перед автокликом «Покинуть игру»: viewer-вкладка (?role=viewer) бывает и у
 * ЖИВОГО игрока — сайт сам открывает стримеру stream window с этим query, и
 * мост, взведённый в ней, без сторожа выписал бы игрока из идущего матча.
 * Fail-open: отказ канала (осиротевшая вкладка, спящий SW) не блокирует
 * явное действие игрока — сторож дополнительный, не единственный.
 */
let liveProbe:
  | { status: "idle" }
  | { status: "pending"; startedAt: number }
  | { status: "done"; live: boolean; at: number } = { status: "idle" };
/** Свежесть вердикта опроса: retry-клики в пределах окна его переиспользуют. */
const PROBE_FRESH_MS = 5000;
/** Ответ дольше этого — считаем канал отказавшим (fail-open). */
const PROBE_TIMEOUT_MS = 3000;

function startLiveProbe(): void {
  liveProbe = { status: "pending", startedAt: Date.now() };
  void sendRuntime<{ live?: boolean }>({ type: "postgame_live_query" }).then((res) => {
    // undefined = канал отказал (нет фона/осиротели) — честное «не знаю»,
    // трактуемое как «не живой» (fail-open, см. комментарий выше).
    liveProbe = { status: "done", live: res?.live === true, at: Date.now() };
    scheduleDecision(MIN_DECISION_DELAY_MS);
  });
}

/**
 * Гейт сторожа перед опасным шагом. «wait» — вердикта ещё нет, ждущая ветка
 * запланирована; «live» — живой матч подтверждён, шаг запрещён; «pass» —
 * дорога свободна (включая fail-open по отказу/таймауту канала).
 */
function liveMatchGate(now: number): "pass" | "wait" | "live" {
  const fresh = liveProbe.status === "done" && now - liveProbe.at <= PROBE_FRESH_MS;
  if (!fresh) {
    if (liveProbe.status === "pending" && now - liveProbe.startedAt <= PROBE_TIMEOUT_MS) {
      // Ответ в пути; его колбэк разбудит машину сам. Таймер — страховка
      // на случай молча умершего канала (тогда сработает таймаут ниже).
      scheduleDecision(300);
      return "wait";
    }
    if (liveProbe.status === "pending") {
      // Таймаут канала: честное «не знаю» = fail-open, идём дальше.
      liveProbe = { status: "done", live: false, at: now };
    } else {
      startLiveProbe();
      scheduleDecision(PROBE_TIMEOUT_MS + 100);
      return "wait";
    }
  }
  return liveProbe.status === "done" && liveProbe.live ? "live" : "pass";
}

/**
 * Отметить настоящее действие игрока. Экспорт — тестовый шов: jsdom не умеет
 * создавать доверенные события, а бэкофф обязан быть покрыт мутационно.
 */
export function noteTrustedInput(): void {
  lastTrustedInputAt = Date.now();
}

function norm(text: string | null | undefined): string {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function resetEpisode(): void {
  armed = false;
  armedAt = 0;
  quitAttempts = 0;
  confirmAttempts = 0;
  playAttempts = 0;
  lastClickAt = 0;
  backoffLogged = false;
  hiddenLogged = false;
  waitConfirmLogged = false;
  settleLogged = false;
  confirmSeen = false;
  waitingForConfirm = false;
  markSource = "viewer";
  markReloaded = false;
  markIssuedAt = 0;
  decideSeen = false;
  loaderSince = 0;
  liveProbe = { status: "idle" };
}

/**
 * Записать мост. Формат совместим с requeue-pending (validateMark читает
 * issuedAt/refreshedAt и игнорирует лишние поля); source/reloaded — наша
 * добавка. Недоверие симметрично: при чтении оба поля валидируются.
 */
function writePostgameMark(source: "finished" | "viewer", reloaded: boolean, issuedAt: number): void {
  const now = Date.now();
  const base = refreshMark({ issuedAt, refreshedAt: issuedAt }, now);
  sessionStorage.setItem(
    POSTGAME_PENDING_KEY,
    JSON.stringify({ ...base, source, reloaded }),
  );
}

// ── комната: кнопка ──

/**
 * Вкладка в режиме зрителя. Ровно так сайт помечает и умершего игрока
 * (`on_self_strike` → location="/game?role=viewer&game_id=…"), и обычного
 * зрителя. Различать их не нужно: страница поиска сама скажет, держит ли
 * сервер игрока в игре (решающий блок), а зрителю машина просто нажмёт
 * «Играть» — ровно то, что обещает подпись кнопки.
 */
function isViewerMode(): boolean {
  try {
    return new URLSearchParams(location.search).get("role") === "viewer";
  } catch {
    return false;
  }
}

/** Про недоступное хранилище при клике уже предупредили (один раз). */
let clickStorageWarned = false;

function onButtonClick(): void {
  // Мост — ДО навигации: страница сейчас умрёт. Отказ хранилища не блокирует
  // сам переход: игрок окажется на поиске и продолжит руками.
  try {
    // Источник решает выдержку перед «Играть» на поиске: с экрана победы
    // сервер игрока уже отпустил, из viewer-вкладки — почти наверняка нет.
    writePostgameMark(matchFinishedVisible() ? "finished" : "viewer", false, Date.now());
  } catch {
    if (!clickStorageWarned) {
      clickStorageWarned = true;
      log.warn(SCOPE, "мост «В поиск» не сохранён: хранилище страницы недоступно");
    }
  }
  log.info(SCOPE, "кнопка «В поиск» нажата — уходим на страницу поиска");
  location.assign("/game-search");
}

/** Нарисовать/убрать кнопку (идемпотентно — инвариант §4 п.1). */
function syncButton(show: boolean): void {
  const existing = document.getElementById(BUTTON_ID);
  if (!show) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.type = "button";
  btn.textContent = "В поиск 🔁";
  btn.title = "Выйти из этой игры и снова встать в поиск";
  // Поверх модалки статистики (сайт открывает её сам): fixed + свой z-index.
  // Низ по центру: верх занят шапкой и уведомлениями сайта, а футер модалки
  // статистики заканчивается выше нижнего края экрана.
  btn.style.cssText = `
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    z-index: 2147483600; background: #2c5cff; color: #fff; border: 0;
    border-radius: 10px; padding: 10px 18px; cursor: pointer;
    font: 14px/1.2 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45);
  `;
  btn.addEventListener("click", onButtonClick);
  (document.body || document.documentElement).appendChild(btn);
  log.info(SCOPE, "кнопка «В поиск» показана:", matchFinishedVisible() ? "матч завершён" : "режим зрителя");
}

// ── страница поиска: машина ──

/** Потребить мост (одноразово). Зовётся на входе на страницу поиска. */
function consumePending(): void {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(POSTGAME_PENDING_KEY);
    if (raw !== null) sessionStorage.removeItem(POSTGAME_PENDING_KEY);
  } catch {
    log.warn(SCOPE, "мост «В поиск» пропущен: хранилище страницы недоступно");
    return;
  }
  const verdict = validateMark(raw, Date.now());
  if (!verdict) return; // метки нет — обычное состояние, не эпизод и не лог
  if (!verdict.ok) {
    log.info(SCOPE, "мост «В поиск» пропущен:", MARK_FAILURE_TEXT[verdict.reason]);
    return;
  }
  armed = true;
  armedAt = Date.now();
  markIssuedAt = verdict.mark.issuedAt;
  // Добавочные поля читаем из сырого JSON без доверия: неизвестное значение
  // source трактуем как осторожный viewer (длинная выдержка безвреднее
  // преждевременного клика), reloaded — только буквальный true.
  try {
    const extra = JSON.parse(raw as string) as Record<string, unknown>;
    markSource = extra.source === "finished" ? "finished" : "viewer";
    markReloaded = extra.reloaded === true;
  } catch {
    markSource = "viewer";
    markReloaded = false;
  }
  log.info(
    SCOPE,
    "мост «В поиск» из комнаты — выходим из игры и встаём в поиск",
    `(источник: ${markSource}${markReloaded ? ", после перезагрузки" : ""})`,
  );
}

/** Видимый элемент по селектору (null — нет или скрыт). */
function visibleEl(selector: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (isVisible(el)) return el;
  }
  return null;
}

/**
 * Открыта ли ЧУЖАЯ модалка. Наша ожидаемая — только `.confirmQuit`; когда
 * она видна, родовые обёртки/оверлеи вокруг неё чужими не считаются.
 */
function foreignModalOpen(): boolean {
  if (visibleEl(SITE.confirmQuitModal)) return false;
  return Array.from(document.querySelectorAll<HTMLElement>(SITE_MODAL_SELECTOR)).some(
    (el) => el.offsetWidth > 0 && el.offsetHeight > 0,
  );
}

/** Терминальное закрытие эпизода: честный след в логе и на экране. */
function giveUp(reason: string): void {
  log.warn(SCOPE, "автовозврат в поиск остановлен:", reason);
  // Ключ с меткой времени: дедуп тостов в 30 с иначе съел бы плашку у
  // второго эпизода подряд (тот же урок, что у queue-requeue, ревью 02.08).
  showToast("Не получилось автоматически встать в поиск — продолжите вручную", {
    key: `postgame-giveup-${Date.now()}`,
  });
  // Терминальность держится на armed=false: взвести машину заново может
  // ТОЛЬКО новый мост (новый явный клик игрока). Сторожится тестом (H).
  resetEpisode();
}

/**
 * Клик шага с общими предохранителями: точное совпадение нормализованного
 * текста (подстроки запрещены, §4 п.2), видимость, бюджет, пауза между
 * попытками. Возвращает true, если ход сделан (или запланировано ожидание).
 */
function clickStage(
  el: HTMLElement,
  expected: readonly string[] | null,
  attempts: number,
  bumpAttempts: () => void,
  stageName: string,
): void {
  // null — шаг «Играть»: у кнопки поиска обе вариации шаблона подписаны
  // «Играть» (обычная и капча непочты), текст не дискриминирует — контракт
  // там селектор + disabled, как в queue-requeue.
  if (expected && !expected.includes(norm(el.textContent))) {
    // Текст не тот — сайт изменил подпись; жать «что-то похожее» запрещено.
    giveUp(`подпись кнопки шага «${stageName}» не совпала`);
    return;
  }
  if (attempts >= MAX_STAGE_ATTEMPTS) {
    giveUp(`шаг «${stageName}» не сработал за ${MAX_STAGE_ATTEMPTS} попытки`);
    return;
  }
  const now = Date.now();
  if (now - lastClickAt < MIN_CLICK_INTERVAL_MS) {
    // Пауза между попытками; сайт мог не дать ни одной мутации — будим себя.
    scheduleDecision(lastClickAt + MIN_CLICK_INTERVAL_MS - now + 50);
    return;
  }
  bumpAttempts();
  lastClickAt = now;
  log.info(SCOPE, `шаг «${stageName}», попытка`, attempts + 1);
  safeClick(el);
  // Проверка результата — своя: сайт мог проглотить клик без мутаций.
  scheduleDecision(MIN_CLICK_INTERVAL_MS + 100);
}

function searchTick(): void {
  if (!armed) return;

  // Успех: секундомер очереди — единственное надёжное «игрок в поиске».
  if (document.querySelector(SITE.searchInProgress)) {
    log.info(SCOPE, "поиск запущен: секундомер очереди подтверждён");
    resetEpisode();
    return;
  }

  const now = Date.now();
  const deadlineMs = EPISODE_WINDOW_MS + (waitingForConfirm ? CONFIRM_WAIT_EXTRA_MS : 0);
  if (now - armedAt > deadlineMs) {
    giveUp(`эпизод не завершился за ${Math.round(deadlineMs / 1000)} с`);
    return;
  }

  // Чужая модалка (капча почты, «Ошибка!» после неудачного quit) — дальше
  // решает игрок. Проверка ДО гейтов фона/бэкоффа: сдаться надо и в фоне.
  if (foreignModalOpen()) {
    giveUp("открыта модалка сайта");
    return;
  }

  // Фоновая вкладка: не кликаем, но дедлайн обязан истечь и в фоне —
  // без собственного пробуждения terminal warn был бы недостижим.
  if (document.hidden) {
    if (!hiddenLogged) {
      hiddenLogged = true;
      log.info(SCOPE, "возврат в поиск приостановлен: вкладка в фоне");
    }
    // По ДЕЙСТВУЮЩЕМУ дедлайну, не по базовому: в режиме ожидания модалки
    // (skip_confirm=false) базовый истекал через 30 с, задержка уходила в
    // минус, кламцалась в 50 мс — и скрытая вкладка крутила 20 тиков в
    // секунду до конца ожидания (ревью 07.08.2026, раунд 3).
    scheduleDecision(armedAt + deadlineMs - now + 250);
    return;
  }
  if (now - lastTrustedInputAt < USER_BACKOFF_MS) {
    if (!backoffLogged) {
      backoffLogged = true;
      log.info(SCOPE, "возврат в поиск отложен: игрок только что действовал сам");
    }
    scheduleDecision(lastTrustedInputAt + USER_BACKOFF_MS - now + 100);
    return;
  }

  // Шаг 2: модалка подтверждения выхода — жмём «Покинуть лобби».
  const confirmBtn = visibleEl(SITE.confirmQuitButton);
  if (confirmBtn) {
    confirmSeen = true;
    // Лоадер, виденный до модалки, к play-стадии отношения не имеет: счёт
    // «висит подряд» обязан идти заново, иначе транзиентные лоадеры разных
    // фаз складываются и вызывают преждевременный reload (ревью, раунд 3).
    loaderSince = 0;
    // Модалку мог открыть САМ игрок (наш quit-шаг не ходил, quitAttempts=0)
    // — тогда сторож живого матча ещё не бегал, а это последний путь квита
    // мимо пробы (контрольное ревью 07.08.2026). Гейт и здесь; заодно окно
    // «передумать» у игрока становится шире голого бэкоффа.
    if (quitAttempts === 0) {
      const gate = liveMatchGate(now);
      if (gate === "wait") return;
      if (gate === "live") {
        giveUp("в другой вкладке идёт ваш матч — из игры не выходим");
        return;
      }
    }
    // Настройка (просьба владельца 07.08.2026): модалку можно НЕ пропускать —
    // машина ждёт подтверждения человеком и продолжает после него. Ожидание
    // не терминально: клик игрока даст мутацию и следующий тик; дедлайн
    // эпизода сторожит зависание и здесь.
    if (settings?.postgame_skip_confirm_enabled === false) {
      waitingForConfirm = true;
      if (!waitConfirmLogged) {
        waitConfirmLogged = true;
        log.info(SCOPE, "модалка «Покинуть лобби» оставлена игроку (настройка) — ждём подтверждения");
        showToast("Подтвердите выход из игры — дальше продолжу сам 🔁", {
          key: `postgame-confirm-${Date.now()}`,
        });
      }
      scheduleDecision(armedAt + EPISODE_WINDOW_MS + CONFIRM_WAIT_EXTRA_MS - now + 250);
      return;
    }
    clickStage(confirmBtn, TEXT.confirmQuitButton, confirmAttempts, () => confirmAttempts++, "Покинуть лобби");
    return;
  }

  // Модалка исчезла. Два исхода, и различает их решающий блок: успешный
  // quit убирает и его тоже (сервер отпустил игрока), а закрытая крестиком
  // модалка оставляет — значит человек ПЕРЕДУМАЛ выходить. Переоткрывать
  // отвергнутое окно нельзя: в режиме ручного подтверждения это прямо
  // противоречит смыслу настройки, а в автоматическом — правилу «не воевать
  // с игроком» (ревью 07.08.2026, раунд 3).
  if ((waitingForConfirm || confirmSeen) && visibleEl(SITE.searchDecideBlock)) {
    // Чей это был крестик — видно по бюджету: наш клик по «Покинуть лобби»
    // либо не ходил вовсе (закрыл человек), либо ходил и не довёл выход до
    // конца. Две разные истории — две разные строки в файле поддержки.
    giveUp(
      confirmAttempts === 0
        ? "выход из игры отменён игроком — не настаиваем"
        : "подтверждение выхода не сработало — из игры не вышли",
    );
    return;
  }
  // Игрок подтвердил модалку сам (ожидание кончилось, модалки больше нет):
  // окно на оставшиеся шаги — свежее, время раздумий в него не входит.
  if (waitingForConfirm) {
    waitingForConfirm = false;
    armedAt = now;
  }

  // Шаг 1: сервер держит игрока в игре — жмём «Покинуть игру». Но СНАЧАЛА
  // сторож: не идёт ли живой матч игрока в другой вкладке (блокер A ревью
  // 07.08.2026 — stream window стримера тоже ?role=viewer). Опрос только
  // здесь: quit — единственный опасный шаг, «Играть» сторожа не требует.
  if (visibleEl(SITE.searchDecideBlock)) {
    decideSeen = true;
    // Как и в confirm-ветке: лоадер прошлой фазы к play-стадии не относится.
    loaderSince = 0;
    const gate = liveMatchGate(now);
    if (gate === "wait") return;
    if (gate === "live") {
      // Живой матч подтверждён самой вкладкой — выход отменён насовсем:
      // «Продолжить игру / Покинуть игру» пусть решает человек.
      giveUp("в другой вкладке идёт ваш матч — из игры не выходим");
      return;
    }
    const quitBtn = visibleEl(SITE.searchQuitButton);
    if (quitBtn) {
      clickStage(quitBtn, TEXT.quitGameButton, quitAttempts, () => quitAttempts++, "Покинуть игру");
    } else {
      // Блок есть, кнопки нет (перерисовка) — ждём в пределах дедлайна.
      scheduleDecision(500);
    }
    return;
  }

  // Шаг 3: «Играть».
  const play = document.querySelector<HTMLButtonElement>(SITE.profileSearchButton);
  if (!play || !isVisible(play)) {
    // Кнопки нет. Если на её месте ЛОАДЕР — считаем время: транзиентный
    // (quit POST, коннект сокета) живёт секунды, а зажатый (in_game без
    // сброса searchBtnLoading) — вечно. Одна самолечебная перезагрузка с
    // перевзводом моста; мост, переживший её, второй не получит.
    const loader = visibleEl(SITE.searchButtonLoader);
    if (loader && !document.querySelector(SITE.searchInProgress)) {
      if (!loaderSince) loaderSince = now;
      if (now - loaderSince > JAM_RELOAD_AFTER_MS) {
        if (markReloaded) {
          giveUp("кнопка «Играть» не вернулась и после перезагрузки");
          return;
        }
        let rearmed = false;
        try {
          writePostgameMark(markSource, true, markIssuedAt || now);
          rearmed = true;
        } catch {
          /* хранилище недоступно — перезагрузка без моста бессмысленна */
        }
        if (!rearmed) {
          giveUp("страница зажата лоадером, а мост не сохранить — продолжите вручную (F5)");
          return;
        }
        log.warn(SCOPE, "кнопка «Играть» зажата лоадером — перезагружаем страницу поиска (одноразово)");
        resetEpisode();
        jamReload.run();
        return;
      }
      scheduleDecision(loaderSince + JAM_RELOAD_AFTER_MS - now + 250);
      return;
    }
    loaderSince = 0;
    // Скелетон: появление кнопки — мутация, она разбудит; таймер нужен
    // дедлайну на случай замершей страницы.
    scheduleDecision(armedAt + EPISODE_WINDOW_MS - now + 250);
    return;
  }
  loaderSince = 0;
  // Выдержка ПЕРЕД первым касанием «Играть»: сайт мог ещё не узнать, что
  // игрок в игре (см. PLAY_SETTLE_*). Когда решающий блок уже видели или
  // quit-шаг ходил — статус известен, выдержка не нужна.
  if (!decideSeen && quitAttempts === 0 && confirmAttempts === 0 && playAttempts === 0) {
    const settleMs = markSource === "finished" ? PLAY_SETTLE_FINISHED_MS : PLAY_SETTLE_VIEWER_MS;
    if (now - armedAt < settleMs) {
      if (!settleLogged) {
        settleLogged = true;
        log.info(SCOPE, "ждём, пока сайт определит статус игрока, прежде чем жать «Играть»");
      }
      scheduleDecision(armedAt + settleMs - now + 100);
      return;
    }
  }
  if (play.disabled || play.hasAttribute("disabled")) {
    // Не выбраны очереди — решение за игроком, не за нами.
    giveUp("кнопка «Играть» недоступна — не выбраны очереди");
    return;
  }
  if (playAttempts === 0) {
    // Формулировка без аванса: подтверждение старта — секундомер сайта.
    showToast("Снова встаю в поиск… 🔁", { key: `postgame-acting-${Date.now()}` });
  }
  clickStage(play, null, playAttempts, () => playAttempts++, "Играть");
}

/**
 * Тестовый шов перезагрузки: jsdom не реализует location.reload (паттерн
 * queue-requeue). Продовое поведение — обычный reload страницы поиска.
 */
export const jamReload = {
  run(): void {
    location.reload();
  },
};

// ── маршрутизация и жизненный цикл ──

/** Смена маршрута внутри одного документа (страховка от SPA-переходов). */
function syncRoute(): void {
  if (location.pathname === lastPathname) return;
  const firstRun = lastPathname === "";
  lastPathname = location.pathname;
  if (firstRun) return;
  if (armed) log.info(SCOPE, "эпизод «В поиск» сброшен: смена страницы");
  resetEpisode();
  clickStorageWarned = false;
  if (isSearchPath(location.pathname)) consumePending();
}

/**
 * Окно захвата стримера. Сайт открывает его сам: window.open(location.href +
 * "?role=viewer&game_id=…", "streamWindow") — то есть viewer-вкладка бывает
 * у ЖИВОГО игрока посреди матча. В ней кнопка (1) попала бы в эфир OBS и
 * (2) мискликом увела бы стримера из его же игры (блокер A ревью 07.08.2026).
 */
function isStreamCaptureWindow(): boolean {
  try {
    return window.name === "streamWindow";
  } catch {
    return false;
  }
}

/**
 * Эта вкладка держит ЖИВОЙ матч игрока (ответ на пробу сторожа).
 *
 * Нужны ПОЗИТИВНЫЕ доказательства идущей игры, а не «не зритель и не
 * победа»: залежавшаяся вкладка мёртвой комнаты (экран ошибки после
 * роспуска — известный обычай пользователей, кейс vendettka 05.08.2026)
 * иначе блокировала бы легитимный выход умершего игрока. Доказательства —
 * те же, что у queue-requeue.matchIsRunning: набор игроков (.new-stage —
 * увод из собирающегося лобби ломает игру остальным), фиксированный экран
 * (пауза/промах/итог — victory отсекает первый гейт) или непустая стадия.
 * Свежезагруженная комната без стадии и оборванная связь отвечают «не жив» —
 * fail-open сторожа осознанный: он дополнительный пояс, не единственный.
 */
function roomHoldsLiveMatch(): boolean {
  if (!isGameRoomPath(location.pathname)) return false;
  if (isViewerMode()) return false;
  if (matchFinishedVisible()) return false;
  if (document.querySelector(SITE.pregameScreen)) return true;
  if (document.querySelector(SITE.roomFixedState)) return true;
  return Array.from(document.querySelectorAll<HTMLElement>(SITE.runningStageMarkers)).some(
    (el) => norm(el.textContent).length > 0,
  );
}

function tick(): void {
  if (!settings || settings.postgame_requeue_enabled === false) return;
  syncRoute();
  if (isGameRoomPath(location.pathname)) {
    syncButton(!isStreamCaptureWindow() && (matchFinishedVisible() || isViewerMode()));
    return;
  }
  if (isSearchPath(location.pathname)) {
    // Кнопка комнаты не должна пережить гипотетический SPA-переход в поиск.
    syncButton(false);
    searchTick();
    return;
  }
  // Прочие страницы: кнопки нет, машина не работает; невостребованный мост
  // умрёт сам по TTL.
  syncButton(false);
}

export const postgameSearchFeature: Feature = {
  id: "postgame-search",
  settingKey: "postgame_requeue_enabled",

  enable(ctx: FeatureContext) {
    settings = ctx.settings;
    // Ответчик сторожа живого матча: фон спрашивает КАЖДУЮ игровую вкладку.
    messageUnsub = onMessage((msg) => {
      if ("type" in msg && msg.type === "postgame_live_probe") {
        return Promise.resolve({ live: roomHoldsLiveMatch() });
      }
      return undefined;
    });
    trustedListener = (e: Event) => {
      if (e.isTrusted) noteTrustedInput();
    };
    document.addEventListener("pointerdown", trustedListener, true);
    document.addEventListener("keydown", trustedListener, true);
    visibilityListener = () => {
      if (document.hidden) return;
      // Не решать синхронно: порядок pointerdown/visibilitychange не
      // определён, клик фокуса должен успеть лечь в бэкофф (паттерн RQ-6).
      scheduleDecision(FOREGROUND_GRACE_MS);
    };
    document.addEventListener("visibilitychange", visibilityListener);
    if (isSearchPath(location.pathname)) consumePending();
    unsubscribe = onDomChange(() => tick());
    tick();
  },

  update(ctx: FeatureContext) {
    settings = ctx.settings;
    // Настройку могли поменять, пока машина СТОИТ у модалки: страница в этот
    // момент статична, а собственное пробуждение стоит на дедлайне — там
    // машину ждёт уже сдача, а не клик (ревью 07.08.2026, раунд 3).
    if (armed) scheduleDecision(FOREGROUND_GRACE_MS);
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    messageUnsub?.();
    messageUnsub = null;
    if (trustedListener) {
      document.removeEventListener("pointerdown", trustedListener, true);
      document.removeEventListener("keydown", trustedListener, true);
      trustedListener = null;
    }
    if (visibilityListener) {
      document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
    }
    cancelDecision();
    resetEpisode();
    lastTrustedInputAt = 0;
    lastPathname = "";
    clickStorageWarned = false;
    document.getElementById(BUTTON_ID)?.remove();
    settings = null;
  },
};
