/**
 * ГЛАВНАЯ фича content-скрипта: статистика игроков, заметки, история последних
 * игр, скрытие видео и тултипы со статистикой.
 *
 * Порт content-notes.js в архитектуру Feature. Поведение сохранено максимально
 * близко к оригиналу, при этом:
 *  - все chrome.* заменены на browser.* (@core/env);
 *  - флаги-настройки читаются из ctx.settings (FeatureContext), а не из storage;
 *  - console.* заменены на log.*;
 *  - множество MutationObserver + setInterval сведены к одному onDomChange и
 *    одному периодическому интервалу-восстановителю;
 *  - имена игроков и данные сайта экранируются escapeHtml перед вставкой в innerHTML;
 *  - добавлен кэш статистики/последних игр по нику (Map), чтобы не дёргать API на
 *    каждый hover;
 *  - disable() полностью снимает слушатели/observers/интервалы и удаляет
 *    созданные элементы.
 *
 * settingKey: "statistics_enabled". Подфлаги (show_mmr/show_games/...) и тема
 * читаются из ctx.settings внутри; update(ctx) переотрисовывает тултипы и тему.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import {
  completeHistory,
  crossGames,
  fetchFirstPage,
  fetchHistory,
  oldestDate,
    type Crossover,
  type History,
} from "@core/crossover";
import { fetchFirstKilled } from "@core/match-brief";
import { getOwnUserId, ownNameFromTable, rememberOwnUserId } from "@core/own-user";
import { buttonThemeColor } from "@shared/button-theme";
import { lastGamesLimit } from "@shared/last-games";
import { showToast } from "@core/toast";
import { onDomChange, paintNickEl } from "@core/dom";
import { onMessage, sendRuntime } from "@core/messaging";
import { toggleFlipForPlayer, isPlayerFlipped, unflipAll } from "../camera-flip";
import { getMatchId } from "../match-data";
import { createRoleSvg } from "../role-sprite";
import { formatCrossover } from "../crossover-view";
import { redactNick } from "@shared/redact";
import { escapeHtml } from "@core/escape";
import { SITE, OWN, OWN_BUTTON_SELECTOR } from "@core/selectors";
import {
  loadNotes as loadNotesFromStore,
  saveNotes as saveNotesToStore,
  saveCustomTags as saveCustomTagsToStore,
  isSafeNoteKey,
  idKey,
  isIdKey,
  ID_KEY_PREFIX,
  NOTES_KEY,
  TAGS_KEY,
  NOTES_VERSION,
  buildNickColorIndex,
  nickColorFrom,
  withNickHistory,
} from "@core/notes-store";
import type { NoteRecord, NotesMap, NickColorIndex } from "@core/notes-store";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings, ExtMessage, NoteOp, NotesResultMsg } from "@shared/types";

// ───────────────────────── Типы данных API (any допустим) ─────────────────────────

interface RoleWinrate {
  winrate: string;
}

interface PlayerStatsEntry {
  ratingUnavailable?: boolean;
  fromRating?: boolean;
  mmr: number | string;
  totalGames: number | string;
  id: number | string;
  generalStats: {
    gamesCount: number;
    winsCount: number;
    firstKilledCount: number;
    killpercent: number;
    winrate: string;
  };
  roleStats: {
    civilian: RoleWinrate;
    sheriff: RoleWinrate;
    mafia: RoleWinrate;
    godfather: RoleWinrate;
  };
}

interface RatingPlayer {
  username?: string;
  user_id: number | string;
}

interface LastGameEntry {
  /** Номер матча: по нему добирается признак «первый убитый». */
  id: number;
  role: string;
  isWin: boolean;
  mmrChange: number;
  /**
   * Игрок был первым убитым. `undefined` — НЕ ЗНАЕМ (разбор матча не
   * загрузился или признак выключен настройкой): молчать в этом случае
   * обязательно, «не ПУ» было бы выдумкой.
   */
  firstKilled?: boolean;
}

/* NoteRecord / NotesMap живут в @core/notes-store — их делят content и popup. */

/**
 * Палитра меток игроков. `css` — любое значение для background:
 * сплошной цвет ИЛИ градиент (linear-gradient...). Старые метки (hex-цвет) совместимы.
 */
const TAG_PRESETS: Array<{ css: string; name: string }> = [
  { css: "", name: "нет" },
  // сплошные цвета
  { css: "#ef4444", name: "красный" },
  { css: "#f59e0b", name: "оранжевый" },
  { css: "#eab308", name: "жёлтый" },
  { css: "#22c55e", name: "зелёный" },
  { css: "#3b82f6", name: "синий" },
  { css: "#a855f7", name: "фиолетовый" },
  { css: "#06b6d4", name: "бирюзовый" },
  { css: "#ffffff", name: "белый" },
  { css: "#0a0a0a", name: "чёрный" },
  // градиенты
  { css: "linear-gradient(135deg,#ffffff,#ec4899)", name: "бело-розовый" },
  { css: "linear-gradient(135deg,#ff2d95,#0a0a0a)", name: "розово-чёрный" },
  { css: "linear-gradient(135deg,#0a0a0a,#ffffff)", name: "чёрно-белый" },
  { css: "linear-gradient(135deg,#ff512f,#f09819)", name: "огонь" },
  { css: "linear-gradient(135deg,#ef4444,#eab308,#22c55e,#3b82f6,#a855f7)", name: "радуга" },
];
const VERSION = NOTES_VERSION;

/** TTL кэшей статистики: за игровой вечер MMR меняется каждой игрой. */
const STATS_TTL_MS = 5 * 60 * 1000;
/**
 * Задержка намерения для ДОРОГИХ окон: сводка пересечений стоит двух историй,
 * а окно последних игр с «ПУ» — разбора каждой игры. Курсор, мазнувший по
 * столу, не должен поднимать десяток таких пачек. Дешёвые окна (и те же
 * последние игры без «ПУ») открываются сразу.
 */
const HOVER_INTENT_MS = 350;
/**
 * TTL готовой сводки пересечений. Дольше обычной статистики намеренно: она
 * меняется, только когда доигран ОБЩИЙ матч, а текущий доиграться посреди
 * себя не может. MMR за вечер скачет, число совместных игр — нет.
 */
const CROSSOVER_TTL_MS = 30 * 60 * 1000;
/** Пауза перед повторной попыткой после ошибки статистики (не долбим API). */
const STATS_ERROR_BACKOFF_MS = 30 * 1000;
/** TTL пустой истории игр: короче обычного, чтобы новые игры подтянулись. */
const EMPTY_GAMES_TTL_MS = 60 * 1000;

/** storage.local: массив ников (lowercase) с выключенным у нас звуком. */
const MUTED_PLAYERS_KEY = "pn_muted_players";

/** sessionStorage: ники (lowercase) с перевёрнутой камерой в текущей игре. */
const FLIPPED_PLAYERS_KEY = "pn_flipped_players";

/**
 * Потолок числа перевёрнутых камер. За столом максимум ~12 игроков, 30 — с
 * запасом. sessionStorage принадлежит САЙТУ (недоверенный источник, AGENTS.md
 * §5): без потолка подсунутый гигантский массив навсегда селился в Set и
 * раздувал каждую последующую запись persistFlippedPlayers (аудит хрупкости
 * 06.08.2026). Излишек молча отбрасывается срезом.
 */
const MAX_FLIPPED = 30;

/**
 * Разбор списка перевёрнутых камер из sessionStorage. Любой вход (не-JSON,
 * не-массив, не-строки, гигантский массив) даёт валидный Set размером не
 * больше MAX_FLIPPED — исключений наружу нет. Экспорт — тестовый шов для
 * property-тестов page-storage-trust (по паттерну noteTrustedInput в
 * queue-requeue.ts).
 */
export function parseFlippedPlayers(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return new Set();
    return new Set(
      list.filter((u): u is string => typeof u === "string" && u !== "").slice(0, MAX_FLIPPED),
    );
  } catch {
    /* повреждённый sessionStorage — просто начинаем с пустого набора */
    return new Set();
  }
}

/**
 * Один общий запрос списка активных игр на всех игроков. Раньше in-flight
 * дедуп ключевался ником: вход в игру с 10 игроками давал 10 ПАРАЛЛЕЛЬНЫХ
 * fetch полного /api/games ещё до первого наведения мыши.
 */
let activeGamesPromise: Promise<any[]> | null = null;
let activeGamesFetchedAt = 0;
const ACTIVE_GAMES_TTL_MS = 15_000;
let ratingListCache: RatingPlayer[] | null = null;
let ratingListFetchedAt = 0;
let ratingListInFlight: Promise<RatingPlayer[]> | null = null;

function fetchActiveGames(): Promise<any[]> {
  const now = Date.now();
  if (activeGamesPromise && now - activeGamesFetchedAt < ACTIVE_GAMES_TTL_MS) {
    return activeGamesPromise;
  }
  activeGamesFetchedAt = now;
  activeGamesPromise = fetch("https://game.polemicagame.com/api/games")
    .then(async (response) => {
      if (!response.ok) throw new Error(`active games API error: ${response.status}`);
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error("active games API returned invalid data");
      return data;
    })
    .catch((e) => {
      activeGamesPromise = null; // ошибку не кэшируем
      throw e;
    });
  return activeGamesPromise;
}

function fetchRatingList(): Promise<RatingPlayer[]> {
  if (ratingListCache && Date.now() - ratingListFetchedAt < STATS_TTL_MS) {
    return Promise.resolve(ratingListCache);
  }
  if (ratingListInFlight) return ratingListInFlight;

  // Множественное число и /default/: сайт переехал, старый singular-URL
  // отдаёт 404 — фолбэк резолва игрока по рейтингу был мёртв (аудит
  // устойчивости 01.08.2026, находка 2). Форма ответа прежняя (проверено
  // живым запросом: массив с user_id/username/mmr/total_games).
  const request = fetch("https://polemicagame.com/ratings/default/get-list?limit=1000")
    .then(async (response) => {
      if (!response.ok) throw new Error(`rating API error: ${response.status}`);
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error("rating API returned invalid data");
      ratingListCache = data as RatingPlayer[];
      ratingListFetchedAt = Date.now();
      return ratingListCache;
    })
    .finally(() => {
      if (ratingListInFlight === request) ratingListInFlight = null;
    });
  ratingListInFlight = request;
  return request;
}

/**
 * Кому из игроков за столом ещё нужен резолв id.
 *
 * Отдельной чистой функцией, потому что это ГЕЙТ ЧАСТОТЫ: проход по плиткам
 * идёт раз в две секунды, и без него резолв превратился бы в фоновый поток
 * запросов. Проверить это внутри класса на три тысячи строк нечем.
 */
export function pendingIdLookups(
  usernames: string[],
  ctx: { attempted: Set<string>; isKnown: (username: string) => boolean },
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of usernames) {
    const username = raw.trim();
    if (!username) continue;
    const lower = username.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (ctx.attempted.has(lower)) continue;
    if (ctx.isKnown(username)) continue;
    out.push(username);
  }
  return out;
}

async function findRatingPlayer(username: string): Promise<RatingPlayer | undefined> {
  const key = username.toLowerCase();
  return (await fetchRatingList()).find(
    (player) =>
      player.username?.toLowerCase() === key &&
      player.user_id !== undefined &&
      player.user_id !== null,
  );
}

function unavailablePlayerStats(): PlayerStatsEntry {
  return {
    ratingUnavailable: true,
    fromRating: true,
    mmr: "—",
    totalGames: "—",
    id: "—",
    generalStats: {
      gamesCount: 0,
      winsCount: 0,
      firstKilledCount: 0,
      killpercent: 0,
      winrate: "—",
    },
    roleStats: {
      civilian: { winrate: "—" },
      sheriff: { winrate: "—" },
      mafia: { winrate: "—" },
      godfather: { winrate: "—" },
    },
  };
}

// ───────────────────────── Менеджер фичи ─────────────────────────

/**
 * Классификация батча мутаций для полного прохода по плиткам (PERF-1).
 *
 * «identity» — появилась/ушла ЦЕЛАЯ плитка/строка участника: проход нужен
 * немедленно (игрок сел за стол / ушёл). «inner» — шевеление ВНУТРИ
 * существующих (таймеры речи, индикаторы, нотификации): проход дросселируется
 * — до этого любой такой чих запускал полный проход на каждом flush, до
 * 63 querySelectorAll/с (перф-аудит 06.08.2026). Чистая функция — для тестов.
 */
export type PlayerMutationTouch = "none" | "inner" | "identity";

export function classifyPlayerMutations(muts: MutationRecord[]): PlayerMutationTouch {
  const SCOPE_SEL =
    ".player, .participants-item, .participants, .profileinfo__main-info, .profileinfo";
  const CONTENT_SEL = ".player, .participants-item, .profileinfo__main-info";
  let inner = false;
  for (const m of muts) {
    if (m.type !== "childList") continue;
    for (const n of m.addedNodes) {
      if (n instanceof Element && (n.matches(CONTENT_SEL) || n.querySelector(CONTENT_SEL)))
        return "identity";
    }
    for (const n of m.removedNodes) {
      if (n instanceof Element && (n.matches(CONTENT_SEL) || n.querySelector(CONTENT_SEL)))
        return "identity";
    }
    if (!inner) {
      const t = m.target;
      const el = t instanceof Element ? t : t.parentElement;
      if (el?.closest(SCOPE_SEL)) inner = true;
    }
  }
  return inner ? "inner" : "none";
}

/** Пускать ли полный проход по этому батчу (identity — всегда, inner — дроссель). */
export function shouldRunMutationPass(
  touch: PlayerMutationTouch,
  now: number,
  lastPassAt: number,
  minIntervalMs = 1000,
): boolean {
  if (touch === "identity") return true;
  if (touch !== "inner") return false;
  return now - lastPassAt >= minIntervalMs;
}

/** Состояние счётчика пересборок одной плитки. */
export interface RebuildState {
  since: number;
  count: number;
  until: number;
}

/** Столько пересборок ряда в секунду уже считается штормом. */
export const REBUILD_LIMIT = 8;
/** Пауза после шторма: столько плитку не трогаем. */
export const REBUILD_COOLDOWN_MS = 5000;

/**
 * Пропускать ли очередную пересборку ряда кнопок.
 *
 * Чистая функция — тестовый шов: пересборка пишет в DOM, наблюдатель на
 * запись просыпается, и при мигающей подписи состава это самоподдерживающийся
 * цикл. Считаем частоту в скользящей секунде и при превышении молчим паузу.
 */
export function throttleRebuild(
  prev: RebuildState | undefined,
  now: number,
): { allowed: boolean; state: RebuildState; stormed: boolean } {
  const state: RebuildState = prev ?? { since: now, count: 0, until: 0 };
  if (now < state.until) return { allowed: false, state, stormed: false };
  if (now - state.since > 1000) {
    state.since = now;
    state.count = 0;
  }
  state.count++;
  if (state.count <= REBUILD_LIMIT) return { allowed: true, state, stormed: false };
  state.until = now + REBUILD_COOLDOWN_MS;
  return { allowed: false, state, stormed: true };
}

/**
 * Идёт ли ночь. Тот же признак, с которого начинает detectRolePhase в
 * auto-start: сайт вешает класс фазы на body. Разбирать ради прогрева тексты
 * стадий незачем — цена ошибки здесь всего лишь «прогреемся на минуту позже».
 */
export function isNightNow(): boolean {
  return document.body?.classList.contains("night") === true;
}

class PlayerNotesManager {
  private settings: Settings;
  /**
   * Полный проход по плиткам сейчас падает (латч, а не счётчик строк).
   * Проход идёт раз в 2 секунды: без латча устойчивая поломка давала бы
   * 1800 одинаковых строк в час и вытесняла из кольца первопричину
   * (аудит наблюдаемости 02.08.2026, PN-1).
   */
  private passFailed = false;
  private active = true;

  private notes: NotesMap = {};
  /** Пользовательские цвета меток (палитра), хранятся в storage.sync. */
  private customTags: string[] = [];
  /** Кэш статистики по нику (lowercase) — не дёргаем API повторно на hover. */
  private playerStats = new Map<string, PlayerStatsEntry>();
  /**
   * id игроков, известные ПОМИМО статистики (страница профиля: id из URL).
   * Отдельная карта, а не фейковая запись в playerStats: та несёт mmr/winrate,
   * и заглушка с нулями отравила бы тултипы/инлайн-статистику.
   */
  private profileIdByNick = new Map<string, string>();
  /**
   * Ники, для которых id уже пытались резолвить: без этого проход по плиткам
   * (раз в 2 секунды) дёргал бы резолв заново на каждом тике.
   */
  private idResolveAttempted = new Set<string>();
  private idResolveInFlight: Promise<void> | null = null;
  /** Когда резолв последний раз упал — чтобы не долбить сеть после отказа. */
  private idResolveFailedAt = 0;
  /** Кэш последних игр по нику (lowercase). */
  private lastGamesCache = new Map<string, LastGameEntry[]>();
  /**
   * Время загрузки кэша по нику. Раньше кэши жили до F5: MMR и винрейт в
   * тултипе замораживались с первого наведения на весь игровой вечер.
   */
  private statsFetchedAt = new Map<string, number>();
  /** Последняя проверка /api/games для записей, найденных только через рейтинг. */
  private activeGameCheckedAt = new Map<string, number>();
  private gamesFetchedAt = new Map<string, number>();
  /** Ники, по которым запрос уже в полёте (пересборка плитки не дублирует его). */
  private statsInFlight = new Set<string>();
  /** Время последней ошибки загрузки статистики по нику (для бэкоффа). */
  private statsErrorAt = new Map<string, number>();
  /** Запросы истории игр в полёте (дедупликация одновременных hover'ов). */
  private lastGamesInFlight = new Map<string, Promise<LastGameEntry[]>>();
  /**
   * Готовые сводки пересечений. Хранится ТОЛЬКО итог (полтора десятка чисел),
   * а истории, из которых он посчитан, отпускаются — просьба владельца
   * 13.08.2026 «не занимать буфер».
   *
   * `ttl` у записи свой: удачу держим долго (см. CROSSOVER_TTL_MS), а неудачу
   * — коротко, иначе сетевая икота замораживала бы «не удалось» на полчаса.
   */
  private crossoverCache = new Map<string, { at: number; ttl: number; data: Crossover | null }>();
  private crossoverInFlight = new Map<string, Promise<Crossover | null | undefined>>();
  /** Прогрев занят одним игроком — по одному за проход, без залпа. */
  private warmBusy = false;
  /**
   * Прогрев выключен до конца сессии: свой профиль не определился. Без этого
   * латча каждый проход (раз в 2с) заново дёргал бы рейтинг ради того же
   * ответа.
   */
  private warmStopped = false;
  /**
   * Счётчик пересборок ряда кнопок на плитку — сторож против «шторма».
   *
   * Пересборка сама пишет в DOM, а наблюдатель на запись просыпается. Если
   * подпись состава мигает (например, у плитки то появляется, то исчезает
   * видео-обёртка — так бывает при перестроении раскладки и открытии окон
   * настроек в договорке), получается самоподдерживающийся цикл: запись →
   * наблюдатель → пересборка → запись. Вкладка встаёт колом, и в журнал
   * ничего не попадает, потому что он сбрасывается раз в три секунды —
   * ровно та жалоба, которую не удавалось разобрать (12.08.2026).
   */
  private rebuildCounts = new Map<string, { since: number; count: number; until: number }>();
  /**
   * Своя история игр — одна на всех соперников за столом. Держится ровно
   * столько, сколько нужно: как только сводки по всем плиткам готовы,
   * releaseMyHistory() отпускает её (у завсегдатая это тысячи строк).
   */
  private myHistory: History | null = null;
  private myHistoryAt = 0;
  /** Своя история в полёте: прогрев и наведение мыши не тянут её дважды. */
  private myHistoryInFlight: Promise<History | null> | null = null;
  /** Тултипы, живущие порталом в body (для уборки осиротевших). */
  private portaledTooltips = new Set<HTMLElement>();
  /** Снятые в этой вкладке мьюты — не воскрешаем их при слиянии с диском. */
  private unmutedThisSession = new Set<string>();
  /** Удалённые в этой вкладке свои цвета — то же для палитры. */
  private removedTagsThisSession = new Set<string>();
  /** Живые плашки-уведомления (снимаются в disable). */
  private toasts = new Set<HTMLElement>();
  /** Ники с временно скрытым видео (в пределах сессии). */
  private hiddenVideos = new Set<string>();
  /**
   * Локально замьюченные игроки (ники, lowercase). ПЕРСИСТЕНТНО в
   * storage.local (ключ pn_muted_players) — по просьбе владельца мьют
   * действует во всех следующих играх, пока его не сняли. Глушим через
   * volume = 0 на ВСЕХ media-элементах плитки (см. applyMuteState — звук
   * идёт через отдельный <audio>, НЕ через video): Vue сайта биндит muted
   * и srcObject, но НЕ volume, поэтому наше значение переживает апдейты
   * компонента; пересоздание элемента ловится обычным refresh-циклом.
   */
  private mutedPlayers = new Set<string>();
  /** Закрытие открытой модалки заметки — нужно, чтобы disable() снял её слушатели. */
  private closeOpenModal: (() => void) | null = null;
  /**
   * Игроки (lowercase), чьи камеры пользователь перевернул в ЭТОЙ игре.
   * sessionStorage: живёт в рамках вкладки и переживает F5, но не тащится в
   * следующие игры/дни — сайт пересоздаёт video на каждой смене фазы, и без
   * этого набора переворот приходилось нажимать заново после каждой ночи.
   */
  private flippedPlayers = new Set<string>();
  /** Тултип → его кнопка: на время показа тултип уезжает в body (портал). */
  private tooltipAnchors = new WeakMap<HTMLElement, HTMLElement>();


  // Подписки/слушатели для последующей очистки в disable().
  private unsubscribers: Array<() => void> = [];
  private intervals: number[] = [];
  private docClickGuard: ((e: MouseEvent) => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private gameStateHandler: (() => void) | null = null;
  private matchStyleEl: HTMLStyleElement | null = null;
  private matchPageActive = false;

  constructor(ctx: FeatureContext) {
    this.settings = ctx.settings;
  }

  // ─────────── Жизненный цикл ───────────

  async enable(): Promise<void> {
    await this.loadNotes();
    await this.loadMutedPlayers();
    this.loadFlippedPlayers();

    this.syncMatchPageRoute(getMatchId() !== null);

    // Один общий наблюдатель за DOM вместо нескольких MutationObserver.
    // Полный проход — только на мутации, задевающие плитки/списки игроков:
    // до аудита 01.08.2026 (находка 2) проход шёл на ЛЮБУЮ мутацию (класс
    // звукового индикатора, текст таймера) — стабильно 4 раза в секунду.
    // Страховка от пропущенного — безусловный редкий проход в интервале ниже.
    this.unsubscribers.push(
      onDomChange((muts) => {
        if (this.matchPageActive) this.applyMatchPageMarker();
        if (this.settings.statistics_enabled === false) {
          this.removeStatisticsElements();
          return;
        }
        // Дроссель (перф-аудит 06.08.2026, PERF-1): «внутреннее» шевеление
        // плиток (таймеры речи, индикаторы) запускало полный проход на каждом
        // flush — до 63 QSA/с при страховочном интервале всего 0.5/с.
        // Появление/уход ЦЕЛОЙ плитки — немедленно; остальное — не чаще
        // раза в секунду, хвост добирает интервал ниже.
        const touch = classifyPlayerMutations(muts);
        if (shouldRunMutationPass(touch, Date.now(), this.lastMutationPassAt)) {
          this.lastMutationPassAt = Date.now();
          this.processExistingElements();
        }
      }),
    );

    // Страховочный редкий полный проход (2с): ловит всё, что не задело
    // фильтр mutationsTouchPlayers (атрибутные правки сайта внутри плиток,
    // пропущенные восстановления mute/скрытия видео) и заменяет прежний
    // восстановитель «кнопки пропали». Полный проход идемпотентен, 0.5 раза
    // в секунду — на порядок дешевле прежних четырёх.
    this.intervals.push(
      window.setInterval(() => {
        this.sweepOrphanTooltips();
        if (this.settings.statistics_enabled === false) {
          this.removeStatisticsElements();
          return;
        }
        this.processExistingElements();
      }, 2000),
    );

    // Приём сообщений из попапа: updateNotesSettings.
    // (updateAvatar удалён вместе со всей цепочкой аватара: UI загрузки в
    // popup.html никогда не существовало, фича была мёртвой с момента порта.)
    this.unsubscribers.push(
      onMessage((msg: ExtMessage) => {
        if (!("type" in msg)) return;
        if (msg.type === "updateNotesSettings" && msg.settings) {
          const cameraWasEnabled = this.settings.camera_rotate_enabled;
          this.settings = { ...this.settings, ...msg.settings };
          if (cameraWasEnabled && !this.settings.camera_rotate_enabled) unflipAll();
          if (this.settings.statistics_enabled === false) {
            this.removeStatisticsElements();
          } else {
            this.applyStatsButtonTheme();
            this.processExistingElements();
            // Точки «есть заметка» — здесь же: настройки приезжают ДВУМЯ
            // путями (это сообщение и storage.onChanged→update), причём
            // сообщение первым вливает их в this.settings — и проверка
            // «изменилось ли» во втором пути уже не видит изменения. Жалоба
            // 15.08.2026: тумблер выключен, а точка стоит.
            this.refreshNoteIndicators();
            // Выключение nick_colors_enabled должно снять покраску сразу.
            this.refreshNickColors();
            // Смена толщины рамки должна примениться сразу, без ожидания
            // прохода DOM-наблюдателя.
            this.refreshPlayerTags();
          }
          this.updateAllTooltips();
        }
        if (msg.type === "openNickColors") this.openNickColorManager();
      }),
    );

    // Live-обновление заметок: изменения в storage (правка в другой вкладке или
    // импорт из popup) сразу подхватываются — индикаторы и тултипы обновляются.
    const storageListener = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "local") return;
      // Палитра меток тоже общая — раньше её изменения из другой вкладки терялись.
      if (changes[TAGS_KEY]) {
        const next = changes[TAGS_KEY].newValue;
        if (Array.isArray(next)) this.customTags = next as string[];
      }
      // Мьюты общие между вкладками: без этой ветки вкладка со старым Set
      // затирала бы чужие мьюты при первом же своём клике (пишется весь список).
      if (changes[MUTED_PLAYERS_KEY]) {
        const next = changes[MUTED_PLAYERS_KEY].newValue;
        if (Array.isArray(next)) {
          this.mutedPlayers = new Set(
            next.filter((u): u is string => typeof u === "string" && u !== ""),
          );
          this.processExistingElements();
        }
      }
      if (!changes[NOTES_KEY]) return;
      this.notes = (changes[NOTES_KEY].newValue as NotesMap) || {};
      // Пришла валидная карта из другого контекста — безопасная точка
      // восстановления после сбоя чтения: блок записей можно снять.
      this.notesReadOnly = false;
      this.refreshNoteIndicators();
      this.refreshPlayerTags();
      this.refreshNickColors();
      this.updateAllTooltips();
    };
    browser.storage.onChanged.addListener(storageListener);
    this.unsubscribers.push(() => browser.storage.onChanged.removeListener(storageListener));

    // Обновление при возвращении на вкладку и кастомные события смены состояния.
    this.visibilityHandler = () => {
      if (!document.hidden) this.processExistingElements();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    this.gameStateHandler = () => this.processExistingElements();
    document.addEventListener("gameStateChanged", this.gameStateHandler);
    document.addEventListener("dayNightChanged", this.gameStateHandler);

    // Защита от кликов по веб-камере судьи (capture phase).
    this.docClickGuard = (e: MouseEvent) => {
      try {
        if (!this.settings.disable_webcam_clicks) return;
        const target = e.target as HTMLElement | null;
        // Класс .button.preset-1.small.desktop-version исключён из списка:
        // он общий у кнопки камеры И шестерёнки настроек — guard глушил
        // клики по настройкам (в т.ч. синтетические клики F8-паузы).
        // Камеру покрывают video-селекторы.
        const isWebcamArea =
          target?.closest?.(".player__video-wrapper, .player__video, .video-control") ?? null;
        if (isWebcamArea) {
          e.stopImmediatePropagation();
          e.stopPropagation();
          e.preventDefault();
        }
      } catch {
        /* no-op */
      }
    };
    document.addEventListener("click", this.docClickGuard, true);

    // Первичная обработка уже отрисованных игроков.
    this.processExistingElements();
  }

  disable(): void {
    this.active = false;
    for (const un of this.unsubscribers) {
      try {
        un();
      } catch (e) {
        log.warn("player-notes", "unsubscribe failed", e);
      }
    }
    this.unsubscribers = [];

    for (const id of this.intervals) clearInterval(id);
    this.intervals = [];

    if (this.docClickGuard) {
      document.removeEventListener("click", this.docClickGuard, true);
      this.docClickGuard = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.gameStateHandler) {
      document.removeEventListener("gameStateChanged", this.gameStateHandler);
      document.removeEventListener("dayNightChanged", this.gameStateHandler);
      this.gameStateHandler = null;
    }

    unflipAll();
    // Удаляем все созданные элементы.
    this.removeStatisticsElements();
    // Открытые модалки заметок/истории: через close(), иначе останется
    // висеть capture-слушатель keydown вместе со всем DOM модалки.
    this.closeOpenModal?.();
    this.closeOpenModal = null;
    document.querySelectorAll(".polemica-note-modal").forEach((el) => el.remove());

    if (this.matchStyleEl) {
      this.matchStyleEl.remove();
      this.matchStyleEl = null;
    }
    this.matchPageActive = false;
    if (document.body.getAttribute("data-page-type") === "match") {
      document.body.removeAttribute("data-page-type");
    }

    this.playerStats.clear();
    this.lastGamesCache.clear();
    this.lastGamesInFlight.clear();
    this.crossoverCache.clear();
    this.crossoverInFlight.clear();
    this.myHistory = null;
    this.myHistoryAt = 0;
    this.myHistoryInFlight = null;
    this.warmBusy = false;
    this.warmStopped = false;
    this.statsErrorAt.clear();
    this.portaledTooltips.clear();
    for (const t of this.toasts) t.remove();
    this.toasts.clear();
    this.unmutedThisSession.clear();
    this.removedTagsThisSession.clear();
    this.profileIdByNick.clear();
    this.idResolveAttempted.clear();
    this.idResolveFailedAt = 0;
    this.nickIndexCache = null;
    this.colorIndexCache = null;
    this.hiddenVideos.clear();
    // Мьют персистентный, но при выключенной фиче звук обязан вернуться:
    // расширение «ничего не делает», когда его выключили (§4 п.7).
    document
      .querySelectorAll<HTMLMediaElement>('video[data-pn-muted="true"], audio[data-pn-muted="true"]')
      .forEach((v) => {
        if (v.volume === 0) v.volume = 1;
        delete v.dataset.pnMuted;
      });
    this.mutedPlayers.clear();
  }

  update(ctx: FeatureContext): void {
    const cameraWasEnabled = this.settings.camera_rotate_enabled;
    const gamesViewChanged =
      this.settings.last_games_count !== ctx.settings.last_games_count ||
      this.settings.last_games_first_killed !== ctx.settings.last_games_first_killed;
    this.settings = ctx.settings;
    // В кэше лежат СТАРЫЕ списки: без сброса «показывать 8» и «показывать ПУ»
    // включались бы только через пять минут, когда кэш протухнет сам.
    if (gamesViewChanged) {
      this.lastGamesCache.clear();
      this.gamesFetchedAt.clear();
    }
    if (cameraWasEnabled && !this.settings.camera_rotate_enabled) unflipAll();
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }
    // Тумблер точки применяется сразу, БЕЗУСЛОВНО: сравнение «изменилось ли»
    // тут не работает — быстрый путь (сообщение попапа) вливает настройки
    // раньше, и диф всегда пуст. Сам refresh идемпотентен и дёшев.
    this.refreshNoteIndicators();
    this.applyStatsButtonTheme();
    this.processExistingElements();
    this.updateAllTooltips();
  }

  // ─────────── Заметки (storage.local, см. @core/notes-store) ───────────

  /** true = чтение заметок упало; любые записи заблокированы (иначе пустая
   *  карта в памяти при следующем save стёрла бы все заметки на диске). */
  private notesReadOnly = false;

  /**
   * Все записи карты заметок этой вкладки — строго по очереди. Миграция
   * (автоматический писатель с hover'а) и сохранение из модалки иначе могли
   * переплестись: миграция читала диск, модалка писала заметку другого
   * игрока, миграция записывала свою карту БЕЗ неё. Кросс-вкладочная гонка
   * остаётся (§6 п.19), внутривкладочная — устранена.
   */
  private notesWriteQueue: Promise<unknown> = Promise.resolve();

  private enqueueNotesWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.notesWriteQueue.then(task, task);
    this.notesWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadNotes(): Promise<void> {
    const { notes, customTags, loadFailed } = await loadNotesFromStore();
    this.notes = notes;
    this.customTags = customTags;
    this.notesReadOnly = loadFailed === true;
    if (this.notesReadOnly) {
      log.warn("player-notes", "заметки не прочитались — запись заблокирована");
      // Сказать СРАЗУ, а не когда человек нажмёт «Сохранить» и получит отказ:
      // до этого момента он видит пустые заметки и думает, что они пропали
      // (аудит наблюдаемости 02.08.2026, раздел «Ответ пользователю»).
      showToast(
        "Заметки не загрузились — данные НЕ удалены, но сохранение временно заблокировано",
        { key: "notes-read-only", kind: "warn", durationMs: 8000 },
      );
    }
    log.debug("player-notes", "notes loaded", Object.keys(this.notes).length);
  }

  private async loadMutedPlayers(): Promise<void> {
    try {
      const res = await browser.storage.local.get({ [MUTED_PLAYERS_KEY]: [] });
      const list = res[MUTED_PLAYERS_KEY];
      if (Array.isArray(list)) {
        for (const u of list) if (typeof u === "string" && u) this.mutedPlayers.add(u);
      }
    } catch (e) {
      log.warn("player-notes", "muted players load failed", e);
    }
  }

  /**
   * Мьюты пишутся СЛИЯНИЕМ со свежим списком с диска: обе вкладки хранят
   * список целиком, и «последний писатель побеждает» терял мьюты, сделанные
   * в соседней вкладке (аудит безопасности 01.08.2026, находка 8). Ошибку
   * записи показываем пользователю — раньше она молча уходила в лог, а после
   * перезагрузки мьют исчезал.
   */
  private persistMutedPlayers(): void {
    void (async () => {
      try {
        const cur = (await browser.storage.local.get({ [MUTED_PLAYERS_KEY]: [] })) as Record<
          string,
          unknown
        >;
        const disk = Array.isArray(cur[MUTED_PLAYERS_KEY])
          ? (cur[MUTED_PLAYERS_KEY] as string[])
          : [];
        // Снятые в ЭТОЙ вкладке мьюты не должны воскресать из дискового списка.
        const merged = new Set([...disk.filter((n) => !this.unmutedThisSession.has(n))]);
        for (const n of this.mutedPlayers) merged.add(n);
        await browser.storage.local.set({ [MUTED_PLAYERS_KEY]: [...merged] });
      } catch (e) {
        log.warn("player-notes", "muted players save failed", e);
        this.toast("Не удалось сохранить мьют — он слетит после перезагрузки", true);
      }
    })();
  }

  private async saveCustomTags(): Promise<boolean> {
    // Та же дыра «пишем непрочитанное», что у заметок: при упавшем loadNotes
    // палитра в памяти пуста, и запись стёрла бы пользовательские цвета.
    if (this.notesReadOnly) return false;
    // Слияние со свежей палитрой с диска — по той же причине, что у мьютов:
    // две вкладки писали массив целиком и теряли цвета друг друга.
    try {
      const cur = (await browser.storage.local.get({ [TAGS_KEY]: [] })) as Record<string, unknown>;
      const disk = Array.isArray(cur[TAGS_KEY]) ? (cur[TAGS_KEY] as string[]) : [];
      const merged = [
        ...new Set([...disk.filter((t) => !this.removedTagsThisSession.has(t)), ...this.customTags]),
      ];
      this.customTags = merged;
      return await saveCustomTagsToStore(merged);
    } catch (e) {
      log.warn("player-notes", "custom tags merge failed", e);
      return await saveCustomTagsToStore(this.customTags);
    }
  }

  /**
   * Сохранить ЗАТРОНУТЫЕ ключи через координатор в background.
   *
   * Вызывающий уже мутировал this.notes (мгновенный UI) и передаёт список
   * ключей, которые он менял. Раньше сюда уходила ВСЯ карта, и вторая
   * вкладка, писавшая другого игрока в те же секунды, затирала правку
   * (аудит lifecycle 01.08.2026, находка 2 — КРИТИЧНО). Теперь запись
   * выполняет background: одна очередь на браузер, свежая карта читается
   * непосредственно перед применением.
   *
   * Возвращает false, если запись не удалась — интерфейс обязан это показать.
   */
  private async saveNotes(touchedKeys: string[]): Promise<boolean> {
    if (this.notesReadOnly) return false;
    const ops: NoteOp[] = touchedKeys.map((key) => ({
      key,
      record: (this.notes[key] as unknown) ?? null,
    }));
    return await this.commitNoteOps(ops);
  }

  /**
   * Отправка операций координатору с честным фолбэком.
   *
   * fallbackMap обязателен там, где результат собран НЕ в this.notes, а в
   * отдельной карте (ленивая миграция читает свежую карту с диска): без него
   * фолбэк записал бы устаревший снимок памяти — то есть ровно ту потерю
   * чужих правок, от которой защищались (ревью пакета B, находка 1).
   */
  private async commitNoteOps(ops: NoteOp[], fallbackMap?: NotesMap): Promise<boolean> {
    if (!ops.length) return true;
    try {
      const res = await sendRuntime<NotesResultMsg>({ type: "notes_apply_ops", ops });
      if (res && typeof res.ok === "boolean") {
        // Координатор возвращает свежую карту — подхватываем её целиком,
        // чтобы память вкладки сразу видела и чужие правки.
        if (res.ok && res.notes) this.notes = res.notes as NotesMap;
        return res.ok;
      }
    } catch (e) {
      log.debug("player-notes", "notes coordinator unavailable", e);
    }
    // Фолбэк: background не ответил (старая вкладка после обновления
    // расширения, воркер недоступен). Пишем как раньше — не хуже прежнего
    // поведения, зато правка пользователя не теряется молча.
    log.warn("player-notes", "координатор недоступен — пишем карту напрямую");
    const map = fallbackMap ?? this.notes;
    const ok = await saveNotesToStore(map);
    if (ok && fallbackMap) this.notes = fallbackMap;
    return ok;
  }

  /** userId игрока, если статистика его уже резолвила (иначе undefined). */
  private noteUserId(username: string): number | string | undefined {
    const lower = username.toLowerCase();
    const id = this.playerStats.get(lower)?.id ?? this.profileIdByNick.get(lower);
    // БЕЛЫЙ список вместо чёрного: принимаем только положительное целое.
    // Чёрный список («???», "") пропустил бы плейсхолдеры заглушек — так
    // "—" из unavailablePlayerStats чуть не отправил заметки ВСЕХ
    // недоступных игроков в один общий ключ u:— (чужая заметка в тултипе
    // соседа + взаимная перезапись). Блокер ревью 8.1.29.
    if (typeof id === "number") return Number.isInteger(id) && id > 0 ? id : undefined;
    if (typeof id === "string" && /^\d+$/.test(id) && id !== "0") return id;
    return undefined;
  }

  /**
   * Ключ заметки игрока: `u:<id>`, если id известен, иначе ник (легаси).
   * Заметки по id переживают смену ника и не путают тёзок.
   */
  private noteKeyFor(username: string): string {
    const id = this.noteUserId(username);
    if (id !== undefined) {
      const key = idKey(id);
      // Для ЧТЕНИЯ id-ключ приоритетен, но если записи под ним ещё нет,
      // а под ником есть — читаем ник (миграция могла не успеть).
      if (this.notes[key] !== undefined || this.notes[username] === undefined) return key;
      return username;
    }
    if (this.notes[username] !== undefined) return username;
    // id не резолвлен (статистика ещё грузится или профиль скрыт), записи под
    // ником нет — ищем id-запись по её полю nick. Без этого игроки, раскрашенные
    // через менеджер (запись сразу на id-ключе), стояли белыми до резолва id,
    // а со скрытым профилем — вечно.
    // Компромисс: rec.nick — исторический; если ник освободили и занял другой
    // игрок, до резолва id совпадение отдаст чужую запись (та же слабая
    // идентичность, что у легаси-ник-ключей; резолв id её вытесняет).
    return this.idKeyByNick().get(username.toLowerCase()) ?? username;
  }

  /** Кэш «lowercase-ник → id-ключ записи»; TTL, а не инвалидация по каждому
   *  из десятка мест мутации this.notes: секунда устаревания не видна глазу,
   *  а пропущенная инвалидация — вечный баг. */
  private nickIndexCache: { at: number; map: Map<string, string> } | null = null;

  private idKeyByNick(): Map<string, string> {
    const now = Date.now();
    if (this.nickIndexCache && now - this.nickIndexCache.at < 1000) {
      return this.nickIndexCache.map;
    }
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(this.notes)) {
      if (isIdKey(k) && v && typeof v !== "string" && v.nick) {
        map.set(v.nick.toLowerCase(), k);
      }
    }
    this.nickIndexCache = { at: now, map };
    return map;
  }

  private getNote(username: string): NoteRecord | string | undefined {
    return this.notes[this.noteKeyFor(username)];
  }

  private getNoteText(username: string): string {
    const note = this.getNote(username);
    if (!note) return "";
    return typeof note === "string" ? note : note.text || "";
  }

  /**
   * Прежние ники игрока. Есть только у записей с вечным ключом `u:<id>` —
   * у ник-ключа прошлого имени взяться неоткуда, ключ им и является.
   */
  private getFormerNicks(username: string): string[] {
    const note = this.getNote(username);
    if (!note || typeof note === "string") return [];
    const current = username.toLowerCase();
    return (note.nicks ?? []).filter((n) => n.toLowerCase() !== current);
  }

  private getNoteTag(username: string): string {
    const note = this.getNote(username);
    return note && typeof note !== "string" ? note.tag || "" : "";
  }

  /** Сохранённый цвет ника (без учёта настройки — для диалогов). */
  private getRawNickColor(username: string): string {
    const note = this.getNote(username);
    return note && typeof note !== "string" ? note.nickColor || "" : "";
  }

  /** Цвет ника для отрисовки: пустая строка, если фича выключена. */
  private getNickColor(username: string): string {
    if (this.settings.nick_colors_enabled === false) return "";
    return this.getRawNickColor(username);
  }

  /** Все легаси-ключи-ники этого игрока (точный + отличающиеся регистром). */
  private nickKeysFor(username: string): string[] {
    const lower = username.toLowerCase();
    return Object.keys(this.notes).filter((k) => !isIdKey(k) && k.toLowerCase() === lower);
  }

  /**
   * Ленивая миграция ник → id: вызывается, когда статистика резолвила userId.
   * «Vasya» и «vasya» сливаются в одну запись (побеждает более свежая),
   * ник сохраняется внутри записи для экспорта и отображения.
   */
  private migrateNoteToId(username: string, userId: number | string): Promise<void> {
    if (this.nickKeysFor(username).length === 0) return Promise.resolve();
    return this.enqueueNotesWrite(() => this.doMigrateNoteToId(username, userId));
  }

  private async doMigrateNoteToId(username: string, userId: number | string): Promise<void> {
    const key = idKey(userId);

    // Миграция — АВТОМАТИЧЕСКИЙ писатель всей карты (срабатывает без действий
    // пользователя). Работаем со СВЕЖЕЙ картой с диска, а не со снапшотом
    // памяти: иначе вкладка со старой памятью затирала бы заметку, только что
    // сохранённую в другой вкладке (окно RMW сжимается с «минут» до мс).
    const { notes: fresh, loadFailed } = await loadNotesFromStore();
    if (loadFailed || !this.active) return;

    const lower = username.toLowerCase();
    const freshNickKeys = Object.keys(fresh).filter(
      (k) => !isIdKey(k) && k.toLowerCase() === lower,
    );
    if (freshNickKeys.length === 0) return;

    const ts = (n: NoteRecord | string | undefined) =>
      n && typeof n !== "string" && typeof n.timestamp === "number" ? n.timestamp : 0;
    const toRecord = (n: NoteRecord | string): NoteRecord =>
      typeof n === "string" ? { text: n, timestamp: 0 } : n;

    // toRecord, а не typeof-проверка: строковая (легаси) запись под u:-ключом
    // игнорировалась, ник-запись побеждала «по умолчанию» и затирала её текст
    // без участия пользователя. Такие записи есть у реальных пользователей —
    // прежние версии миграции клали строку под id-ключ (аудит безопасности
    // 01.08.2026, находка 12; поймано ревью применения).
    let best: NoteRecord | undefined =
      fresh[key] !== undefined ? toRecord(fresh[key]) : undefined;
    // Текст легаси-СТРОКИ под id-ключом: у неё ts=0, поэтому любая ник-запись
    // с настоящим временем побеждает её по времени. Такой текст нельзя терять
    // молча — ниже он дописывается в победителя наравне с ничьёй.
    const idLegacyText = typeof fresh[key] === "string" ? (fresh[key] as string) : "";
    const losers: NoteRecord[] = [];
    for (const nk of freshNickKeys) {
      const record = toRecord(fresh[nk]);
      if (!best) {
        best = record;
      } else if (ts(record) > ts(best)) {
        losers.push(best);
        best = record;
      } else {
        losers.push(record);
      }
    }
    if (!best) return;

    // Ничья по времени (обе легаси, ts=0) с РАЗНЫМ текстом — не уничтожаем
    // проигравший текст молча, а дописываем его в запись.
    const winner: NoteRecord = { ...best };
    for (const loser of losers) {
      if (
        loser.text &&
        loser.text !== winner.text &&
        (ts(loser) === ts(winner) || loser.text === idLegacyText)
      ) {
        winner.text = winner.text ? `${winner.text}\n[слито: ${loser.text}]` : loser.text;
      }
      // Цвет и метка наследуются БЕЗУСЛОВНО (непустое побеждает пустое):
      // свежая запись без цвета почти всегда означает «заметку сохранили,
      // пока цвет жил в другой записи этого же игрока», а не «цвет сняли».
      // Раньше слияние молча теряло цвет навсегда (жалоба 31.07.2026:
      // «~50 из 200 раскрашенных ников стали белыми»).
      if (!winner.tag && loser.tag) winner.tag = loser.tag;
      if (!winner.nickColor && loser.nickColor) winner.nickColor = loser.nickColor;
    }

    fresh[key] = { ...winner, ...withNickHistory(winner, username) };
    for (const nk of freshNickKeys) delete fresh[nk];

    const migrationOps: NoteOp[] = [
      { key, record: fresh[key] as unknown },
      ...freshNickKeys.map((nk) => ({ key: nk, record: null })),
    ];
    // fresh как карта фолбэка: она собрана из СВЕЖЕГО чтения диска, в
    // отличие от this.notes. Память обновит сам commitNoteOps — картой от
    // координатора или fresh (при фолбэке).
    if (await this.commitNoteOps(migrationOps, fresh)) {
      log.debug("player-notes", "note migrated to id key", username, key);
      this.refreshNoteIndicators();
      this.refreshPlayerTags();
      this.updatePlayerTooltips(username);
    }
    // При неудаче записи память не трогаем вовсе — this.notes как была.
  }

  /** Подсветить плитку игрока меткой (цвет или градиент) через overlay-рамку. */
  private applyPlayerTag(container: HTMLElement, username: string): void {
    const tag = this.getNoteTag(username);
    let ring = container.querySelector<HTMLElement>(".pn-tag-ring");
    if (!tag) {
      ring?.remove();
      return;
    }
    if (!ring) {
      // getComputedStyle — только при создании рамки: вызов на каждый проход
      // по каждой плитке давал до 80 style-чтений/с (аудит 01.08.2026).
      if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
      ring = document.createElement("div");
      ring.className = "pn-tag-ring";
      container.appendChild(ring);
    }
    const width = this.frameWidthPx();
    // Перерисовываем только при смене метки/владельца/толщины: безусловная
    // запись style будила общий MutationObserver на каждом проходе. Владелец
    // (pnFor) нужен сторожу пересадки: ночью сайт двигает игроков по плиткам.
    if (
      ring.dataset.tag === tag &&
      ring.dataset.pnFor === username &&
      ring.dataset.pnWidth === width
    )
      return;
    ring.dataset.tag = tag;
    ring.dataset.pnFor = username;
    ring.dataset.pnWidth = width;
    // Градиентная рамка: маской вырезаем середину, остаётся рамка шириной width.
    // ВАЖНО: mask-composite ставим ПОСЛЕ shorthand-ов mask/-webkit-mask,
    // иначе shorthand сбрасывает composite в add и градиент заливает всю плитку.
    ring.style.cssText = `
      position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 5;
      padding: ${width}; background: ${tag};
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      filter: drop-shadow(0 0 4px rgba(0,0,0,.4));
    `;
  }

  /** Ширина рамки-метки в px по настройке (неизвестное значение = как раньше). */
  private frameWidthPx(): string {
    switch (this.settings.note_frame_width) {
      case "thin":
        return "1px";
      case "medium":
        return "2px";
      default:
        return "3px";
    }
  }

  /** Обновить подсветку плиток у всех видимых игроков. */
  private refreshPlayerTags(): void {
    document
      .querySelectorAll<HTMLElement>(`.${OWN.noteButton}[data-username]`)
      .forEach((btn) => {
        const u = btn.dataset.username;
        const container = btn.closest<HTMLElement>(SITE.player);
        if (u && container) this.applyPlayerTag(container, u);
      });
  }

  /**
   * Страница профиля (/profile/<id>): цвет ника, рамка метки на аватаре и
   * кнопка «Заметка» с жёлтой точкой-индикатором. id известен из URL, поэтому
   * запись идёт сразу на вечный u:-ключ (и модалка по пути поглощает
   * ник-легаси этого игрока). Идемпотентно: вызывается из DOM-прохода.
   */
  private ensureProfileNoteUI(): void {
    const m = location.pathname.match(/^\/profile\/(\d+)/);
    if (!m) return;
    const id = m[1];
    const nickEl = document.querySelector<HTMLElement>(".profileinfo__main-info-username");
    const nick = nickEl?.textContent?.trim() || "";
    if (!nickEl || !nick) return;

    this.profileIdByNick.set(nick.toLowerCase(), id);

    // Цвет ника (учитывает nick_colors_enabled и приоритет id-записи).
    paintNickEl(nickEl, this.colorForPlayer(id, nick), nick);

    // Рамка метки вокруг аватара.
    const avatar = document.querySelector<HTMLElement>("img.profileinfo__main-info-avatar");
    const avatarBox = avatar?.parentElement instanceof HTMLElement ? avatar.parentElement : null;
    if (avatar && avatarBox) this.applyProfileTagRing(avatarBox, avatar, nick);

    // Кнопка «Заметка» рядом с ником.
    let btn = document.querySelector<HTMLButtonElement>(".pn-profile-note-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "pn-profile-note-btn";
      btn.textContent = "Заметка";
      btn.title = `Заметка, метка и цвет ника для ${nick}`;
      // Без margin-left: шапка — flex с gap 1rem, свой отступ удвоил бы зазор.
      btn.style.cssText =
        "padding:3px 12px;border:1px solid rgba(99,102,241,.6);" +
        "border-radius:8px;background:rgba(99,102,241,.2);color:#fff;cursor:pointer;" +
        "font:600 12px system-ui,sans-serif;";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showNoteModal(nick);
      });
      nickEl.insertAdjacentElement("afterend", btn);
    }
    this.updateNoteIndicator(btn, nick);
  }

  /**
   * Рамка метки на аватаре профиля. Отдельно от applyPlayerTag: радиус
   * скругления копируется с самой картинки (аватар круглый/скруглённый, а
   * его обёртка — нет, и border-radius: inherit дал бы квадрат).
   */
  private applyProfileTagRing(box: HTMLElement, avatar: HTMLElement, username: string): void {
    const tag = this.getNoteTag(username);
    let ring = box.querySelector<HTMLElement>(".pn-tag-ring");
    if (!tag) {
      ring?.remove();
      return;
    }
    if (!ring) {
      // Style-чтения — только при создании (см. applyPlayerTag).
      if (getComputedStyle(box).position === "static") {
        box.style.position = "relative";
      }
      ring = document.createElement("div");
      ring.className = "pn-tag-ring";
      box.appendChild(ring);
    }
    const width = this.frameWidthPx();
    if (
      ring.dataset.tag === tag &&
      ring.dataset.pnFor === username &&
      ring.dataset.pnWidth === width
    )
      return;
    // Радиус читаем только при реальной перерисовке — не на каждый проход.
    const radius = getComputedStyle(avatar).borderRadius || "8px";
    ring.dataset.tag = tag;
    ring.dataset.pnFor = username;
    ring.dataset.pnWidth = width;
    ring.style.cssText = `
      position: absolute; inset: 0; border-radius: ${radius}; pointer-events: none; z-index: 5;
      padding: ${width}; background: ${tag};
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      filter: drop-shadow(0 0 4px rgba(0,0,0,.4));
    `;
  }

  /** Покрасить ник игрока на плитке (лобби и игра — разметка одна). */
  private applyNickColor(container: HTMLElement, username: string): void {
    const el = container.querySelector<HTMLElement>(SITE.playerName);
    if (el) paintNickEl(el, this.getNickColor(username), username);
  }

  /**
   * Сторож пересадки: сайт двигает игроков между плитками (ночная фаза), и
   * рамка/цвет прежнего жильца не должны доставаться новому. Сверяем
   * владельца декорации с ником, который СЕЙЧАС виден в плитке; при
   * несовпадении декорация снимается (правильная вернётся обычным проходом).
   * Ник не виден — не трогаем: нет данных для решения.
   */
  private sweepStaleDecorations(): void {
    document.querySelectorAll<HTMLElement>(".pn-tag-ring").forEach((ring) => {
      const nick = ring.parentElement
        ?.querySelector(SITE.playerName)
        ?.textContent?.trim();
      if (nick && (ring.dataset.pnFor || "") !== nick) ring.remove();
    });
    document.querySelectorAll<HTMLElement>("[data-pn-nick-color]").forEach((el) => {
      const owner = el.dataset.pnNickFor;
      if (owner === undefined) return; // покраска без владельца (не наша плитка)
      const nick = el.textContent?.trim() || "";
      if (nick && owner !== nick) paintNickEl(el, "");
    });
  }

  /**
   * Цвет по id (приоритет — вечный) и/или нику. Для мест, где игрок приходит
   * не плиткой, а строкой сайтового списка с href на профиль.
   */
  private colorForPlayer(id: string | undefined, nick: string | undefined): string {
    if (this.settings.nick_colors_enabled === false) return "";
    // Кэшированный индекс вместо сканов карты заметок: раньше строка списка
    // «Участники» без id-совпадения проходила все записи (30 участников ×
    // 200 заметок × 4 прохода/с — аудит 01.08.2026, находка 8). Тот же
    // TTL-подход, что у idKeyByNick.
    return nickColorFrom(this.colorIndex(), id, nick);
  }

  /** Кэш индекса цветов (byId/byNick), TTL 1с — см. комментарий idKeyByNick. */
  private colorIndexCache: { at: number; index: NickColorIndex } | null = null;

  private colorIndex(): NickColorIndex {
    const now = Date.now();
    if (this.colorIndexCache && now - this.colorIndexCache.at < 1000) {
      return this.colorIndexCache.index;
    }
    const index = buildNickColorIndex(this.notes);
    this.colorIndexCache = { at: now, index };
    return index;
  }

  /**
   * Сайтовый список «Участники» (страница поиска: кто стоит в очереди —
   * своя разметка, НЕ плитки игроков). Каждая строка — <a href="/profile/id">
   * с ником внутри .participants-name; красим по id из ссылки, это надёжнее
   * ника. Идемпотентность обеспечивает paintNickEl.
   */
  private applyParticipantColors(): void {
    const items = document.querySelectorAll<HTMLAnchorElement>(".participants-item");
    if (items.length === 0) return;
    items.forEach((item) => {
      const nameWrap = item.querySelector<HTMLElement>(".participants-name");
      if (!nameWrap) return;
      // Ник — в первом span контейнера (рядом лежат иконки twitch/подписки).
      const el = nameWrap.querySelector<HTMLElement>("span") || nameWrap;
      const id = (item.getAttribute("href") || "").match(/\/profile\/(\d+)/)?.[1];
      const nick = el.textContent?.trim();
      paintNickEl(el, this.colorForPlayer(id, nick), nick || undefined);
    });
  }

  /** Обновить цвет ника у всех видимых игроков (после правки в диалогах). */
  /** Пауза после неудачного резолва: сеть могла лечь, долбить её незачем. */
  private static readonly ID_RESOLVE_COOLDOWN_MS = 60_000;

  /**
   * Заранее выяснить userId игроков за столом.
   *
   * Зачем: заметка, цвет ника и метка роли живут под ВЕЧНЫМ ключом `u:<id>`,
   * а ник меняется. Раньше id резолвился только в `mouseenter` кнопки
   * статистики — то есть игрок, сменивший ник, сидел за столом «чужим»:
   * без цвета, без точки заметки, без метки, пока на него не наведёшь
   * (жалоба с видео 02.08.2026). Всё «оживало» после наведения, и выглядело
   * это как случайный сбой.
   *
   * Стоимость: `findRatingPlayer` читает ОБЩИЙ кэшированный список рейтинга —
   * один запрос на всех десятерых, а не по запросу на игрока. Полную
   * статистику по-прежнему грузим лениво, по наведению (перф-аудит 01.08.2026).
   */
  private ensurePlayerIdsResolved(usernames: string[]): void {
    if (this.idResolveInFlight) return;
    if (Date.now() - this.idResolveFailedAt < PlayerNotesManager.ID_RESOLVE_COOLDOWN_MS) return;
    const pending = pendingIdLookups(usernames, {
      attempted: this.idResolveAttempted,
      isKnown: (u) => this.noteUserId(u) !== undefined,
    });
    if (!pending.length) return;

    this.idResolveInFlight = (async () => {
      try {
        // Порядок ИСТОЧНИКОВ тот же, что на пути по наведению: сначала
        // активные игры, потом рейтинг. Только рейтинга мало — он топ-1000, и
        // для игрока за его пределами жалоба воспроизводилась бы один в один,
        // а «пробовали» больше не дало бы повторить (ревью 02.08.2026).
        let games: any[] = [];
        try {
          games = await fetchActiveGames();
        } catch (e) {
          log.warn("player-notes", "список активных игр недоступен, ищем в рейтинге", e);
        }
        if (!this.active) return;

        const idByNick = new Map<string, string>();
        for (const game of games) {
          for (const p of game.players ?? []) {
            const nick = typeof p?.username === "string" ? p.username.toLowerCase() : "";
            if (nick && p.id !== undefined && p.id !== null) idByNick.set(nick, String(p.id));
          }
        }

        let resolved = 0;
        for (const username of pending) {
          const lower = username.toLowerCase();
          let id = idByNick.get(lower);
          if (id === undefined) {
            const player = await findRatingPlayer(username);
            if (!this.active) return;
            const ratingId = player?.user_id;
            if (ratingId !== undefined && ratingId !== null) id = String(ratingId);
          }
          // Помечаем ТОЛЬКО когда оба источника ответили: иначе один сетевой
          // сбой навсегда лишал бы игрока оформления.
          this.idResolveAttempted.add(lower);
          if (id !== undefined) {
            this.profileIdByNick.set(lower, id);
            resolved++;
          }
        }

        if (!this.active) return;
        if (resolved) {
          // Индексы построены на старом составе — иначе цвет по id не найдётся.
          this.nickIndexCache = null;
          this.colorIndexCache = null;
          this.refreshNickColors();
          this.refreshNoteIndicators();
          this.refreshPlayerTags();
          log.info(
            "player-notes",
            "id игроков за столом определены заранее:",
            `${resolved} из ${pending.length}`,
          );
        }
      } catch (e) {
        // Хвост ников остаётся непомеченным: после паузы попробуем снова.
        this.idResolveFailedAt = Date.now();
        log.warn("player-notes", "не удалось определить id игроков за столом", e);
      } finally {
        this.idResolveInFlight = null;
      }
    })();
  }

  private refreshNickColors(): void {
    document
      .querySelectorAll<HTMLElement>(`.${OWN.playerIcons} > [data-username]`)
      .forEach((btn) => {
        const u = btn.dataset.username;
        const container = btn.closest<HTMLElement>(SITE.player);
        if (u && container) this.applyNickColor(container, u);
      });
    this.applyParticipantColors();
  }

  // ─────────── Загрузка статистики (с кэшем) ───────────

  private async loadPlayerStats(username: string): Promise<void> {
    if (!this.active || this.settings.statistics_enabled === false) return;
    const key = username.toLowerCase();
    const fetchedAt = this.statsFetchedAt.get(key) ?? 0;
    const cached = this.playerStats.get(key);
    const now = Date.now();
    const needsActiveRecheck =
      cached?.fromRating === true &&
      now - (this.activeGameCheckedAt.get(key) ?? 0) >= ACTIVE_GAMES_TTL_MS;
    if (cached && now - fetchedAt < STATS_TTL_MS && !needsActiveRecheck) return;
    if (this.statsInFlight.has(key)) return; // запрос уже в полёте
    // Бэкофф после ошибки: без него каждый повторный hover заново гнал три
    // профильных запроса по игроку с падающим API (аудит 01.08.2026).
    if (now - (this.statsErrorAt.get(key) ?? 0) < STATS_ERROR_BACKOFF_MS) return;
    this.statsInFlight.add(key);

    try {
      let games: any[] = [];
      try {
        games = await fetchActiveGames();
      } catch (e) {
        log.warn("player-notes", "active games lookup failed, using rating", e);
      }

      let player: any = null;
      for (const game of games) {
        const found = game.players?.find(
          (p: any) => p.username?.toLowerCase() === key,
        );
        if (found) {
          player = found;
          break;
        }
      }

      let userId: number | string;
      let mmr: number | string = "—";
      if (player) {
        userId = player.id;
        mmr = player.mmr ?? "—";
      } else {
        this.activeGameCheckedAt.set(key, Date.now());
        if (cached?.fromRating && Date.now() - fetchedAt < STATS_TTL_MS) return;
        log.debug("player-notes", `player ${username} not found in active games, using rating`);
        const ratingPlayer = await findRatingPlayer(username);
        if (!ratingPlayer) {
          if (!this.active) return;
          this.playerStats.set(key, unavailablePlayerStats());
          this.statsFetchedAt.set(key, Date.now());
          this.updatePlayerTooltips(username);
          return;
        }
        userId = ratingPlayer.user_id;
      }

      // ok-чек и таймаут: раньше не-2xx молча парсился, а зависший запрос
      // висел вечно (аудит 01.08.2026, находка 4).
      const getJson = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => {
          if (!r.ok) throw new Error(`stats API ${r.status}`);
          return r.json();
        });
      const [generalStats, roleStats, killcount]: [any[], any, any[]] = await Promise.all([
        getJson(
          `https://polemicagame.com/profile/default/get-role-statistic?user_id=${userId}&role=&game_type=league&scoring_type=scoring_2%2Cscoring_3`,
        ),
        getJson(
          `https://polemicagame.com/profile/default/get-statistic?user_id=${userId}&game_type=league&scoring_type=scoring_2%2Cscoring_3`,
        ),
        getJson(
          `https://polemicagame.com/profile/default/get-role-statistic?user_id=${userId}&role=civilian%2Csheriff&game_type=league&scoring_type=scoring_2%2Cscoring_3`,
        ),
      ]);

      const generalData = generalStats[0] || {};
      const killcounter = killcount[0] || {};

      const calculateWinrate = (wins: unknown, total: unknown): string => {
        const w = Number(wins) || 0;
        const t = Number(total) || 0;
        if (t === 0) return "0.0";
        return ((w / t) * 100).toFixed(1);
      };

      const entry: PlayerStatsEntry = {
        fromRating: !player,
        mmr,
        totalGames: Number(generalData.games_count) || "?",
        id: userId,
        generalStats: {
          gamesCount: Number(generalData.games_count) || 0,
          winsCount: Number(generalData.wins_count) || 0,
          firstKilledCount: Number(killcounter.first_killed_count) || 0,
          killpercent:
            Number(
              Math.trunc((killcounter.first_killed_count / killcounter.games_count) * 100),
            ) || 0,
          winrate: calculateWinrate(generalData.wins_count, generalData.games_count),
        },
        roleStats: {
          civilian: {
            winrate: calculateWinrate(
              roleStats.civilian?.wins_count,
              roleStats.civilian?.games_count,
            ),
          },
          sheriff: {
            winrate: calculateWinrate(
              roleStats.sheriff?.wins_count,
              roleStats.sheriff?.games_count,
            ),
          },
          mafia: {
            winrate: calculateWinrate(
              roleStats.mafia?.wins_count,
              roleStats.mafia?.games_count,
            ),
          },
          godfather: {
            winrate: calculateWinrate(
              roleStats.godfather?.wins_count,
              roleStats.godfather?.games_count,
            ),
          },
        },
      };

      if (!this.active) return;
      this.playerStats.set(key, entry);
      this.statsFetchedAt.set(key, Date.now());
      if (player) this.activeGameCheckedAt.delete(key);

      // userId резолвлен — самое время лениво перевезти заметку с ник-ключа
      // на вечный id-ключ (смена ника больше не теряет заметку).
      const resolvedId = this.noteUserId(username);
      if (resolvedId !== undefined) {
        this.migrateNoteToId(username, resolvedId).catch((e) =>
          log.error("player-notes", "note migration failed", e),
        );
      }

      // Обновляем ВСЕ отрисованные тултипы этого игрока: сайт рендерит одного
      // игрока в двух плитках (десктоп/мобайл), а querySelector обновлял
      // только первую — вторая навсегда оставалась с заглушками «???».
      this.updatePlayerTooltips(username);
    } catch (e) {
      this.statsErrorAt.set(key, Date.now());
      log.error("player-notes", `loadPlayerStats failed for ${redactNick(username)}`, e);
    } finally {
      this.statsInFlight.delete(key);
    }
  }

  // ─────────── Тема кнопок ───────────

  private getStatsThemeColor(): string {
    return buttonThemeColor(this.settings.stats_button_theme, this.settings.stats_button_color);
  }

  private applyButtonTheme(button: HTMLElement | null): void {
    if (!button) return;
    // Красная иконка замьюченного игрока — индикатор состояния, тема не должна
    // её перекрашивать (applyStatsButtonTheme проходит по всем кнопкам при
    // каждом изменении настроек, а гейт pnMuteState в syncMuteButton не даст
    // восстановить цвет без смены состояния).
    if (button.classList.contains(OWN.muteButton) && button.dataset.pnMuteState === "muted") {
      return;
    }
    const color = this.getStatsThemeColor();
    button.style.setProperty("--stats-button-theme-color", color);
    button.style.color = color;
    button.style.borderColor = color;
    button.style.background = "transparent";
    button.querySelectorAll<SVGElement>("svg").forEach((svg) => {
      svg.style.color = color;
      svg.style.setProperty("stroke", color, "important");
    });
    button.querySelectorAll<SVGElement>("path, circle, line, polyline").forEach((node) => {
      if (node.getAttribute("stroke")) {
        node.setAttribute("stroke", color);
        node.style.setProperty("stroke", color, "important");
      }
    });
  }

  private applyStatsButtonTheme(): void {
    document.querySelectorAll<HTMLElement>(OWN_BUTTON_SELECTOR).forEach((button) => {
      this.applyButtonTheme(button);
    });
  }

  // ─────────── Тултипы ───────────

  private generateTooltipContent(username: string): string {
    const stats: PlayerStatsEntry = this.playerStats.get(username.toLowerCase()) || {
      mmr: "???",
      totalGames: "?",
      id: "?",
      generalStats: {
        gamesCount: 0,
        winsCount: 0,
        firstKilledCount: 0,
        killpercent: 0,
        winrate: "?",
      },
      roleStats: {
        civilian: { winrate: "?" },
        sheriff: { winrate: "?" },
        mafia: { winrate: "?" },
        godfather: { winrate: "?" },
      },
    };

    const noteText = this.getNoteText(username) || "Нет заметок";

    let html = `<div class="tooltip-text" style="margin-bottom: 6px; font-size: 11px;">${escapeHtml(
      noteText,
    )}</div>`;
    if (stats.ratingUnavailable) {
      return `${html}<div class="tooltip-text" style="font-size: 10px;">Нет данных рейтинга</div>`;
    }
    html += `<div class="tooltip-text" style="font-size: 10px;">`;

    if (this.settings.show_mmr) {
      html += `MMR: ${escapeHtml(String(stats.mmr))}<br>`;
    }
    if (this.settings.show_games) {
      html += `Игр: ${escapeHtml(String(stats.totalGames))}<br>`;
    }
    if (this.settings.show_id) {
      html += `ID: ${escapeHtml(String(stats.id))}<br>`;
    }
    if (this.settings.show_winrate) {
      html += `WR: ${escapeHtml(String(stats.generalStats.winrate))}%<br>`;
    }
    if (this.settings.show_kills) {
      html += `Отстрелы: ${escapeHtml(String(stats.generalStats.firstKilledCount))} (${escapeHtml(
        String(stats.generalStats.killpercent),
      )}%)<br>`;
    }
    if (this.settings.show_roles) {
      html +=
        `<div class="tooltip-text" style="margin-top: 4px; font-size: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">` +
        `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg(
          "civilian",
          12,
        )}</span> ${escapeHtml(String(stats.roleStats.civilian.winrate))}%</span>` +
        `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg(
          "sheriff",
          12,
        )}</span> ${escapeHtml(String(stats.roleStats.sheriff.winrate))}%</span>` +
        `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg(
          "mafia",
          12,
        )}</span> ${escapeHtml(String(stats.roleStats.mafia.winrate))}%</span>` +
        `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg(
          "godfather",
          12,
        )}</span> ${escapeHtml(String(stats.roleStats.godfather.winrate))}%</span>` +
        `</div>`;
    }

    html += "</div>";
    return html;
  }

  /**
   * Тултипы ищутся по СОБСТВЕННОМУ data-username, а не через кнопку-предка:
   * пока тултип показан, он живёт в <body> (портал, см. showTooltip), и
   * селектор `.stats-button .tooltip` его бы не нашёл — открытый тултип
   * навсегда застревал бы на «Загрузка...».
   */
  private updateAllTooltips(): void {
    document
      .querySelectorAll<HTMLElement>(`.${OWN.tooltip}[data-username][data-pn-stats="1"]`)
      .forEach((tooltip) => {
        const username = tooltip.dataset.username;
        // Без проверки кэша: generateTooltipContent корректно рисует заглушки,
        // а гейт по playerStats.has оставлял в тултипе УДАЛЁННУЮ в другой
        // вкладке заметку, пока статистика не загрузилась.
        if (username) tooltip.innerHTML = this.generateTooltipContent(username);
      });
  }

  private updatePlayerTooltips(username: string): void {
    document
      .querySelectorAll(
        `.${OWN.tooltip}[data-pn-stats="1"][data-username=${cssAttr(username)}]`,
      )
      .forEach((tooltip) => {
        tooltip.innerHTML = this.generateTooltipContent(username);
      });
  }

  private createTooltip(username: string): HTMLDivElement {
    // БЕЗ немедленной загрузки статистики: раньше создание тултипов для
    // стола из 10 игроков давало залп из ~30 HTTP-запросов при входе в
    // комнату (аудит 01.08.2026, находка 4). Загрузку запускает mouseenter
    // кнопки статистики; до ответа тултип показывает заглушки «???».
    const tooltip = document.createElement("div");
    tooltip.className = OWN.tooltip;
    // Метки для поиска тултипа, пока он в портале (см. updateAllTooltips).
    // pn-stats отделяет тултип статистики от тултипа истории игр.
    tooltip.dataset.username = username;
    tooltip.dataset.pnStats = "1";
    tooltip.style.cssText = TOOLTIP_CSS;
    tooltip.innerHTML = this.generateTooltipContent(username);
    return tooltip;
  }

  /**
   * Показать тултип, перенеся его в <body>.
   *
   * ПОЧЕМУ ПОРТАЛ. У сайтового `.player__info` (наш контейнер кнопок) стоит
   * `overflow: hidden` И `backdrop-filter: blur(...)` — проверено живьём в
   * лобби 29.07.2026. backdrop-filter создаёт и stacking context, и
   * containing block для position:fixed, поэтому тултип внутри info:
   *  • обрезался по границам info (высота ~28px) — «рамка режет тултип»;
   *  • не мог всплыть над рамкой плитки никаким z-index — контекст замкнут.
   * Ни z-index, ни fixed внутри info не помогают (обе версии проверены на
   * живой странице). Единственное надёжное решение — рисовать в body.
   *
   * Тултип возвращается к кнопке в hideTooltip: пока он в body, обход
   * `.stats-button .tooltip` (обновление содержимого) его не найдёт, а
   * removeStatisticsElements удаляет по классу и заберёт его из body тоже.
   */
  private showTooltip(tooltip: HTMLElement, anchor: HTMLElement): void {
    if (tooltip.parentElement !== document.body) {
      tooltip.dataset.pnShown = "1";
      document.body.appendChild(tooltip);
      // Реестр активных порталов: если сайт удалит плитку до mouseleave,
      // страховочный проход снимет осиротевший тултип (аудит 01.08.2026,
      // находка 12) — иначе он удерживал бы отсоединённое поддерево плитки.
      this.portaledTooltips.add(tooltip);
    }
    // ПОРЯДОК ВАЖЕН: сначала ставим геометрию (ещё невидимым), и только
    // потом показываем. Обратный порядок давал вспышку у левого края экрана
    // — тултип успевал отрисоваться по старым координатам (регрессия 8.1.55).
    tooltip.style.position = "fixed";
    tooltip.style.transform = "none";
    tooltip.style.zIndex = "2147483000";
    tooltip.style.bottom = "auto";
    tooltip.style.right = "auto";

    const a = anchor.getBoundingClientRect();
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    // Над кнопкой; не влезает — под неё. По горизонтали держим в окне.
    let top = a.top - h - 8;
    if (top < 4) top = Math.min(a.bottom + 8, window.innerHeight - h - 4);
    const left = Math.min(Math.max(4, a.left), Math.max(4, window.innerWidth - w - 4));
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.left = `${Math.round(left)}px`;

    tooltip.style.visibility = "visible";
    tooltip.style.opacity = "1";
  }

  /** Спрятать тултип и вернуть его к кнопке (см. showTooltip). */
  private hideTooltip(tooltip: HTMLElement): void {
    tooltip.style.visibility = "hidden";
    tooltip.style.opacity = "0";
    delete tooltip.dataset.pnShown;
    this.portaledTooltips.delete(tooltip);
    const anchor = this.tooltipAnchors.get(tooltip);
    if (anchor?.isConnected && tooltip.parentElement === document.body) {
      anchor.appendChild(tooltip);
      // Возвращаем «родные» стили: элемент снова живёт внутри кнопки.
      tooltip.style.position = "absolute";
      tooltip.style.top = "auto";
      tooltip.style.left = "0";
      tooltip.style.bottom = "100%";
      // transform больше не анимируется (см. TOOLTIP_CSS) — сбрасываем в none,
      // иначе вернувшийся тултип был бы смещён на 10px при следующем показе.
      tooltip.style.transform = "none";
      tooltip.style.zIndex = "1001";
    } else if (tooltip.parentElement === document.body) {
      // Кнопка исчезла (плитка пересобрана) — не оставляем сироту в body.
      tooltip.remove();
    }
  }

  // ─────────── Кнопки ───────────

  private createStatsButton(username: string): HTMLDivElement | null {
    if (this.settings.statistics_enabled === false) return null;

    const themeColor = this.getStatsThemeColor();
    const statsButton = document.createElement("div");
    statsButton.className = OWN.statsButton;
    statsButton.dataset.username = username;
    statsButton.style.cssText = BUTTON_CIRCLE_CSS;

    statsButton.addEventListener("click", async (e) => {
      e.stopPropagation();
      const stats = this.playerStats.get(username.toLowerCase());
      if (stats && !stats.ratingUnavailable && stats.id) {
        window.open(`https://polemicagame.com/profile/${stats.id}`, "_blank");
        return;
      }
      try {
        const player = await findRatingPlayer(username);
        if (player) {
          window.open(`https://polemicagame.com/profile/${player.user_id}`, "_blank");
        } else {
          window.alert("Профиль не найден: нет данных рейтинга в топ-1000.");
        }
      } catch (err) {
        log.error("player-notes", "loading player ID failed", err);
        window.alert("Не удалось загрузить рейтинг. Попробуйте ещё раз позже.");
      }
    });

    statsButton.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${themeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 3v18h18" />
        <path d="M18 9l-5 5-2-2-4 4" />
        <path d="M18 9h-6" />
        <path d="M18 9v6" />
      </svg>
    `;

    const tooltip = this.createTooltip(username);
    statsButton.appendChild(tooltip);
    this.tooltipAnchors.set(tooltip, statsButton);

    statsButton.addEventListener("mouseenter", () => {
      void this.loadPlayerStats(username);
      const svg = statsButton.querySelector<SVGElement>("svg");
      if (svg) svg.style.stroke = themeColor;
      this.showTooltip(tooltip, statsButton);
    });
    statsButton.addEventListener("mouseleave", () => {
      const svg = statsButton.querySelector<SVGElement>("svg");
      if (svg) svg.style.stroke = themeColor;
      this.hideTooltip(tooltip);
    });

    this.applyButtonTheme(statsButton);
    return statsButton;
  }

  private createNoteButton(username: string): HTMLButtonElement {
    const noteButton = document.createElement("button");
    noteButton.className = OWN.noteButton;
    noteButton.dataset.username = username;
    noteButton.title = `Заметка для игрока ${username}`;
    noteButton.style.cssText = BUTTON_PLAIN_CSS;
    noteButton.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
        <path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8 12L16 12M8 8L16 8M8 16L13 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    noteButton.addEventListener("click", () => this.showNoteModal(username));
    this.applyButtonTheme(noteButton);
    this.updateNoteIndicator(noteButton, username);
    return noteButton;
  }

  /** Кнопка переворота камеры игрока (один клик, без режима). */
  private createRotateButton(username: string, container: Element): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = OWN.rotateButton;
    btn.dataset.username = username;
    btn.title = "Повернуть камеру на 180°";
    btn.style.cssText = BUTTON_PLAIN_CSS;
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M21 3v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    const sync = () => {
      this.syncRotateButton(btn, container);
    };
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const flipped = toggleFlipForPlayer(container as HTMLElement);
      // Запоминаем НАМЕРЕНИЕ игрока: сайт пересоздаёт video на каждой смене
      // фазы, и ensureFlipState вернёт переворот сам (просьба владельца).
      if (flipped !== null) {
        const uname = username.toLowerCase();
        if (flipped) this.flippedPlayers.add(uname);
        else this.flippedPlayers.delete(uname);
        this.persistFlippedPlayers();
      }
      sync();
    });
    this.applyButtonTheme(btn);
    sync();
    return btn;
  }

  private syncRotateButton(button: HTMLElement, container: Element): void {
    const opacity = isPlayerFlipped(container as HTMLElement) ? "1" : "0.7";
    if (button.style.opacity !== opacity) button.style.opacity = opacity;
  }

  private loadFlippedPlayers(): void {
    try {
      // Разбор и cap — в parseFlippedPlayers (источник недоверенный).
      this.flippedPlayers = parseFlippedPlayers(sessionStorage.getItem(FLIPPED_PLAYERS_KEY));
    } catch {
      /* sessionStorage недоступен (приватный режим) — начинаем с пустого */
    }
  }

  private persistFlippedPlayers(): void {
    try {
      sessionStorage.setItem(FLIPPED_PLAYERS_KEY, JSON.stringify([...this.flippedPlayers]));
    } catch {
      /* квота/приватный режим — потеряем только память о перевороте */
    }
  }

  /**
   * Восстановить переворот камеры после того, как сайт пересоздал video
   * (смена дня/ночи, переподключение камеры). Идемпотентно: у перевёрнутого
   * video стоит dataset.flipped, и повторного захода не будет; у свежего
   * элемента флага нет — переворачиваем один раз.
   */
  private ensureFlipState(container: Element, username: string): void {
    if (this.settings.camera_rotate_enabled === false) return;
    if (!this.flippedPlayers.has(username.toLowerCase())) return;
    const el = container as HTMLElement;
    if (isPlayerFlipped(el)) return;
    const video = el.querySelector<HTMLVideoElement>(SITE.playerVideoEl);
    // ended-гард: мёртвый поток переворачивать бессмысленно — ждём, пока сайт
    // заменит video (при canvas-реализации без гарда тут был бы цикл
    // пересоздания; с CSS-переворотом он просто лишняя работа).
    if (!video || video.ended) return;
    if (toggleFlipForPlayer(el)) {
      const btn = el.querySelector<HTMLElement>(`.${OWN.rotateButton}`);
      if (btn) this.syncRotateButton(btn, el);
      log.debug("player-notes", "flip restored", username);
    }
  }

  /** Добавить/убрать кнопку переворота в зависимости от настройки camera_rotate_enabled. */
  private ensureRotateButton(iconsGroup: Element, container: Element, username: string): void {
    const existing = iconsGroup.querySelector(`.${OWN.rotateButton}`);
    if (this.settings.camera_rotate_enabled) {
      if (!existing) iconsGroup.appendChild(this.createRotateButton(username, container));
      else this.syncRotateButton(existing as HTMLElement, container);
    } else if (existing) {
      existing.remove();
    }
  }

  /** Жёлтая точка на кнопке заметки, если у игрока есть заметка. */
  private updateNoteIndicator(button: HTMLElement, username: string): void {
    // Гейт настройкой ЗДЕСЬ, а не у вызывающих: путей к точке несколько
    // (проход DOM, live-обновление заметок, профиль), и гейт в одном месте
    // гарантирует, что выключение снимает УЖЕ стоящие точки первым же
    // обновлением (has=false ведёт в ветку удаления).
    const has =
      this.settings.note_indicator_enabled !== false && !!this.getNoteText(username);
    button.style.position = "relative";
    let dot = button.querySelector<HTMLElement>(".pn-note-dot");
    if (has && !dot) {
      dot = document.createElement("span");
      dot.className = "pn-note-dot";
      dot.style.cssText =
        "position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;" +
        "background:#f59e0b;box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none;";
      button.appendChild(dot);
    } else if (!has && dot) {
      dot.remove();
    }
  }

  /** Короткое уведомление поверх страницы (ошибки сохранения — не в лог, а глазам). */
  private toast(text: string, isError = false): void {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;" +
      `background:${isError ? "rgba(190,40,40,.95)" : "rgba(30,32,40,.95)"};color:#fff;` +
      "padding:8px 16px;border-radius:10px;font:13px system-ui,sans-serif;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.45);pointer-events:none;";
    document.body.appendChild(el);
    // Реестр, а не intervals: disable() гасит таймеры через clearInterval, и
    // плашка, не успевшая исчезнуть, оставалась на странице навсегда.
    this.toasts.add(el);
    window.setTimeout(() => {
      el.remove();
      this.toasts.delete(el);
    }, 4000);
  }

  /** Снять портальные тултипы, чей якорь сайт уже удалил из DOM. */
  private sweepOrphanTooltips(): void {
    for (const tooltip of [...this.portaledTooltips]) {
      const anchor = this.tooltipAnchors.get(tooltip);
      if (!anchor?.isConnected || !tooltip.isConnected) {
        tooltip.remove();
        this.portaledTooltips.delete(tooltip);
      }
    }
  }

  /** Обновить индикаторы у всех видимых кнопок заметок. */
  private refreshNoteIndicators(): void {
    document
      .querySelectorAll<HTMLElement>(`.${OWN.noteButton}[data-username]`)
      .forEach((btn) => {
        const u = btn.dataset.username;
        if (u) this.updateNoteIndicator(btn, u);
      });
    // Профиль: после сохранения из модалки обновить точку/цвет/рамку сразу
    // (DOM-проход дошёл бы и сам, но с задержкой дросселя). Вне /profile/ —
    // мгновенный no-op по regex внутри.
    this.ensureProfileNoteUI();
  }

  private createHideVideoButton(
    username: string,
    playerContainer: Element,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = OWN.hideVideoButton;
    button.dataset.username = username;
    button.title = `Скрыть/показать камеру ${username}`;
    button.style.cssText = BUTTON_PLAIN_CSS;
    button.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
        <path d="M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    button.addEventListener("click", () => {
      const uname = username.toLowerCase();
      const videoEl = playerContainer.querySelector<HTMLElement>(SITE.playerVideo);
      if (!videoEl) return;
      if (this.hiddenVideos.has(uname)) {
        videoEl.style.display = "";
        delete videoEl.dataset.polemicaHidden;
        this.hiddenVideos.delete(uname);
      } else {
        videoEl.style.display = "none";
        videoEl.dataset.polemicaHidden = "true";
        this.hiddenVideos.add(uname);
      }
      this.syncHideVideoButton(button, username);
    });
    this.applyButtonTheme(button);
    this.syncHideVideoButton(button, username);
    return button;
  }

  private syncHideVideoButton(button: HTMLElement, username: string): void {
    const opacity = this.hiddenVideos.has(username.toLowerCase()) ? "1" : "0.7";
    if (button.style.opacity !== opacity) button.style.opacity = opacity;
  }

  /** Кнопка локального мьюта: глушит звук игрока только у нас, помнит между играми. */
  private createMuteButton(username: string, container: Element): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = OWN.muteButton;
    btn.dataset.username = username;
    btn.style.cssText = BUTTON_PLAIN_CSS;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const uname = username.toLowerCase();
      if (this.mutedPlayers.has(uname)) {
        this.mutedPlayers.delete(uname);
        this.unmutedThisSession.add(uname);
      } else {
        this.mutedPlayers.add(uname);
        this.unmutedThisSession.delete(uname);
      }
      this.persistMutedPlayers();
      this.applyMuteState(container, username);
      this.syncMuteButton(btn, username);
    });
    this.syncMuteButton(btn, username);
    return btn;
  }

  /**
   * Иконка обязана читаться с одного взгляда (просьба владельца): состояние
   * кодируем ФОРМОЙ (динамик против перечёркнутого) и цветом (красный).
   * innerHTML трогаем только при реальной смене состояния — кнопки живут в
   * refresh-цикле onDomChange (инвариант AGENTS.md §4 п.1).
   */
  private syncMuteButton(button: HTMLElement, username: string): void {
    const muted = this.mutedPlayers.has(username.toLowerCase());
    const state = muted ? "muted" : "live";
    if (button.dataset.pnMuteState === state) return;
    button.dataset.pnMuteState = state;
    button.title = muted
      ? `Включить звук ${username}`
      : `Выключить звук ${username} у себя (запомнится на следующие игры)`;
    button.innerHTML = muted
      ? `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#ef4444;">
        <path d="M11 5L6 9H2v6h4l5 4V5z" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M22 9l-6 6M16 9l6 6" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/>
      </svg>`
      : `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
        <path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
    if (muted) {
      // Красный не перекрашиваем темой (гейт в applyButtonTheme).
      button.style.opacity = "1";
    } else {
      button.style.opacity = "0.7";
      this.applyButtonTheme(button);
    }
  }

  /**
   * Применить/снять мьют на ВСЕХ media-элементах плитки игрока (не «на video» —
   * см. комментарий внутри). Идемпотентно: пишем только при отличии.
   * dataset.pnMuted отмечает, что нулевую громкость поставили МЫ — без метки
   * снятие мьюта трогало бы громкость, которую пользователь выкрутил в ноль
   * сам средствами сайта.
   */
  private applyMuteState(container: Element, username: string): void {
    // ВСЕ media-элементы плитки, а не video.player__video: при включённом
    // useAudioAmplification (дефолт сайта) video чужого игрока hard-muted
    // всегда, а звук идёт через ОТДЕЛЬНЫЙ <audio ref="audioOutput"> без
    // класса (room-бандл, сверено 27.07.2026). Мьют только по video был
    // плацебо — иконка краснела, игрок продолжал звучать.
    const media = container.querySelectorAll<HTMLMediaElement>("video, audio");
    if (media.length === 0) return;
    // Выключенная настройка ведёт себя как «никто не замьючен»: звук
    // возвращается живьём, список в storage при этом не трогаем.
    const muteActive = this.settings.player_mute_enabled !== false;
    const wantMute = muteActive && this.mutedPlayers.has(username.toLowerCase());
    media.forEach((el) => {
      if (wantMute) {
        if (el.volume !== 0) el.volume = 0;
        if (el.dataset.pnMuted !== "true") el.dataset.pnMuted = "true";
      } else if (el.dataset.pnMuted === "true") {
        if (el.volume === 0) el.volume = 1;
        delete el.dataset.pnMuted;
      }
    });
  }

  /** Добавить/убрать кнопку мьюта по настройке player_mute_enabled. */
  private ensureMuteButton(iconsGroup: Element, container: Element, username: string): void {
    const existing = iconsGroup.querySelector<HTMLElement>(`.${OWN.muteButton}`);
    if (this.settings.player_mute_enabled !== false) {
      if (!existing) iconsGroup.appendChild(this.createMuteButton(username, container));
      else this.syncMuteButton(existing, username);
    } else if (existing) {
      existing.remove();
    }
  }

  private createLastGamesButton(username: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = OWN.lastGamesButton;
    button.dataset.username = username;
    button.style.cssText = BUTTON_PLAIN_CSS;
    button.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
        <path d="M12 8V12L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;

    const tooltip = document.createElement("div");
    tooltip.className = OWN.tooltip;
    tooltip.style.cssText = TOOLTIP_CSS;

    let intent: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      const games = await this.getLastGames(username);
      // Курсор мог уйти до ответа — скрытый тултип не трогаем (запись DOM
      // будила бы наблюдатель вхолостую); следующий hover перерисует сам.
      if (tooltip.dataset.pnShown !== "1") return;
      tooltip.innerHTML =
        games === null
          ? "Не удалось загрузить историю игр"
          : games.length > 0
            ? this.formatGamesHistory(games)
            : "Нет данных о последних играх";
      // Содержимое сменилось — размер тоже, пересчитываем позицию.
      this.showTooltip(tooltip, button);
    };

    button.addEventListener("mouseenter", () => {
      tooltip.innerHTML = "Загрузка...";
      this.showTooltip(tooltip, button);
      // Задержка намерения — ТОЛЬКО когда включён «ПУ»: с ним окно стоит
      // разбора каждого матча, и курсор, мазнувший по столу, поднимал бы
      // девять запросов на игрока. Без «ПУ» окно дешёвое (один запрос), и
      // ждать незачем — оно открывается сразу, как раньше.
      if (this.settings.last_games_first_killed === false) {
        void load();
        return;
      }
      intent = setTimeout(() => {
        intent = null;
        void load();
      }, HOVER_INTENT_MS);
    });
    button.addEventListener("mouseleave", () => {
      if (intent) {
        clearTimeout(intent);
        intent = null;
      }
      this.hideTooltip(tooltip);
    });

    button.appendChild(tooltip);
    this.tooltipAnchors.set(tooltip, button);
    this.applyButtonTheme(button);
    return button;
  }

  // ─────────── Модалка заметок ───────────

  private showNoteModal(username: string): void {
    // Оверлей (затемнение + клик мимо окна закрывает). Класс нужен для очистки в disable().
    const overlay = document.createElement("div");
    overlay.className = "polemica-note-modal";
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(0, 0, 0, 0.5);
      display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement("div");
    /**
     * max-height + overflow ОБЯЗАТЕЛЬНЫ. С 8.1.49 в окне две строки палитры
     * (метка и цвет ника), и на невысоком экране кнопки «Сохранить» уезжали
     * за нижний край без всякой возможности доскроллить: со стороны это
     * выглядело как «кнопки сохранения нет вообще» (жалоба 29.07.2026).
     */
    modal.style.cssText = `
      background: rgba(11, 27, 57, 0.97);
      padding: 20px; border-radius: 8px; min-width: 320px; max-width: 90vw;
      max-height: 90vh; overflow-y: auto;
      border: 1px solid rgba(79, 129, 245, 0.3);
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
    `;

    const title = document.createElement("h3");
    title.textContent = `Заметка для игрока ${username}`;
    title.style.cssText = "margin: 0 0 15px 0; color: white; font-size: 16px;";

    // Прежние ники: заметка живёт на вечном id, а человек мог переименоваться
    // — без этой строки узнать его было бы не по чему.
    const formerNicks = this.getFormerNicks(username);
    const former = document.createElement("div");
    if (formerNicks.length > 0) {
      former.textContent = `Раньше играл как: ${formerNicks.join(", ")}`;
      former.style.cssText =
        "margin: -8px 0 12px 0; color: rgba(255,255,255,.65); font-size: 12px;";
    }

    const textarea = document.createElement("textarea");
    textarea.value = this.getNoteText(username);
    textarea.style.cssText = `
      width: 100%;
      min-height: 100px;
      margin-bottom: 15px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      color: white;
      padding: 8px;
      resize: vertical;
      box-sizing: border-box;
    `;

    // ── выбор цветной метки и цвета ника (общая палитра) ──
    let selectedTag = this.getNoteTag(username);
    // Цвет читаем сырым (мимо nick_colors_enabled): в диалоге видно и
    // редактируется то, что реально лежит в записи.
    let selectedNickColor = this.getRawNickColor(username);

    const mkLabel = (text: string): HTMLDivElement => {
      const label = document.createElement("div");
      label.textContent = text;
      label.style.cssText = "color: rgba(255,255,255,.7); font-size: 12px; margin-bottom: 6px;";
      return label;
    };
    const tagLabel = mkLabel("Метка (рамка плитки)");
    const nickColorLabel = mkLabel("Цвет ника");

    // Обе строки делят одну палитру (пресеты + свои цвета): удаление своего
    // цвета ПКМ обязано перерисовать обе, поэтому rebuild-ы собраны в список.
    const paletteRebuilds: Array<() => void> = [];
    const rebuildAll = () => paletteRebuilds.forEach((r) => r());

    const makePaletteRow = (
      getSel: () => string,
      setSel: (css: string) => void,
    ): HTMLDivElement => {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; gap: 8px; margin-bottom: 15px; flex-wrap: wrap;";

      const makeSwatch = (css: string, name: string, custom: boolean): HTMLButtonElement => {
        const sw = document.createElement("button");
        sw.dataset.css = css;
        sw.title = custom ? `${name} (ПКМ — удалить)` : name;
        sw.style.cssText = `
          width: 24px; height: 24px; border-radius: 50%; cursor: pointer; padding: 0;
          border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto;
          background: ${css || "transparent"};
          outline: ${css === getSel() ? "2px solid #fff" : "2px solid transparent"};
          outline-offset: 2px; display: flex; align-items: center; justify-content: center;
        `;
        if (!css) {
          sw.textContent = "✕"; // «нет»
          sw.style.color = "rgba(255,255,255,.6)";
        }
        sw.addEventListener("click", () => {
          setSel(css);
          rebuildAll();
        });
        if (custom) {
          sw.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            // Подтверждение обязательно: ПКМ легко нажать случайно, а свой
            // цвет потом не восстановить — его нет в пресетах.
            if (!this.confirmRemoveCustomTag(css)) return;
            this.removeCustomTag(css);
            if (selectedTag === css) selectedTag = "";
            if (selectedNickColor === css) selectedNickColor = "";
            rebuildAll();
          });
        }
        return sw;
      };

      const rebuild = () => {
        row.replaceChildren();
        for (const { css, name } of TAG_PRESETS) row.appendChild(makeSwatch(css, name, false));
        for (const css of this.customTags) row.appendChild(makeSwatch(css, "свой цвет", true));

        /**
         * Кнопка «+» — выбрать свой цвет и сохранить в палитру.
         *
         * Инпут лежит ПОВЕРХ кнопки (прозрачный, во всю её площадь), клик
         * попадает прямо в него. Раньше кнопка звала `picker.click()` у
         * инпута размером 0×0 с pointer-events:none — Firefox считает такой
         * элемент невидимым и системную палитру для него не открывает:
         * кнопка нажималась, а окно выбора цвета не появлялось.
         */
        const wrap = document.createElement("span");
        wrap.style.cssText =
          "position: relative; width: 24px; height: 24px; flex: 0 0 auto; display: inline-block;";
        wrap.title = "Добавить свой цвет";

        const add = document.createElement("span");
        add.textContent = "+";
        add.style.cssText = `
          position: absolute; inset: 0; border-radius: 50%;
          border: 1px dashed rgba(255,255,255,.4); background: transparent; color: #fff;
          font-size: 15px; line-height: 1; display: grid; place-items: center;
          pointer-events: none;
        `;

        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = "#3b82f6";
        // Инпут кликабелен и «видим» для браузера (нулевой прозрачности, но
        // с реальными размерами) — рисует его собой лежащая под ним кнопка.
        picker.style.cssText = `
          position: absolute; inset: 0; width: 100%; height: 100%;
          opacity: 0; cursor: pointer; padding: 0; border: none; background: none;
        `;
        picker.addEventListener("change", () => {
          const c = picker.value;
          if (c && !this.customTags.includes(c) && !TAG_PRESETS.some((p) => p.css === c)) {
            this.customTags.push(c);
            this.removedTagsThisSession.delete(c);
            void this.saveCustomTags().then((ok) => {
              // Молчаливый провал записи оставлял цвет только в памяти: после
              // перезагрузки он исчезал (аудит безопасности, находка 8).
              if (!ok) this.toast("Не удалось сохранить цвет в палитру", true);
            });
          }
          setSel(c);
          rebuildAll();
        });
        wrap.append(add, picker);
        row.append(wrap);
      };
      paletteRebuilds.push(rebuild);
      rebuild();
      return row;
    };

    const tagRow = makePaletteRow(
      () => selectedTag,
      (css) => {
        selectedTag = css;
      },
    );
    const nickColorRow = makePaletteRow(
      () => selectedNickColor,
      (css) => {
        selectedNickColor = css;
      },
    );

    // ── общие действия ──
    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (this.closeOpenModal === close) this.closeOpenModal = null;
    };
    // disable() раньше сносил оверлей через remove() мимо close() — capture-слушатель
    // keydown оставался жить и продолжал глотать Escape и сохранять в отсоединённую форму.
    this.closeOpenModal?.();
    this.closeOpenModal = close;

    // Что пользователь РЕАЛЬНО видел при открытии: если за время набора текста
    // статистика резолвила id и под u:-ключом появилась/жила запись, которую
    // он не видел, — не даём слепо перезаписать или удалить её.
    // let: после успешного сохранения под новым ключом ОН становится
    // «виденным» — иначе повторные «Сохранить» в живущей модалке считали бы
    // собственную запись чужой (удаление/снятие метки молча не работали бы).
    let openedKey = this.noteKeyFor(username);

    /** true — заметка записана; false — запись не удалась, окно закрывать нельзя. */
    const save = (): Promise<boolean> => this.enqueueNotesWrite(async (): Promise<boolean> => {
      if (!isSafeNoteKey(username)) {
        log.warn("player-notes", "unsafe username, note not saved", redactNick(username));
        return false;
      }
      const value = textarea.value.trim();
      // Пишем по id-ключу, если статистика уже резолвила игрока: такая заметка
      // переживёт смену ника и не перепутает тёзок. Если id не резолвлен, но
      // модалка открылась на id-записи, найденной по нику (фолбэк noteKeyFor),
      // пишем в неё же — иначе рядом рождался дубль под ником, который при
      // миграции побеждал по времени и стирал цвет игрока.
      const id = this.noteUserId(username);
      const key =
        id !== undefined ? idKey(id) : isIdKey(openedKey) ? openedKey : username;
      // Снапшот ВСЕХ затрагиваемых ключей для отката (id + ник-варианты).
      const touched = new Map<string, NoteRecord | string | undefined>();
      touched.set(key, this.notes[key]);
      const staleNickKeys = id !== undefined ? this.nickKeysFor(username) : [];
      for (const nk of staleNickKeys) touched.set(nk, this.notes[nk]);

      const unseen = key !== openedKey ? this.notes[key] : undefined;
      if (value || selectedTag || selectedNickColor) {
        // Метка/цвет невидённой записи сохраняются, если пользователь свои не ставил.
        const unseenTag = unseen && typeof unseen !== "string" ? unseen.tag : undefined;
        const unseenColor = unseen && typeof unseen !== "string" ? unseen.nickColor : undefined;
        this.notes[key] = {
          text: value,
          timestamp: Date.now(),
          version: VERSION,
          tag: selectedTag || unseenTag || undefined,
          nickColor: selectedNickColor || unseenColor || undefined,
          // nick обязателен у ЛЮБОЙ id-записи (в т.ч. при записи в openedKey
          // без резолвленного id) — по нему работает фолбэк-поиск.
          ...(isIdKey(key) ? withNickHistory(this.notes[key], username) : {}),
        };
      } else if (unseen === undefined) {
        delete this.notes[key];
      }
      // else: пустое сохранение удаляет только то, что пользователь ВИДЕЛ
      // (ник-ключи ниже); невидённая u:-запись переживает.

      // Запись по id-ключу поглощает легаси-ники этого игрока.
      for (const nk of staleNickKeys) delete this.notes[nk];

      if (!(await this.saveNotes([key, ...staleNickKeys]))) {
        // Откатываем память под состояние хранилища, иначе интерфейс будет
        // показывать заметку, которой на диске нет.
        for (const [k, v] of touched) {
          if (v === undefined) delete this.notes[k];
          else this.notes[k] = v;
        }
        return false;
      }
      // Обе плитки игрока (десктоп/мобайл) + открытый тултип в портале.
      this.updatePlayerTooltips(username);
      this.refreshNoteIndicators();
      this.refreshPlayerTags();
      this.refreshNickColors();
      // Сохранённый ключ теперь «виден» пользователю — следующие сохранения
      // в этой же модалке работают с ним как со своим.
      openedKey = key;
      return true;
    });

    // ── кнопки ──
    const mkBtn = (text: string, bg: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = `
        padding: 8px 16px; color: white; border: none; border-radius: 8px;
        cursor: pointer; font-size: 13px; background: ${bg};
      `;
      return b;
    };
    const saveBtn = mkBtn("Сохранить", "rgba(99, 102, 241, 0.3)");
    const saveCloseBtn = mkBtn("Сохранить и закрыть", "rgba(99, 102, 241, 0.6)");
    const closeBtn = mkBtn("Закрыть", "rgba(255, 255, 255, 0.12)");

    let savedHint: ReturnType<typeof setTimeout> | null = null;
    /** Фидбек по РЕАЛЬНОМУ результату записи: раньше «Сохранено ✓» рисовалось всегда. */
    const showResult = (btn: HTMLButtonElement, ok: boolean, label: string, bg: string) => {
      btn.textContent = ok ? "Сохранено ✓" : "Не сохранено!";
      btn.style.background = ok ? bg : "rgba(239, 68, 68, 0.7)";
      if (savedHint) clearTimeout(savedHint);
      savedHint = setTimeout(
        () => {
          btn.textContent = label;
          btn.style.background = bg;
        },
        ok ? 1200 : 4000,
      );
    };
    saveBtn.addEventListener("click", () => {
      void save().then((ok) =>
        showResult(saveBtn, ok, "Сохранить", "rgba(99, 102, 241, 0.3)"),
      );
    });
    saveCloseBtn.addEventListener("click", () => {
      // При неудачной записи окно НЕ закрываем — иначе текст заметки пропадёт.
      void save().then((ok) => {
        if (ok) close();
        else showResult(saveCloseBtn, false, "Сохранить и закрыть", "rgba(99, 102, 241, 0.6)");
      });
    });
    closeBtn.addEventListener("click", close);

    const buttons = document.createElement("div");
    // sticky: кнопки видны всегда, даже когда содержимое окна прокручивается.
    // bottom: -20px компенсирует padding модалки, чтобы полоса кнопок липла
    // ровно к её нижнему краю.
    buttons.style.cssText = `
      display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
      position: sticky; bottom: -20px; padding: 12px 0 0;
      background: rgba(11, 27, 57, 0.97);
    `;
    buttons.append(closeBtn, saveBtn, saveCloseBtn);

    // ── закрытие по Esc / Ctrl+Enter сохранить-и-закрыть / клик мимо окна ──
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void save().then((ok) => {
          if (ok) close();
        });
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });

    modal.append(title, former, textarea, tagLabel, tagRow, nickColorLabel, nickColorRow, buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Фокус в поле, курсор в конец текста.
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  // ─────────── Менеджер цветов ников ───────────

  /**
   * Записать цвет ника в запись заметки (или снять его). Пустой цвет у записи
   * без текста и метки удаляет запись целиком — не копим пустышки.
   *
   * @param createNick передан — записи можно НЕ существовать: она создаётся
   *   пустой с этим ником (ручное добавление игрока в менеджере).
   */
  private setNickColor(key: string, color: string, createNick?: string): Promise<boolean> {
    return this.enqueueNotesWrite(async (): Promise<boolean> => {
      const prev = this.notes[key];
      if (prev === undefined) {
        // Без createNick несуществующий ключ — гонка с удалением в другой
        // вкладке: молча выходим, воскрешать запись нельзя.
        if (!color || createNick === undefined) return true;
        if (!isSafeNoteKey(key)) return false;
        this.notes[key] = {
          text: "",
          timestamp: Date.now(),
          version: VERSION,
          nickColor: color,
          // Ник храним только у id-ключей (у ник-ключей он и есть ключ).
          ...(isIdKey(key) ? withNickHistory(this.notes[key], createNick) : {}),
        };
      } else if (typeof prev === "string") {
        // Легаси-строка: повышаем до записи, текст сохраняем.
        if (!color) return true;
        this.notes[key] = { text: prev, timestamp: Date.now(), version: VERSION, nickColor: color };
      } else {
        const next: NoteRecord = { ...prev, timestamp: Date.now(), nickColor: color || undefined };
        if (!color && !next.text && !next.tag) delete this.notes[key];
        else this.notes[key] = next;
      }
      if (!(await this.saveNotes([key]))) {
        // Откат памяти под состояние диска.
        if (prev === undefined) delete this.notes[key];
        else this.notes[key] = prev;
        return false;
      }
      this.refreshNickColors();
      this.refreshNoteIndicators();
      return true;
    });
  }

  /**
   * Резолв ручного ввода «ник или id» в ключ записи.
   *  • Цифры → это id: ник подтверждаем страницей профиля (там username в
   *    данных Vue-компонента); несуществующий id отклоняем — иначе копили бы
   *    мусорные записи, которые никогда ни к кому не привяжутся.
   *  • Ник → сначала ищем среди СВОИХ записей (u:-ключ с этим ником), потом в
   *    рейтинге (топ-1000); не нашёлся — ключ-ник, мигрирует на id при первой
   *    встрече игрока в игре (штатная механика заметок).
   */
  private async resolvePlayerInput(
    input: string,
  ): Promise<{ key: string; nick: string; id?: string } | null> {
    const raw = input.trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
      try {
        const resp = await fetch(`https://polemicagame.com/profile/${raw}`);
        if (!resp.ok) return null;
        const text = await resp.text();
        // СТРОГО атрибут :profile-user. Первое попавшееся "username" на
        // странице — это :current-user, то есть САМ пользователь (в браузере
        // запрос идёт с куками): поиск по любому id находил «себя».
        const m = text.match(/:profile-user='([^']+)'/);
        if (!m) return null;
        const decoded = m[1]
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&");
        let user: { id?: number | string; username?: string } | null = null;
        try {
          user = JSON.parse(m[1]);
        } catch {
          try {
            user = JSON.parse(decoded);
          } catch {
            return null;
          }
        }
        // id обязан совпасть с запрошенным — ник чужого объекта не берём.
        if (!user || String(user.id) !== raw || !user.username) return null;
        return { key: idKey(raw), nick: user.username, id: raw };
      } catch {
        return null;
      }
    }

    if (!isSafeNoteKey(raw)) return null;
    const lower = raw.toLowerCase();
    for (const [k, v] of Object.entries(this.notes)) {
      if (isIdKey(k) && typeof v !== "string" && v.nick?.toLowerCase() === lower) {
        return { key: k, nick: v.nick, id: k.slice(ID_KEY_PREFIX.length) };
      }
    }
    try {
      const player = await findRatingPlayer(raw);
      if (player) {
        return { key: idKey(player.user_id), nick: raw, id: String(player.user_id) };
      }
    } catch {
      /* рейтинг недоступен — фолбэк на ник-ключ ниже */
    }
    const existingNickKey = this.nickKeysFor(raw)[0];
    return { key: existingNickKey ?? raw, nick: raw };
  }

  /**
   * Спросить подтверждение на удаление своего цвета из палитры.
   * Отдельным методом — вопрос задаётся из двух мест (палитра в заметке и
   * менеджер), а формулировка должна быть одна: важно сказать, что записи
   * игроков при этом не меняются, иначе удаление выглядит опаснее, чем есть.
   */
  private confirmRemoveCustomTag(css: string): boolean {
    const used = Object.values(this.notes).filter(
      (rec) => typeof rec !== "string" && (rec.nickColor === css || rec.tag === css),
    ).length;
    const tail = used
      ? `\n\nИгроков с этим цветом: ${used}. Их цвет останется как есть — из палитры пропадёт только заготовка.`
      : "";
    return window.confirm(`Удалить свой цвет из палитры?${tail}`);
  }

  /** Убрать свой цвет из палитры (сама палитра — это customTags). */
  private removeCustomTag(css: string): void {
    this.customTags = this.customTags.filter((c) => c !== css);
    this.removedTagsThisSession.add(css);
    void this.saveCustomTags().then((ok) => {
      if (!ok) this.toast("Не удалось сохранить палитру — цвет вернётся после перезагрузки", true);
    });
  }

  /**
   * Записать текст заметки по ключу (правка из менеджера). Пустой текст у
   * записи без цвета и метки удаляет её целиком — не копим пустышки.
   */
  private setNoteTextFor(key: string, text: string, createNick?: string): Promise<boolean> {
    return this.enqueueNotesWrite(async (): Promise<boolean> => {
      const prev = this.notes[key];
      if (prev === undefined) {
        // Записи нет: создаём только при явном намерении (добавление игрока
        // через форму). Иначе это гонка с удалением в другой вкладке —
        // воскрешать запись нельзя.
        if (!text || createNick === undefined) return true;
        if (!isSafeNoteKey(key)) return false;
        this.notes[key] = {
          text,
          timestamp: Date.now(),
          version: VERSION,
          ...(isIdKey(key) ? { nick: createNick } : {}),
        };
        if (!(await this.saveNotes([key]))) {
          delete this.notes[key];
          return false;
        }
        this.refreshNoteIndicators();
        this.updateAllTooltips();
        return true;
      }
      const base: NoteRecord =
        typeof prev === "string" ? { text: prev, timestamp: Date.now(), version: VERSION } : prev;
      const next: NoteRecord = { ...base, text, timestamp: Date.now(), version: VERSION };
      if (!text && !next.tag && !next.nickColor) delete this.notes[key];
      else this.notes[key] = next;

      if (!(await this.saveNotes([key]))) {
        this.notes[key] = prev; // откат памяти под состояние диска
        return false;
      }
      this.refreshNoteIndicators();
      this.updateAllTooltips();
      return true;
    });
  }

  /** Удалить запись игрока целиком (и заметку, и цвет, и метку). */
  private deleteNoteEntry(key: string): Promise<boolean> {
    return this.enqueueNotesWrite(async (): Promise<boolean> => {
      const prev = this.notes[key];
      if (prev === undefined) return true;
      delete this.notes[key];
      if (!(await this.saveNotes([key]))) {
        this.notes[key] = prev;
        return false;
      }
      this.refreshNickColors();
      this.refreshNoteIndicators();
      this.refreshPlayerTags();
      this.updateAllTooltips();
      return true;
    });
  }

  /**
   * Все известные игроки: и с цветом ника, и просто с заметкой.
   * Раньше список показывал ТОЛЬКО цветных — заметки правились лишь на
   * плитке в игре, то есть до нужного игрока надо было ещё дожить.
   */
  private playerEntries(): Array<{
    key: string;
    nick: string;
    id: string;
    color: string;
    text: string;
  }> {
    return Object.entries(this.notes)
      .filter(([, rec]) => (typeof rec === "string" ? !!rec : !!(rec.nickColor || rec.text)))
      .map(([key, rec]) => ({
        key,
        nick:
          (typeof rec !== "string" && rec.nick) ||
          (isIdKey(key) ? `игрок ${key.slice(ID_KEY_PREFIX.length)}` : key),
        id: isIdKey(key) ? key.slice(ID_KEY_PREFIX.length) : "",
        color: typeof rec === "string" ? "" : rec.nickColor || "",
        text: typeof rec === "string" ? rec : rec.text || "",
      }))
      .sort((a, b) => a.nick.localeCompare(b.nick, "ru"));
  }

  /**
   * Диалог «Цвета ников»: все сохранённые цвета одним списком — ник, id,
   * цвет; смена цвета по палитре и удаление. Открывается из попапа.
   */
  openNickColorManager(): void {
    const overlay = document.createElement("div");
    overlay.className = "polemica-note-modal";
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,.6);
      z-index: 10001; display: flex; align-items: center; justify-content: center;
    `;
    const modal = document.createElement("div");
    modal.style.cssText = `
      background: rgba(11, 27, 57, 0.97);
      padding: 20px; border-radius: 8px; min-width: 340px; max-width: 90vw;
      max-height: 80vh; overflow-y: auto;
      border: 1px solid rgba(79, 129, 245, 0.3);
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
    `;

    const title = document.createElement("h3");
    title.textContent = "Заметки и цвета игроков";
    title.style.cssText = "margin: 0 0 12px 0; color: white; font-size: 16px;";

    // ── добавление игрока вручную (по нику или id) ──
    const addWrap = document.createElement("div");
    addWrap.style.cssText =
      "margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.12);";
    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex;gap:8px;";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "Ник или id игрока";
    addInput.style.cssText =
      "flex:1 1 auto;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);" +
      "border-radius:6px;color:#fff;padding:6px 10px;font-size:13px;min-width:0;";
    const addBtn = document.createElement("button");
    addBtn.textContent = "Найти";
    addBtn.style.cssText =
      "padding:6px 14px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
      "font-size:13px;background:rgba(99,102,241,.5);flex:0 0 auto;";
    addRow.append(addInput, addBtn);
    /** Превью найденного игрока + палитра для выбора его цвета. */
    const addResult = document.createElement("div");
    addWrap.append(addRow, addResult);

    const renderAddResult = (found: { key: string; nick: string; id?: string }) => {
      addResult.replaceChildren();
      const info = document.createElement("div");
      info.textContent = found.id
        ? `${found.nick} (id ${found.id}) — выберите цвет или напишите заметку:`
        : `${found.nick} — id не найден, запись привяжется к нику. Выберите цвет или напишите заметку:`;
      info.style.cssText = "color:rgba(255,255,255,.75);font-size:12px;margin:10px 0 6px;";
      const palette = document.createElement("div");
      palette.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
      const options = [
        ...TAG_PRESETS.filter((p) => p.css).map((p) => ({ css: p.css, name: p.name })),
        ...this.customTags.map((css) => ({ css, name: "свой цвет" })),
      ];
      for (const opt of options) {
        const sw = document.createElement("button");
        sw.title = opt.name;
        sw.style.cssText = `
          width: 22px; height: 22px; border-radius: 50%; cursor: pointer; padding: 0;
          border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto; background: ${opt.css};
        `;
        sw.addEventListener("click", () => {
          void this.setNickColor(found.key, opt.css, found.nick).then((ok) => {
            if (ok) {
              addInput.value = "";
              addResult.replaceChildren();
              flashSaved(found.key);
              render();
            } else showAddError("Не удалось сохранить — попробуй ещё раз.");
          });
        });
        palette.appendChild(sw);
      }

      // Заметка прямо здесь: игрока можно завести и без цвета — например,
      // записать «шумный, играет агрессивно» до первой встречи за столом.
      const area = document.createElement("textarea");
      area.placeholder = "Заметка (необязательно)";
      area.style.cssText = `
        width: 100%; min-height: 56px; box-sizing: border-box; resize: vertical;
        margin-top: 10px; background: rgba(255,255,255,.1);
        border: 1px solid rgba(255,255,255,.2); border-radius: 6px; color: #fff;
        padding: 7px; font: 13px/1.4 system-ui, sans-serif;
      `;
      area.addEventListener("keydown", (e) => e.stopPropagation());

      const saveNote = document.createElement("button");
      saveNote.textContent = "Сохранить заметку";
      saveNote.style.cssText =
        "margin-top:8px;padding:5px 12px;color:#fff;border:none;border-radius:6px;" +
        "cursor:pointer;font-size:12px;background:rgba(99,102,241,.6);float:right;";
      saveNote.addEventListener("click", () => {
        const text = area.value.trim();
        if (!text) {
          showAddError("Напишите текст заметки или выберите цвет.");
          return;
        }
        void this.setNoteTextFor(found.key, text, found.nick).then((ok) => {
          if (ok) {
            addInput.value = "";
            addResult.replaceChildren();
            flashSaved(found.key);
            render();
          } else showAddError("Не удалось сохранить — попробуйте ещё раз.");
        });
      });

      addResult.append(info, palette, area, saveNote);
    };

    const showAddError = (text: string) => {
      addResult.replaceChildren();
      const err = document.createElement("div");
      err.textContent = text;
      err.style.cssText = "color:#f87171;font-size:12px;margin-top:8px;";
      addResult.appendChild(err);
    };

    const doFind = () => {
      const value = addInput.value.trim();
      if (!value) return;
      addBtn.disabled = true;
      addBtn.textContent = "Ищу…";
      void this.resolvePlayerInput(value)
        .then((found) => {
          if (found) renderAddResult(found);
          else showAddError("Игрок не найден — проверь ник или id.");
        })
        .finally(() => {
          addBtn.disabled = false;
          addBtn.textContent = "Найти";
        });
    };
    addBtn.addEventListener("click", doFind);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doFind();
      }
      // Диалог живёт поверх страницы игры — хоткеи расширения не должны
      // срабатывать во время набора ника.
      e.stopPropagation();
    });

    const list = document.createElement("div");
    /** Ключ записи с раскрытой палитрой (одна за раз). */
    let expandedKey: string | null = null;
    /**
     * Ключ записи, которую только что сохранили: рядом с ней на пару секунд
     * появляется «Сохранено ✓». Кнопки «Сохранить» здесь нет намеренно —
     * запись уходит на диск сразу по клику, — но без подтверждения это
     * выглядело как «ничего не произошло», и владелец резонно спросил, где
     * же сохранение (жалоба 29.07.2026).
     */
    let savedKey: string | null = null;
    let savedTimer: ReturnType<typeof setTimeout> | null = null;
    const flashSaved = (key: string) => {
      savedKey = key;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => {
        savedKey = null;
        if (overlay.isConnected) render();
      }, 2000);
    };

    const render = () => {
      list.replaceChildren();
      const entries = this.playerEntries();
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.textContent =
          "Пока пусто. Добавьте игрока по нику или id выше — или напишите заметку прямо в игре (кнопка ✎ на плитке).";
        empty.style.cssText = "color: rgba(255,255,255,.6); font-size: 13px; padding: 8px 0;";
        list.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:7px 0;" +
          "border-bottom:1px solid rgba(255,255,255,.08);";

        const openColors = () => {
          expandedKey = expandedKey === `c:${entry.key}` ? null : `c:${entry.key}`;
          render();
        };
        const openNote = () => {
          expandedKey = expandedKey === `n:${entry.key}` ? null : `n:${entry.key}`;
          render();
        };

        const swatch = document.createElement("button");
        swatch.title = entry.color ? "Сменить цвет" : "Назначить цвет";
        swatch.style.cssText = `
          width: 20px; height: 20px; border-radius: 50%; cursor: pointer; padding: 0; flex: 0 0 auto;
          border: 1px ${entry.color ? "solid" : "dashed"} rgba(255,255,255,.35);
          background: ${entry.color || "transparent"};
        `;
        swatch.addEventListener("click", openColors);

        // Ник + превью заметки под ним: видно, кто это, не раскрывая строку.
        const who = document.createElement("div");
        who.style.cssText = "flex:1 1 auto;min-width:0;";
        const nick = document.createElement("div");
        nick.textContent = entry.nick;
        nick.style.cssText =
          "color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        who.appendChild(nick);
        if (entry.text) {
          const preview = document.createElement("div");
          preview.textContent = entry.text;
          preview.title = entry.text;
          preview.style.cssText =
            "color:rgba(255,255,255,.5);font-size:11px;margin-top:1px;" +
            "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          who.appendChild(preview);
        }

        const idEl = document.createElement("span");
        idEl.textContent = entry.id ? `id ${entry.id}` : "без id";
        idEl.title = entry.id
          ? "Запись привязана к аккаунту и переживёт смену ника"
          : "Игрок ещё не резолвился в id — запись привязана к нику";
        idEl.style.cssText = "color:rgba(255,255,255,.45);font-size:11px;flex:0 0 auto;";

        const noteBtn = document.createElement("button");
        noteBtn.textContent = entry.text ? "Заметка" : "+ заметка";
        noteBtn.style.cssText =
          "padding:4px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(99,102,241,.3);flex:0 0 auto;";
        noteBtn.addEventListener("click", openNote);

        const colorBtn = document.createElement("button");
        colorBtn.textContent = "Цвет";
        colorBtn.style.cssText =
          "padding:4px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(99,102,241,.3);flex:0 0 auto;";
        colorBtn.addEventListener("click", openColors);

        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "Удалить запись игрока целиком";
        del.style.cssText =
          "padding:4px 8px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(239,68,68,.35);flex:0 0 auto;";
        del.addEventListener("click", () => {
          // Подтверждение: удаляется и заметка тоже, а не только цвет.
          const what = entry.text ? "заметку и цвет" : "цвет";
          if (!window.confirm(`Удалить ${what} игрока ${entry.nick}?`)) return;
          void this.deleteNoteEntry(entry.key).then((ok) => {
            if (ok) {
              if (expandedKey?.endsWith(entry.key)) expandedKey = null;
              render();
            } else del.textContent = "ошибка";
          });
        });

        row.append(swatch, who, idEl);
        if (savedKey === entry.key) {
          const saved = document.createElement("span");
          saved.textContent = "Сохранено ✓";
          saved.style.cssText = "color:#22c55e;font-size:11px;flex:0 0 auto;";
          row.appendChild(saved);
        }
        row.append(noteBtn, colorBtn, del);
        list.appendChild(row);

        // ── раскрытая палитра ──
        if (expandedKey === `c:${entry.key}`) {
          const palette = document.createElement("div");
          palette.style.cssText =
            "display:flex;gap:8px;padding:8px 0 10px;flex-wrap:wrap;" +
            "border-bottom:1px solid rgba(255,255,255,.08);";
          const options = [
            { css: "", name: "без цвета" },
            ...TAG_PRESETS.filter((p) => p.css).map((p) => ({ css: p.css, name: p.name })),
            ...this.customTags.map((css) => ({ css, name: "свой цвет" })),
          ];
          for (const opt of options) {
            const sw = document.createElement("button");
            sw.title = opt.name;
            sw.style.cssText = `
              width: 22px; height: 22px; border-radius: 50%; cursor: pointer; padding: 0;
              border: 1px ${opt.css ? "solid" : "dashed"} rgba(255,255,255,.35); flex: 0 0 auto;
              background: ${opt.css || "transparent"}; color: rgba(255,255,255,.6);
              display: grid; place-items: center; font-size: 11px;
              outline: ${opt.css === entry.color ? "2px solid #fff" : "2px solid transparent"};
              outline-offset: 2px;
            `;
            if (!opt.css) sw.textContent = "✕";
            sw.addEventListener("click", () => {
              void this.setNickColor(entry.key, opt.css).then((ok) => {
                if (ok) {
                  expandedKey = null;
                  flashSaved(entry.key);
                  render();
                }
              });
            });
            palette.appendChild(sw);
          }
          list.appendChild(palette);
        }

        // ── раскрытый редактор заметки ──
        if (expandedKey === `n:${entry.key}`) {
          const editor = document.createElement("div");
          editor.style.cssText =
            "padding:8px 0 12px;border-bottom:1px solid rgba(255,255,255,.08);";
          const area = document.createElement("textarea");
          area.value = entry.text;
          area.placeholder = "Что важно помнить об этом игроке";
          area.style.cssText = `
            width: 100%; min-height: 70px; box-sizing: border-box; resize: vertical;
            background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
            border-radius: 6px; color: #fff; padding: 8px; font: 13px/1.4 system-ui, sans-serif;
          `;
          // Хоткеи расширения не должны срабатывать при наборе текста.
          area.addEventListener("keydown", (e) => e.stopPropagation());

          const bar = document.createElement("div");
          bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;";
          const cancel = document.createElement("button");
          cancel.textContent = "Отмена";
          cancel.style.cssText =
            "padding:5px 12px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
            "font-size:12px;background:rgba(255,255,255,.12);";
          cancel.addEventListener("click", () => {
            expandedKey = null;
            render();
          });
          const save = document.createElement("button");
          save.textContent = "Сохранить";
          save.style.cssText =
            "padding:5px 12px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
            "font-size:12px;background:rgba(99,102,241,.6);";
          const doSave = () => {
            void this.setNoteTextFor(entry.key, area.value.trim()).then((ok) => {
              if (ok) {
                expandedKey = null;
                flashSaved(entry.key);
                render();
              } else save.textContent = "не сохранилось";
            });
          };
          save.addEventListener("click", doSave);
          area.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              doSave();
            }
          });
          bar.append(cancel, save);
          editor.append(area, bar);
          list.appendChild(editor);
          area.focus();
          area.setSelectionRange(area.value.length, area.value.length);
        }
      }
    };
    render();

    /**
     * Блок «Мои цвета» — управление собственной палитрой.
     * Раньше свой цвет удалялся только правой кнопкой по кружку в диалоге
     * заметки: об этом знал лишь тот, кто читал подсказку, и делалось это
     * без подтверждения.
     */
    const myColors = document.createElement("div");
    myColors.style.cssText = "margin-top:14px;";
    const renderMyColors = () => {
      myColors.replaceChildren();
      if (this.customTags.length === 0) return;
      const label = document.createElement("div");
      label.textContent = "Мои цвета";
      label.style.cssText = "color:rgba(255,255,255,.7);font-size:12px;margin-bottom:6px;";
      const rowEl = document.createElement("div");
      rowEl.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;";
      for (const css of this.customTags) {
        const item = document.createElement("span");
        item.style.cssText = "position:relative;width:24px;height:24px;flex:0 0 auto;";
        const dot = document.createElement("span");
        dot.style.cssText = `
          position:absolute; inset:0; border-radius:50%; background:${css};
          border:1px solid rgba(255,255,255,.3);
        `;
        const kill = document.createElement("button");
        kill.textContent = "✕";
        kill.title = "Удалить этот цвет из палитры";
        kill.style.cssText = `
          position:absolute; top:-6px; right:-6px; width:16px; height:16px;
          border:none; border-radius:50%; cursor:pointer; padding:0;
          background:rgba(239,68,68,.9); color:#fff; font-size:10px; line-height:1;
          display:grid; place-items:center;
        `;
        kill.addEventListener("click", () => {
          if (!this.confirmRemoveCustomTag(css)) return;
          this.removeCustomTag(css);
          renderMyColors();
          // Раскрытая палитра игрока строится из тех же customTags —
          // перерисовываем список, иначе удалённый цвет ещё виден в ней.
          render();
        });
        item.append(dot, kill);
        rowEl.appendChild(item);
      }
      myColors.append(label, rowEl);
    };
    renderMyColors();

    const hint = document.createElement("div");
    hint.textContent =
      "Цвет применяется сразу; заметка — по кнопке «Сохранить» (или Ctrl+Enter). " +
      "То же самое можно делать прямо в игре — кнопка ✎ на плитке игрока.";
    hint.style.cssText = "color:rgba(255,255,255,.45);font-size:11px;margin:10px 0 12px;";

    const closeBtn = document.createElement("button");
    // «Готово», а не «Закрыть»: закрытие ничего не отменяет и не сохраняет —
    // всё уже на диске, кнопка просто убирает окно.
    closeBtn.textContent = "Готово";
    closeBtn.style.cssText =
      "padding:8px 16px;color:#fff;border:none;border-radius:8px;cursor:pointer;" +
      "font-size:13px;background:rgba(255,255,255,.12);display:block;margin-left:auto;";

    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (this.closeOpenModal === close) this.closeOpenModal = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    this.closeOpenModal?.();
    this.closeOpenModal = close;
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });

    modal.append(title, addWrap, list, myColors, hint, closeBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  /**
   * userId игрока по нику. Порядок источников — от бесплатного к дорогому:
   * уже загруженная статистика → заметка на вечном ключе (`u:<id>`) → запрос
   * рейтинга. Раньше единственным путём был последний, и после перехода
   * статистики на ленивую загрузку (9.0.0) наведение сразу на «Последние
   * игры» всегда упиралось в сеть, а адрес рейтинга к тому же был мёртв
   * (жалоба 01.08.2026: «Нет данных о последних играх»).
   *
   * Бросает, если id определить не удалось: честное «не удалось» лучше
   * пустого ответа, который читается как «у игрока ничего нет».
   */
  private async resolveUserId(username: string, key: string): Promise<number | string> {
    const stats = this.playerStats.get(key);
    if (stats && !stats.ratingUnavailable && stats.id) return stats.id;
    const fromNote = this.noteUserId(username);
    if (fromNote !== undefined) return fromNote;
    try {
      const player = await findRatingPlayer(username);
      if (!player) {
        log.warn("player-notes", `player ${redactNick(username)} not found in rating`);
        throw new Error("player id unresolved");
      }
      return player.user_id;
    } catch (err) {
      log.warn("player-notes", "player ID lookup failed", err);
      throw err;
    }
  }

  // ─────────── Статистика пересечений ───────────

  /**
   * Своя история игр. Тянется целиком (страницами) и переиспользуется всеми
   * кнопками за столом: она одна и та же, а весит несколько сотен строк.
   */
  private getMyHistory(myId: number | string): Promise<History | null> {
    if (this.myHistory && Date.now() - this.myHistoryAt < STATS_TTL_MS) {
      return Promise.resolve(this.myHistory);
    }
    // Дедупликация: прогрев и наведение мыши стартуют одновременно, а история
    // у завсегдатая — мегабайты. Второй такой запрос не нужен никому.
    if (this.myHistoryInFlight) return this.myHistoryInFlight;
    const inFlight = fetchHistory(myId)
      .then((history) => {
        if (history) {
          this.myHistory = history;
          this.myHistoryAt = Date.now();
        }
        return history;
      })
      .finally(() => {
        this.myHistoryInFlight = null;
      });
    this.myHistoryInFlight = inFlight;
    return inFlight;
  }

  /**
   * Отпустить свою историю: сводки посчитаны, строки больше не нужны.
   * Пересечения переживают её в кэше — там уже готовые числа.
   */
  private releaseMyHistory(): void {
    if (!this.myHistory || this.myHistoryInFlight) return;
    this.myHistory = null;
    this.myHistoryAt = 0;
  }

  /**
   * Прогрев пересечений — по ОДНОМУ игроку за проход.
   *
   * Зачем: первая сводка стоит двух историй, и ждать их, уже наведя курсор, —
   * это те самые «очень долго в первый раз». Ночью игроку не до кнопок, зато
   * у расширения есть время: к утру сводки готовы и открываются мгновенно
   * (идея владельца 13.08.2026).
   *
   * Почему по одному и без своего таймера: страховочный проход уже тикает раз
   * в две секунды, и этого ритма хватает, чтобы прогреть стол за ночь. Залп из
   * десяти историй разом был бы и грубее к серверу, и медленнее для того
   * единственного игрока, на которого сейчас смотрят.
   */
  private pumpCrossoverWarm(names: string[]): void {
    if (this.settings.btn_crossover_enabled === false) return;
    const mine = ownNameFromTable()?.toLowerCase();
    const pending = names.filter((name) => {
      const key = name.toLowerCase();
      // Себя пропускаем: «пересечения с собой» — это просто все свои игры.
      return key !== "" && key !== mine && !this.crossoverCache.has(key);
    });
    if (pending.length === 0) {
      // Стол прогрет целиком — держать историю больше незачем.
      if (names.length > 0) this.releaseMyHistory();
      return;
    }
    // Прогрев начинается с первой НОЧИ: днём игрок говорит и смотрит на стол,
    // и фоновые запросы ему ни к чему.
    if (this.warmStopped || this.warmBusy || !isNightNow()) return;
    this.warmBusy = true;
    void this.getCrossover(pending[0])
      .then((data) => {
        if (data === undefined) {
          this.warmStopped = true;
          log.info("player-notes", "прогрев пересечений отключён: свой профиль не определился");
        }
      })
      .finally(() => {
        this.warmBusy = false;
      });
  }

  /**
   * Пересечение с игроком: сколько сыграно вместе и кем он в этих играх был.
   *
   * `undefined` — свой id неизвестен (в комнате шапки сайта нет, а на обычные
   * страницы игрок ещё не заходил): это НЕ ошибка сети и говорить о ней надо
   * иначе. `null` — не удалось загрузить историю; пустая сводка читалась бы
   * как «вы никогда не играли вместе», а это другое утверждение.
   */
  private getCrossover(username: string): Promise<Crossover | null | undefined> {
    const key = username.toLowerCase();
    const hit = this.crossoverCache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.data);
    const inFlight = this.crossoverInFlight.get(key);
    if (inFlight) return inFlight;
    // Промис кладётся в реестр СИНХРОННО, до первого await. Раньше метод
    // успевал сходить за своим id между проверкой реестра и записью в него, и
    // два наведения подряд заводили каждое свою пару историй (замечание
    // владельца 13.08.2026). Повторное наведение обязано ЖДАТЬ первый запрос,
    // а новый запускать только если тот провалился — за это отвечает кэш
    // неудачи с коротким TTL.
    const promise = this.loadCrossover(username, key).finally(() => {
      this.crossoverInFlight.delete(key);
    });
    this.crossoverInFlight.set(key, promise);
    return promise;
  }

  /** Собственно загрузка сводки. Не бросает: ждущие не должны получить reject. */
  private async loadCrossover(
    username: string,
    key: string,
  ): Promise<Crossover | null | undefined> {
    const myId = await this.myUserId();
    // Свой профиль неизвестен — это не результат, кэшировать нечего.
    if (myId === null) return undefined;

    try {
      // Своя история и первая страница чужой едут ОДНОВРЕМЕННО. Раньше чужая
      // ждала свою целиком, потому что глубина зависит от моей самой старой
      // игры, — но от неё зависит только вопрос «нужны ли ещё страницы», а
      // первая нужна всегда. Ожидание было ровно вдвое длиннее необходимого.
      const theirs = (async () => {
        const id = await this.resolveUserId(username, key);
        return { id, first: await fetchFirstPage(id) };
      })();
      const [mine, start] = await Promise.all([this.getMyHistory(myId), theirs]);
      let data: Crossover | null = null;
      if (mine && start.first) {
        const full = await completeHistory(start.id, start.first, oldestDate(mine.rows));
        data = crossGames(mine.rows, full.rows, mine.truncated || full.truncated);
      }
      // Кэшируем и неудачу: иначе каждый повторный наведённый курсор гнал бы
      // пару историй заново (урок кэша последних игр, находка 7). Но держим
      // её коротко — сеть чинится, а сводка на полчаса «не удалось» нет.
      this.crossoverCache.set(key, {
        at: Date.now(),
        ttl: data ? CROSSOVER_TTL_MS : STATS_TTL_MS,
        data,
      });
      return data;
    } catch (e) {
      log.warn("player-notes", "пересечения не сложились", e);
      this.crossoverCache.set(key, { at: Date.now(), ttl: STATS_TTL_MS, data: null });
      return null;
    }
  }

  /**
   * Свой userId. Сначала дешёвые пути (шапка сайта, кэш), а в комнате шапки
   * нет — и тогда идём тем же путём, что и для любого игрока: со СВОЕЙ плитки
   * берём ник и резолвим его в id. Ровно этого не хватало в первой версии:
   * кнопка живёт в игре, а id читался только там, где кнопки нет.
   */
  private async myUserId(): Promise<number | string | null> {
    const known = await getOwnUserId();
    if (known !== null) return known;
    const myName = ownNameFromTable();
    if (!myName) return null;
    try {
      const id = await this.resolveUserId(myName, myName.toLowerCase());
      const numeric = typeof id === "number" ? id : Number(id);
      if (Number.isSafeInteger(numeric) && numeric > 0) void rememberOwnUserId(numeric);
      return id;
    } catch {
      // Свой ник не резолвится (нет в рейтинге, сеть) — честно молчим.
      return null;
    }
  }


  private createCrossoverButton(username: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = OWN.crossoverButton;
    button.dataset.username = username;
    button.style.cssText = BUTTON_PLAIN_CSS;
    button.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
        <circle cx="9" cy="12" r="6" stroke="currentColor" stroke-width="2"/>
        <circle cx="15" cy="12" r="6" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;

    const tooltip = document.createElement("div");
    tooltip.className = OWN.tooltip;
    tooltip.style.cssText = TOOLTIP_CSS;

    let intent: ReturnType<typeof setTimeout> | null = null;
    button.addEventListener("mouseenter", () => {
      tooltip.innerHTML = "Загрузка...";
      this.showTooltip(tooltip, button);
      // Задержка намерения: сводка стоит ДВУХ историй по 200 игр, и курсор,
      // мазнувший по столу, не должен поднимать десяток таких пар.
      intent = setTimeout(() => {
        intent = null;
        void (async () => {
          const data = await this.getCrossover(username);
          if (tooltip.dataset.pnShown !== "1") return;
          tooltip.innerHTML =
            data === undefined
              ? "Не удалось определить твой профиль — открой страницу поиска игры, и он запомнится"
              : data === null
                ? "Не удалось посчитать пересечения"
                : formatCrossover(data);
          this.showTooltip(tooltip, button);
        })();
      }, HOVER_INTENT_MS);
    });
    button.addEventListener("mouseleave", () => {
      if (intent) {
        clearTimeout(intent);
        intent = null;
      }
      this.hideTooltip(tooltip);
    });

    button.appendChild(tooltip);
    this.tooltipAnchors.set(tooltip, button);
    this.applyButtonTheme(button);
    return button;
  }

  // ─────────── История последних игр (с кэшем) ───────────

  /** Список игр; null — загрузить НЕ УДАЛОСЬ (это не «игр нет»). */
  private async getLastGames(username: string): Promise<LastGameEntry[] | null> {
    const key = username.toLowerCase();
    const cached = this.lastGamesCache.get(key);
    const fetchedAt = this.gamesFetchedAt.get(key) ?? 0;
    if (cached && Date.now() - fetchedAt < STATS_TTL_MS) return cached;
    // Дедупликация: несколько mouseenter до первого ответа (или две плитки
    // одного игрока) запускали одинаковые запросы (аудит 01.08.2026, находка 7).
    const inFlight = this.lastGamesInFlight.get(key);
    // .catch: с честным контрактом (ошибка = throw) общий промис может
    // упасть, и ВТОРОЙ ожидающий получал бы reject мимо обработки ниже —
    // тултип застревал на «Загрузка…» навсегда (ревью аудита устойчивости).
    if (inFlight) return inFlight.catch(() => null);

    const promise = this.fetchLastGames(username, key);
    this.lastGamesInFlight.set(key, promise);
    try {
      return await promise;
    } catch (e) {
      log.warn("player-notes", "last games unavailable", e);
      return null;
    } finally {
      this.lastGamesInFlight.delete(key);
    }
  }

  private async fetchLastGames(username: string, key: string): Promise<LastGameEntry[]> {
    try {
      const dataPromise = (async (): Promise<LastGameEntry[]> => {
        const userId = await this.resolveUserId(username, key);
        const limit = lastGamesLimit(this.settings.last_games_count);

        try {
          // Настоящий таймаут через AbortSignal вместо Promise.race: race не
          // отменял сам запрос, и он висел в сети после «таймаута».
          const gamesResponse = await fetch(
            `https://polemicagame.com/profile/default/get-games?userId=${userId}&page=1&limit=${limit}`,
            { signal: AbortSignal.timeout(15_000) },
          );
          if (!gamesResponse.ok) {
            log.warn("player-notes", `games API error: ${gamesResponse.status}`);
            // Ошибка ≠ «игр нет»: бросаем, чтобы не закэшировать пустоту и
            // показать честный текст (ревью аудита, мелочь 4).
            throw new Error(`games API ${gamesResponse.status}`);
          }
          const data: any = await gamesResponse.json();
          if (!Array.isArray(data?.rows)) {
            // Сменившееся поле/объект ошибки — не «игр нет»: иначе снова
            // покажем «Нет данных» и закэшируем пустоту (ревью, мелочь 2).
            log.warn("player-notes", "games API: unexpected shape");
            throw new Error("games API: unexpected shape");
          }
          const entries = (data.rows as any[]).map(
            (game): LastGameEntry => ({
              id: Number(game.id) || 0,
              role: game.role?.type === "don" ? "godfather" : game.role?.type || "civilian",
              isWin: game.result?.code === "success",
              mmrChange: parseInt(game.mmr?.mmr_diff, 10) || 0,
            }),
          );
          await this.markFirstKilled(entries, userId);
          return entries;
        } catch (err) {
          log.warn("player-notes", "fetching games history failed", err);
          throw err;
        }
      })();

      const result = await dataPromise;
      // Кэшируем и ПУСТОЙ результат: у нового игрока без сыгранных игр каждый
      // hover заново гнал запрос (аудит 01.08.2026, находка 7). Пустой ответ
      // живёт по короткому TTL — появившиеся игры подтянутся.
      this.lastGamesCache.set(key, result);
      this.gamesFetchedAt.set(
        key,
        result.length > 0 ? Date.now() : Date.now() - STATS_TTL_MS + EMPTY_GAMES_TTL_MS,
      );
      return result;
    } catch (e) {
      // Наверх летит ошибка: вызывающий отличит её от «игр нет» и НЕ будет
      // кэшировать пустоту (ревью аудита устойчивости, мелочь 4).
      log.debug("player-notes", "getLastGames failed", e);
      throw e;
    }
  }

  /**
   * Проставить «ПУ» в списке игр.
   *
   * Разборы матчей едут ОДНОВРЕМЕННО: восемь по полсекунды подряд — это
   * четыре секунды на наведение, а разом — те же полсекунды. Матч, который не
   * разобрался, остаётся без пометки вовсе: «не ПУ» по неудаче было бы
   * утверждением, которого мы не проверяли.
   */
  private async markFirstKilled(
    entries: LastGameEntry[],
    userId: number | string,
  ): Promise<void> {
    if (this.settings.last_games_first_killed === false) return;
    const mine = Number(userId);
    if (!Number.isSafeInteger(mine) || mine <= 0) return;
    const marks = await Promise.all(
      entries.map((entry) => (entry.id > 0 ? fetchFirstKilled(entry.id) : undefined)),
    );
    entries.forEach((entry, i) => {
      const first = marks[i];
      if (first !== undefined) entry.firstKilled = first === mine;
    });
  }

  private formatGamesHistory(games: LastGameEntry[]): string {
    if (!games || games.length === 0) return "Нет данных о последних играх";
    return games
      .map(
        (game) => `
        <div style="display: flex; align-items: center; gap: 5px; margin-bottom: 5px;">
          ${this.createRoleSvg(game.role, 14)}
          <span style="color: ${game.isWin ? "#4CAF50" : "#f44336"}">${
            game.isWin ? "Победа" : "Поражение"
          }</span>
          <span style="color: ${game.mmrChange >= 0 ? "#4CAF50" : "#f44336"}">${
            game.mmrChange >= 0 ? "+" : ""
          }${escapeHtml(String(game.mmrChange))}</span>
          ${
            game.firstKilled === true
              ? '<span title="Первый убитый" style="color:#ffd54f;font-weight:600">ПУ</span>'
              : ""
          }
        </div>
      `,
      )
      .join("");
  }

  // ─────────── SVG ролей ───────────
  // Спрайт и разметка вынесены в content/role-sprite.ts (общие с метками
  // ролей). Методы-делегаты сохранены: вызовов много, а поведение прежнее.

  private createRoleSvg(roleId: string, size: number): string {
    return createRoleSvg(roleId, size);
  }

  // ─────────── Инъекция кнопок к игрокам ───────────

  /**
   * Задевает ли батч мутаций то, что мы декорируем: плитки игроков, список
   * «Участники», шапку профиля. Атрибутные мутации игнорируются целиком —
   * это шум звуковых индикаторов (class на .player) и анимаций; текст/узлы
   * (childList) внутри интересных контейнеров — сигнал (смена ника,
   * пересадка, пересборка Vue). Появление/удаление самих плиток ловим по
   * содержимому added/removed-узлов. Пропущенное добирает страховочный
   * 2с-проход.
   */
  /** Последний полный проход, запущенный МУТАЦИЯМИ (интервал-страховка отдельно). */
  private lastMutationPassAt = 0;

  private processExistingElements(): void {
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }
    try {
      // Сначала сторож (снимает чужое), потом обычный проход (вешает своё).
      this.sweepStaleDecorations();
      const tiles = Array.from(document.querySelectorAll<HTMLElement>(SITE.player));
      const names = tiles.map((el) => el.querySelector(SITE.playerName)?.textContent?.trim() || "");
      // id игроков за столом — ЗАРАНЕЕ, не по наведению: см.
      // ensurePlayerIdsResolved. Один общий запрос на всех, дальше кэш.
      this.ensurePlayerIdsResolved(names);
      // Пересечения — тем же принципом «заранее», но ночью и по одному.
      this.pumpCrossoverWarm(names);
      tiles.forEach((el) => this.processElement(el));
      // Сайтовый список «Участники» — не плитки, обходится отдельно.
      this.applyParticipantColors();
      // Страница профиля — тоже отдельно (плиток .player там нет).
      this.ensureProfileNoteUI();
      // Проход прошёл целиком: если до этого он падал — говорим, что
      // починилось. Иначе в файле остаётся только «сломалось».
      if (this.passFailed) {
        this.passFailed = false;
        log.info("player-notes", "обновление заметок восстановилось");
      }
    } catch (e) {
      // ЛАТЧ, а не строка на каждый проход. Проход идёт раз в 2 секунды: при
      // устойчивой поломке это 1800 строк в час — кольцо в 600 записей
      // прокручивалось за 20 минут и вытесняло ПЕРВОПРИЧИНУ вместе с началом
      // сессии (аудит наблюдаемости 02.08.2026, PN-1).
      if (!this.passFailed) {
        this.passFailed = true;
        log.error("player-notes", "обновление заметок упало", e);
      } else {
        log.debug("player-notes", "processExistingElements failed (повтор)", e);
      }
    }
  }

  private processElement(element: Element): void {
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }
    if (!element.classList.contains("player")) return;

    const nicknameElement = element.querySelector(SITE.playerName);
    if (!nicknameElement) return;
    const username = nicknameElement.textContent?.trim() || "";
    if (!username) return;

    this.injectPlayerButtons(element, username);
  }

  /**
   * Сигнатура набора кнопок плитки: ник + какие кнопки включены настройками.
   * Смена сигнатуры (другой игрок в плитке после пересадки Vue ИЛИ переключили
   * галочку кнопки в попапе) — единственный повод пересобрать группу; в
   * остальном работает быстрый путь синхронизации без пересоздания (иначе
   * мерцание тултипов и лишние API-запросы на каждом тике DOM).
   */
  /**
   * Разрешить пересборку ряда кнопок. При шторме — запретить на паузу, один
   * раз пожаловаться в журнал и НЕМЕДЛЕННО его сбросить: если вкладка сейчас
   * встанет, обычный отложенный сброс до диска не доедет, и разбирать снова
   * будет нечего.
   */
  private allowRebuild(username: string, sig: string): boolean {
    const key = username.toLowerCase();
    const { allowed, state, stormed } = throttleRebuild(this.rebuildCounts.get(key), Date.now());
    this.rebuildCounts.set(key, state);
    if (stormed) {
      // Ник в sig редактируется В ТОЧКЕ ЛОГА: сам sig обязан остаться сырым
      // (identity гейта пересборки), а ники в файл не пишем (02.08.2026).
      log.warn(
        "player-notes",
        "шторм пересборки кнопок игрока — пауза; состав ряда:",
        sig.replace(username, redactNick(username)),
      );
      // Сброс НЕМЕДЛЕННО: если вкладка сейчас встанет, отложенный сброс до
      // диска не доедет, и разбирать снова будет нечего.
      log.flushNow();
    }
    return allowed;
  }

  private buttonsSignature(username: string, hasMedia: boolean): string {
    const s = this.settings;
    return [
      // СЫРОЙ ник намеренно: sig — identity для гейта пересборки кнопок, и
      // хэш здесь дал бы детерминированные коллизии → «кнопки прежнего
      // игрока» → заметка молча не тому (adversarial 26.08.2026, №1).
      // В persistent-лог sig не уходит: точка логирования редактирует сама.
      username,
      s.btn_stats_enabled === false ? 0 : 1,
      s.btn_note_enabled === false ? 0 : 1,
      s.btn_last_games_enabled === false ? 0 : 1,
      s.btn_crossover_enabled === false ? 0 : 1,
      s.btn_hide_video_enabled === false ? 0 : 1,
      // Наличие медиа — часть состава ряда: камера может подключиться позже,
      // и без пересборки кнопка «скрыть камеру» не появилась бы никогда.
      hasMedia ? 1 : 0,
    ].join("|");
  }

  private injectPlayerButtons(container: Element, username: string): void {
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }

    const infoContainer = container.querySelector<HTMLElement>(SITE.playerInfo);
    if (!infoContainer) return;

    // Рамка и цвет ника НЕ зависят от видео — обновляем ДО раннего выхода.
    // Ночью сайт пересаживает игроков по плиткам, а video-wrapper из плитки
    // пропадает: ранний return оставлял рамку/цвет ПРЕЖНЕГО игрока на чужой
    // плитке до конца фазы (баг 8.1.52, пойман владельцем в живой игре).
    this.applyPlayerTag(container as HTMLElement, username);
    this.applyNickColor(container as HTMLElement, username);

    // Медиа-гейт СНЯТ с немедийных кнопок: video-wrapper рендерится сайтом
    // только при hasVideo, и игрок без камеры вообще не получал заметку,
    // статистику и историю игр (аудит устойчивости 01.08.2026, находка 10),
    // а при пропаже wrapper'а ранний return пропускал ещё и синхронизацию
    // уже созданных кнопок (находка 17). Кнопки, которым медиа реально
    // нужно (скрыть видео, поворот, мьют), гейтятся по своим элементам ниже.
    const hasMedia = !!container.querySelector(SITE.playerVideoWrapper);

    // Ряд кнопок живёт в КОНТЕЙНЕРЕ угла (`.player__botleftmenu`), а не внутри
    // плашки: там же сайт держит плашку рейтинга (MMR) в лобби, и наш
    // абсолютный ряд ложился прямо на неё — «кнопки наезжают на рейтинг»
    // (жалоба владельца 08.08.2026). В потоке колонки контейнера всё
    // выстраивается само: рейтинг, кнопки, плашка ника. Порядок — перед
    // плашкой, чтобы привычный вид «кнопки над ником» не менялся; угол
    // плашки при желании переставит их вниз (nick-plate).
    // Fallback на плашку остаётся: если сайт когда-нибудь уберёт контейнер,
    // кнопки просто вернутся к старому absolute-поведению, а не исчезнут.
    const iconsHost = container.querySelector<HTMLElement>(SITE.plateContainer) || infoContainer;
    const sig = this.buttonsSignature(username, hasMedia);
    let iconsGroup = iconsHost.querySelector<HTMLElement>(`.${OWN.playerIcons}`);

    if (!iconsGroup || iconsGroup.dataset.pnSig !== sig) {
      // Сторож шторма: пересобирать ряд десятки раз в секунду бессмысленно в
      // любом сценарии, а вот подвесить вкладку — запросто.
      if (!this.allowRebuild(username, sig)) return;
      // Чистим кнопки этого ника ТОЛЬКО в своей плитке и пересобираем её.
      this.removeOldButtons(username, container as HTMLElement);
      // Ищем по всей плитке: после смены хоста старая группа могла остаться
      // внутри плашки (обновление расширения на живой странице).
      container.querySelectorAll(`.${OWN.playerIcons}`).forEach((g) => g.remove());

      iconsGroup = document.createElement("div");
      iconsGroup.className = OWN.playerIcons;
      iconsGroup.dataset.pnSig = sig;
      if (iconsHost === infoContainer) iconsHost.appendChild(iconsGroup);
      else iconsHost.insertBefore(iconsGroup, infoContainer);

      const s = this.settings;
      if (s.btn_stats_enabled !== false) {
        const statsButton = this.createStatsButton(username);
        if (statsButton) iconsGroup.appendChild(statsButton);
      }
      if (s.btn_note_enabled !== false) iconsGroup.appendChild(this.createNoteButton(username));
      if (s.btn_last_games_enabled !== false) {
        iconsGroup.appendChild(this.createLastGamesButton(username));
      }
      if (s.btn_crossover_enabled !== false) {
        iconsGroup.appendChild(this.createCrossoverButton(username));
      }
      if (s.btn_hide_video_enabled !== false && hasMedia) {
        iconsGroup.appendChild(this.createHideVideoButton(username, container));
      }
    }

    // ── единый путь синхронизации (и для свежей группы, и для живой) ──
    if (hasMedia) {
      this.ensureRotateButton(iconsGroup, container, username);
      this.ensureMuteButton(iconsGroup, container, username);
    }
    const hideButton = iconsGroup.querySelector<HTMLElement>(`.${OWN.hideVideoButton}`);
    if (hideButton) this.syncHideVideoButton(hideButton, username);
    // Пересоздание video-элемента сайтом сбрасывает volume и переворот.
    this.applyMuteState(container, username);
    this.ensureFlipState(container, username);

    const uname = username.toLowerCase();
    const vid = container.querySelector<HTMLElement>(SITE.playerVideo);
    if (this.hiddenVideos.has(uname)) {
      // Только при реальном изменении — иначе будим MutationObserver вхолостую.
      if (vid) {
        if (vid.style.display !== "none") vid.style.display = "none";
        if (vid.dataset.polemicaHidden !== "true") vid.dataset.polemicaHidden = "true";
      }
    } else if (vid?.dataset.polemicaHidden === "true") {
      if (vid.style.display === "none") vid.style.display = "";
      delete vid.dataset.polemicaHidden;
    }

    // (Повторных applyPlayerTag/applyNickColor здесь нет: пара в начале
    // метода уже отработала, а лишний вызов делал getComputedStyle на каждый
    // проход по каждой плитке — аудит 01.08.2026, находка 2.)
  }

  /**
   * Удалить кнопки ника в пределах его плитки.
   *
   * Раньше чистка шла по всему документу: если сайт показывал одного игрока
   * в двух плитках (десктоп/мобайл), они по очереди сносили кнопки друг друга
   * на каждом проходе — вечная пересборка и шквал запросов статистики.
   */
  private removeOldButtons(username: string, root: ParentNode = document): void {
    const sel = cssAttr(username);
    [
      `.${OWN.noteButton}[data-username=${sel}]`,
      `.${OWN.statsButton}[data-username=${sel}]`,
      `.${OWN.lastGamesButton}[data-username=${sel}]`,
      `.${OWN.crossoverButton}[data-username=${sel}]`,
      `.${OWN.hideVideoButton}[data-username=${sel}]`,
    ].forEach((s) => root.querySelectorAll(s).forEach((b) => b.remove()));
  }

  private removeStatisticsElements(): void {
    // .pn-profile-note-btn обязана сниматься вместе с остальным: пережившая
    // выключение кнопка держит замыкание на СТАРЫЙ инстанс менеджера, и её
    // модалка писала бы всю карту заметок из замороженного this.notes,
    // затирая всё, что добавлено после выключения (находка ревью 01.08.2026).
    document
      .querySelectorAll(
        `${OWN_BUTTON_SELECTOR}, .${OWN.playerStats}, .${OWN.tooltip}, .pn-profile-note-btn`,
      )
      .forEach((el) => el.remove());
    document.querySelectorAll(".pn-tag-ring").forEach((r) => r.remove());
    document
      .querySelectorAll<HTMLElement>("[data-pn-nick-color]")
      .forEach((el) => paintNickEl(el, ""));
    document.querySelectorAll(`.${OWN.playerIcons}`).forEach((group) => {
      if (!group.children.length) group.remove();
    });
  }

  // ─────────── Страница матча / аватар ───────────

  private addMatchPageStyles(): void {
    if (this.matchStyleEl) return;
    const style = document.createElement("style");
    style.id = OWN.matchPageStyle;
    style.textContent = `
      body[data-page-type="match"] .player__role use[href$="#stop"],
      body[data-page-type="match"] .player__role use[href*="#stop"],
      body[data-page-type="match"] svg use[href$="#stop"],
      body[data-page-type="match"] svg use[href*="#stop"] {
        display: none !important;
      }
      body[data-page-type="match"] .player__role svg:has(use[href$="#stop"]),
      body[data-page-type="match"] .player__role svg:has(use[href*="#stop"]) {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
    this.matchStyleEl = style;
  }

  private applyMatchPageMarker(): void {
    if (document.body.getAttribute("data-page-type") !== "match") {
      document.body.setAttribute("data-page-type", "match");
    }
  }

  syncMatchPageRoute(isMatch: boolean): void {
    this.matchPageActive = isMatch;
    if (isMatch) {
      this.addMatchPageStyles();
      this.applyMatchPageMarker();
      return;
    }
    this.matchStyleEl?.remove();
    this.matchStyleEl = null;
    if (document.body.getAttribute("data-page-type") === "match") {
      document.body.removeAttribute("data-page-type");
    }
  }

  // (loadSavedAvatar удалён — см. комментарий у onMessage в enable().)
}

// ───────────────────────── CSS-константы ─────────────────────────

const BUTTON_CIRCLE_CSS = `
  position: relative; /* якорь тултипа: без него absolute-тултип цеплялся к случайному предку */
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 1 !important;
  visibility: visible !important;
`;

const BUTTON_PLAIN_CSS = `
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  transition: all 0.2s ease;
  opacity: 1 !important;
  visibility: visible !important;
`;

const TOOLTIP_CSS = `
  position: absolute;
  bottom: 100%;
  left: 0;
  transform: translateY(10px);
  background: rgba(11, 27, 57, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(79, 129, 245, 0.3);
  padding: 10px;
  border-radius: 8px;
  font-size: 12px;
  visibility: hidden;
  opacity: 0;
  /* ТОЛЬКО opacity: со значением "all" тултип, уезжая в портал (showTooltip),
     анимировал ещё и left/top — от левого края экрана к своей позиции: он
     «влетал» через пол-страницы (регрессия 8.1.55). */
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
  white-space: normal;
  min-width: 120px;
  z-index: 1001;
  line-height: 1.3;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  margin-bottom: 5px;
  color: white;
`;

/**
 * Значение атрибута для селектора БЕЗ кавычек: `[data-username=<escaped>]`.
 *
 * Ручная замена кавычек не покрывала управляющие символы (LF/CR/FF): ник с
 * ними делал селектор невалидным, и querySelectorAll бросал исключение —
 * обновление кнопок/тултипов срывалось (аудит безопасности 01.08.2026, №14).
 * CSS.escape экранирует по спецификации именно идентификатор, поэтому
 * подставлять результат нужно без обрамляющих кавычек.
 */
export function cssAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // Фолбэк (движков без CSS.escape среди наших минимумов нет): экранируем
  // всё, что не [A-Za-z0-9_-] и не кириллица, по правилу CSS «\<hex> ».
  return value.replace(/[^\wЀ-ӿ-]/g, (c) => `\\${c.codePointAt(0)!.toString(16)} `);
}

// ───────────────────────── Экспорт фичи ─────────────────────────

let manager: PlayerNotesManager | null = null;

/** Вызывается единым URL-роутером content/index.ts. */
export function syncPlayerNotesRoute(isMatch: boolean): void {
  manager?.syncMatchPageRoute(isMatch);
}

export const playerNotesFeature: Feature = {
  id: "player-notes",
  settingKey: "statistics_enabled",
  async enable(ctx: FeatureContext) {
    manager = new PlayerNotesManager(ctx);
    await manager.enable();
  },
  disable() {
    manager?.disable();
    manager = null;
  },
  update(ctx: FeatureContext) {
    manager?.update(ctx);
  },
};
