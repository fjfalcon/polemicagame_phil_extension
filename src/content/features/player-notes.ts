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
import { onDomChange, paintNickEl } from "@core/dom";
import { onMessage } from "@core/messaging";
import { toggleFlipForPlayer, isPlayerFlipped, unflipAll } from "../camera-flip";
import { getMatchId } from "../match-data";
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
} from "@core/notes-store";
import type { NoteRecord, NotesMap } from "@core/notes-store";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings, ExtMessage } from "@shared/types";

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
  role: string;
  isWin: boolean;
  mmrChange: number;
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

/** storage.local: массив ников (lowercase) с выключенным у нас звуком. */
const MUTED_PLAYERS_KEY = "pn_muted_players";

/** sessionStorage: ники (lowercase) с перевёрнутой камерой в текущей игре. */
const FLIPPED_PLAYERS_KEY = "pn_flipped_players";

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

  const request = fetch("https://polemicagame.com/rating/get-list?limit=1000")
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

const THEME_COLORS: Record<string, string> = {
  default: "rgb(66, 103, 178)",
  pink: "#ec4899",
  yellow: "#eab308",
  red: "#ef4444",
  green: "#22c55e",
  lime: "#84cc16",
  blue: "#38bdf8",
};

// ───────────────────────── Менеджер фичи ─────────────────────────

class PlayerNotesManager {
  private settings: Settings;
  private active = true;

  private notes: NotesMap = {};
  /** Пользовательские цвета меток (палитра), хранятся в storage.sync. */
  private customTags: string[] = [];
  /** Кэш статистики по нику (lowercase) — не дёргаем API повторно на hover. */
  private playerStats = new Map<string, PlayerStatsEntry>();
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

  private roleSpriteBaseUrl: string | null = null;

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
    this.unsubscribers.push(
      onDomChange(() => {
        if (this.matchPageActive) this.applyMatchPageMarker();
        if (this.settings.statistics_enabled === false) {
          this.removeStatisticsElements();
          return;
        }
        this.processExistingElements();
      }),
    );

    // Восстановитель: если игроки есть, а наши кнопки пропали (смена дня/ночи,
    // пересборка слотов) — переинициализируем. Заменяет связку из нескольких
    // интервалов и observer'ов оригинала.
    this.intervals.push(
      window.setInterval(() => {
        if (this.settings.statistics_enabled === false) {
          this.removeStatisticsElements();
          return;
        }
        const playersExist = document.querySelectorAll(SITE.player).length > 0;
        // Маркер — контейнер иконок, а не кнопка статистики: её теперь можно
        // выключить галочкой, и проверка по ней зациклила бы восстановитель.
        const buttonsExist = document.querySelectorAll(`.${OWN.playerIcons}`).length > 0;
        if (playersExist && !buttonsExist) {
          log.debug("player-notes", "buttons missing, reprocessing");
          this.processExistingElements();
        }
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
            // Выключение nick_colors_enabled должно снять покраску сразу.
            this.refreshNickColors();
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
    this.settings = ctx.settings;
    if (cameraWasEnabled && !this.settings.camera_rotate_enabled) unflipAll();
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }
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
    if (this.notesReadOnly) log.warn("player-notes", "notes load failed — saves blocked");
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

  private persistMutedPlayers(): void {
    void browser.storage.local
      .set({ [MUTED_PLAYERS_KEY]: [...this.mutedPlayers] })
      .catch((e) => log.warn("player-notes", "muted players save failed", e));
  }

  private async saveCustomTags(): Promise<void> {
    // Та же дыра «пишем непрочитанное», что у заметок: при упавшем loadNotes
    // палитра в памяти пуста, и запись стёрла бы пользовательские цвета.
    if (this.notesReadOnly) return;
    await saveCustomTagsToStore(this.customTags);
  }

  /** Возвращает false, если запись не удалась — интерфейс обязан это показать. */
  private async saveNotes(): Promise<boolean> {
    // Никакого авто-ресинка здесь: вызывающий уже мутировал this.notes, и
    // перезагрузка с диска затёрла бы только что введённую заметку, вернув
    // при этом true. Честный отказ — модалка покажет «Не сохранено!».
    if (this.notesReadOnly) return false;
    return await saveNotesToStore(this.notes);
  }

  /** userId игрока, если статистика его уже резолвила (иначе undefined). */
  private noteUserId(username: string): number | string | undefined {
    const id = this.playerStats.get(username.toLowerCase())?.id;
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
    }
    return username;
  }

  private getNote(username: string): NoteRecord | string | undefined {
    return this.notes[this.noteKeyFor(username)];
  }

  private getNoteText(username: string): string {
    const note = this.getNote(username);
    if (!note) return "";
    return typeof note === "string" ? note : note.text || "";
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

    let best: NoteRecord | undefined =
      fresh[key] !== undefined && typeof fresh[key] === "object"
        ? (fresh[key] as NoteRecord)
        : undefined;
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
      if (ts(loser) === ts(winner) && loser.text && loser.text !== winner.text) {
        winner.text = winner.text ? `${winner.text}\n[слито: ${loser.text}]` : loser.text;
        if (!winner.tag && loser.tag) winner.tag = loser.tag;
      }
    }

    fresh[key] = { ...winner, nick: username };
    for (const nk of freshNickKeys) delete fresh[nk];

    if (await saveNotesToStore(fresh)) {
      this.notes = fresh;
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
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    if (!ring) {
      ring = document.createElement("div");
      ring.className = "pn-tag-ring";
      container.appendChild(ring);
    }
    // Перерисовываем только при смене метки/владельца: безусловная запись
    // style будила общий MutationObserver на каждом проходе. Владелец (pnFor)
    // нужен сторожу пересадки: ночью сайт двигает игроков по плиткам.
    if (ring.dataset.tag === tag && ring.dataset.pnFor === username) return;
    ring.dataset.tag = tag;
    ring.dataset.pnFor = username;
    // Градиентная рамка: маской вырезаем середину, остаётся рамка 3px.
    // ВАЖНО: mask-composite ставим ПОСЛЕ shorthand-ов mask/-webkit-mask,
    // иначе shorthand сбрасывает composite в add и градиент заливает всю плитку.
    ring.style.cssText = `
      position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 5;
      padding: 3px; background: ${tag};
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      filter: drop-shadow(0 0 4px rgba(0,0,0,.4));
    `;
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
    if (id) {
      const rec = this.notes[idKey(id)];
      if (rec && typeof rec !== "string" && rec.nickColor) return rec.nickColor;
    }
    if (nick) {
      for (const k of this.nickKeysFor(nick)) {
        const rec = this.notes[k];
        if (rec && typeof rec !== "string" && rec.nickColor) return rec.nickColor;
      }
      const lower = nick.toLowerCase();
      for (const [k, v] of Object.entries(this.notes)) {
        if (isIdKey(k) && typeof v !== "string" && v.nickColor && v.nick?.toLowerCase() === lower) {
          return v.nickColor;
        }
      }
    }
    return "";
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

      const [generalStats, roleStats, killcount]: [any[], any, any[]] = await Promise.all([
        fetch(
          `https://polemicagame.com/profile/default/get-role-statistic?user_id=${userId}&role=&game_type=league&scoring_type=scoring_2%2Cscoring_3`,
        ).then((r) => r.json()),
        fetch(
          `https://polemicagame.com/profile/default/get-statistic?user_id=${userId}&game_type=league&scoring_type=scoring_2%2Cscoring_3`,
        ).then((r) => r.json()),
        fetch(
          `https://polemicagame.com/profile/default/get-role-statistic?user_id=${userId}&role=civilian%2Csheriff&game_type=league&scoring_type=scoring_2%2Cscoring_3`,
        ).then((r) => r.json()),
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
      log.error("player-notes", `loadPlayerStats failed for ${username}`, e);
    } finally {
      this.statsInFlight.delete(key);
    }
  }

  // ─────────── Тема кнопок ───────────

  private getStatsThemeColor(): string {
    return THEME_COLORS[this.settings.stats_button_theme] || THEME_COLORS.default;
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
        `.${OWN.tooltip}[data-pn-stats="1"][data-username="${cssAttr(username)}"]`,
      )
      .forEach((tooltip) => {
        tooltip.innerHTML = this.generateTooltipContent(username);
      });
  }

  private createTooltip(username: string): HTMLDivElement {
    if (!this.playerStats.has(username.toLowerCase())) {
      void this.loadPlayerStats(username);
    }
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
    }
    tooltip.style.position = "fixed";
    tooltip.style.transform = "none";
    tooltip.style.visibility = "visible";
    tooltip.style.opacity = "1";
    tooltip.style.zIndex = "2147483000";

    const a = anchor.getBoundingClientRect();
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    // Над кнопкой; не влезает — под неё. По горизонтали держим в окне.
    let top = a.top - h - 8;
    if (top < 4) top = Math.min(a.bottom + 8, window.innerHeight - h - 4);
    const left = Math.min(Math.max(4, a.left), Math.max(4, window.innerWidth - w - 4));
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.bottom = "auto";
    tooltip.style.right = "auto";
  }

  /** Спрятать тултип и вернуть его к кнопке (см. showTooltip). */
  private hideTooltip(tooltip: HTMLElement): void {
    tooltip.style.visibility = "hidden";
    tooltip.style.opacity = "0";
    delete tooltip.dataset.pnShown;
    const anchor = this.tooltipAnchors.get(tooltip);
    if (anchor?.isConnected && tooltip.parentElement === document.body) {
      anchor.appendChild(tooltip);
      // Возвращаем «родные» стили: элемент снова живёт внутри кнопки.
      tooltip.style.position = "absolute";
      tooltip.style.top = "auto";
      tooltip.style.left = "0";
      tooltip.style.bottom = "100%";
      tooltip.style.transform = "translateY(10px)";
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
      const raw = sessionStorage.getItem(FLIPPED_PLAYERS_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        this.flippedPlayers = new Set(
          list.filter((u): u is string => typeof u === "string" && u !== ""),
        );
      }
    } catch {
      /* повреждённый sessionStorage — просто начинаем с пустого набора */
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
    // ended-гард обязателен: у мёртвого потока draw() тут же выходит через
    // cleanupFlip, флаг flipped снимается — и без гарда мы бы пересоздавали
    // canvas на КАЖДОМ тике DOM, пока сайт не заменит video.
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
    const has = !!this.getNoteText(username);
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

  /** Обновить индикаторы у всех видимых кнопок заметок. */
  private refreshNoteIndicators(): void {
    document
      .querySelectorAll<HTMLElement>(`.${OWN.noteButton}[data-username]`)
      .forEach((btn) => {
        const u = btn.dataset.username;
        if (u) this.updateNoteIndicator(btn, u);
      });
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
      if (this.mutedPlayers.has(uname)) this.mutedPlayers.delete(uname);
      else this.mutedPlayers.add(uname);
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

    button.addEventListener("mouseenter", async () => {
      tooltip.innerHTML = "Загрузка...";
      this.showTooltip(tooltip, button);
      const games = await this.getLastGames(username);
      tooltip.innerHTML =
        games.length > 0
          ? this.formatGamesHistory(games)
          : "Нет данных о последних играх";
      // Содержимое сменилось — размер тоже, пересчитываем позицию.
      if (tooltip.dataset.pnShown === "1") this.showTooltip(tooltip, button);
    });
    button.addEventListener("mouseleave", () => {
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
    modal.style.cssText = `
      background: rgba(11, 27, 57, 0.97);
      padding: 20px; border-radius: 8px; min-width: 320px; max-width: 90vw;
      border: 1px solid rgba(79, 129, 245, 0.3);
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
    `;

    const title = document.createElement("h3");
    title.textContent = `Заметка для игрока ${username}`;
    title.style.cssText = "margin: 0 0 15px 0; color: white; font-size: 16px;";

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
            this.customTags = this.customTags.filter((c) => c !== css);
            void this.saveCustomTags();
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

        // Кнопка «+» — выбрать свой цвет и сохранить в палитру.
        const add = document.createElement("button");
        add.textContent = "+";
        add.title = "Добавить свой цвет";
        add.style.cssText = `
          width: 24px; height: 24px; border-radius: 50%; cursor: pointer; padding: 0;
          border: 1px dashed rgba(255,255,255,.4); background: transparent; color: #fff;
          font-size: 15px; line-height: 1; flex: 0 0 auto;
        `;
        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = "#3b82f6";
        picker.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none;";
        add.addEventListener("click", () => picker.click());
        picker.addEventListener("change", () => {
          const c = picker.value;
          if (c && !this.customTags.includes(c) && !TAG_PRESETS.some((p) => p.css === c)) {
            this.customTags.push(c);
            void this.saveCustomTags();
          }
          setSel(c);
          rebuildAll();
        });
        row.append(add, picker);
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
        log.warn("player-notes", "unsafe username, note not saved", username);
        return false;
      }
      const value = textarea.value.trim();
      // Пишем по id-ключу, если статистика уже резолвила игрока: такая заметка
      // переживёт смену ника и не перепутает тёзок. Иначе — легаси-ник.
      const id = this.noteUserId(username);
      const key = id !== undefined ? idKey(id) : username;
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
          ...(id !== undefined ? { nick: username } : {}),
        };
      } else if (unseen === undefined) {
        delete this.notes[key];
      }
      // else: пустое сохранение удаляет только то, что пользователь ВИДЕЛ
      // (ник-ключи ниже); невидённая u:-запись переживает.

      // Запись по id-ключу поглощает легаси-ники этого игрока.
      for (const nk of staleNickKeys) delete this.notes[nk];

      if (!(await this.saveNotes())) {
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
    buttons.style.cssText = "display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;";
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

    modal.append(title, textarea, tagLabel, tagRow, nickColorLabel, nickColorRow, buttons);
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
          ...(isIdKey(key) ? { nick: createNick } : {}),
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
      if (!(await this.saveNotes())) {
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

  /** Все записи с назначенным цветом ника: [ключ, ник, id, цвет]. */
  private nickColorEntries(): Array<{ key: string; nick: string; id: string; color: string }> {
    return Object.entries(this.notes)
      .filter(
        (pair): pair is [string, NoteRecord] =>
          typeof pair[1] !== "string" && !!pair[1].nickColor,
      )
      .map(([key, rec]) => ({
        key,
        nick: rec.nick || (isIdKey(key) ? `игрок ${key.slice(ID_KEY_PREFIX.length)}` : key),
        id: isIdKey(key) ? key.slice(ID_KEY_PREFIX.length) : "",
        color: rec.nickColor || "",
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
    title.textContent = "Цвета ников";
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
        ? `${found.nick} (id ${found.id}) — выбери цвет:`
        : `${found.nick} — id не найден, цвет привяжется к нику. Выбери цвет:`;
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
              render();
            } else showAddError("Не удалось сохранить — попробуй ещё раз.");
          });
        });
        palette.appendChild(sw);
      }
      addResult.append(info, palette);
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

    const render = () => {
      list.replaceChildren();
      const entries = this.nickColorEntries();
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.textContent =
          "Пока нет ни одного цвета. Цвет задаётся в заметке игрока — кнопка ✎ на его плитке.";
        empty.style.cssText = "color: rgba(255,255,255,.6); font-size: 13px; padding: 8px 0;";
        list.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:6px 0;" +
          "border-bottom:1px solid rgba(255,255,255,.08);";

        const swatch = document.createElement("button");
        swatch.title = "Сменить цвет";
        swatch.style.cssText = `
          width: 20px; height: 20px; border-radius: 50%; cursor: pointer; padding: 0;
          border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto; background: ${entry.color};
        `;
        const toggle = () => {
          expandedKey = expandedKey === entry.key ? null : entry.key;
          render();
        };
        swatch.addEventListener("click", toggle);

        const nick = document.createElement("span");
        nick.textContent = entry.nick;
        nick.style.cssText =
          "color:#fff;font-size:13px;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

        const idEl = document.createElement("span");
        idEl.textContent = entry.id ? `id ${entry.id}` : "без id";
        idEl.title = entry.id
          ? "Цвет привязан к аккаунту и переживёт смену ника"
          : "Игрок ещё не резолвился в id — цвет привязан к нику";
        idEl.style.cssText = "color:rgba(255,255,255,.45);font-size:11px;flex:0 0 auto;";

        const change = document.createElement("button");
        change.textContent = "Изменить";
        change.style.cssText =
          "padding:4px 10px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(99,102,241,.3);flex:0 0 auto;";
        change.addEventListener("click", toggle);

        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "Убрать цвет";
        del.style.cssText =
          "padding:4px 8px;color:#fff;border:none;border-radius:6px;cursor:pointer;" +
          "font-size:12px;background:rgba(239,68,68,.35);flex:0 0 auto;";
        del.addEventListener("click", () => {
          void this.setNickColor(entry.key, "").then((ok) => {
            if (ok) {
              if (expandedKey === entry.key) expandedKey = null;
              render();
            } else del.textContent = "ошибка";
          });
        });

        row.append(swatch, nick, idEl, change, del);
        list.appendChild(row);

        if (expandedKey === entry.key) {
          const palette = document.createElement("div");
          palette.style.cssText =
            "display:flex;gap:8px;padding:8px 0 10px;flex-wrap:wrap;" +
            "border-bottom:1px solid rgba(255,255,255,.08);";
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
              outline: ${opt.css === entry.color ? "2px solid #fff" : "2px solid transparent"};
              outline-offset: 2px;
            `;
            sw.addEventListener("click", () => {
              void this.setNickColor(entry.key, opt.css).then((ok) => {
                if (ok) {
                  expandedKey = null;
                  render();
                }
              });
            });
            palette.appendChild(sw);
          }
          list.appendChild(palette);
        }
      }
    };
    render();

    const hint = document.createElement("div");
    hint.textContent = "Новый цвет назначается в заметке игрока (кнопка ✎ на плитке).";
    hint.style.cssText = "color:rgba(255,255,255,.45);font-size:11px;margin:10px 0 12px;";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Закрыть";
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

    modal.append(title, addWrap, list, hint, closeBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ─────────── История последних игр (с кэшем) ───────────

  private async getLastGames(username: string): Promise<LastGameEntry[]> {
    const key = username.toLowerCase();
    const cached = this.lastGamesCache.get(key);
    const fetchedAt = this.gamesFetchedAt.get(key) ?? 0;
    if (cached && Date.now() - fetchedAt < STATS_TTL_MS) return cached;

    try {
      const timeoutPromise = new Promise<LastGameEntry[]>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 15000),
      );

      const dataPromise = (async (): Promise<LastGameEntry[]> => {
        let userId: number | string | undefined;
        const stats = this.playerStats.get(key);
        if (stats && !stats.ratingUnavailable && stats.id) {
          userId = stats.id;
        } else {
          try {
            const player = await findRatingPlayer(username);
            if (!player) {
              log.warn("player-notes", `player ${username} not found in rating`);
              return [];
            }
            userId = player.user_id;
          } catch (err) {
            log.warn("player-notes", "player ID lookup failed", err);
            return [];
          }
        }

        try {
          const gamesResponse = await fetch(
            `https://polemicagame.com/profile/default/get-games?userId=${userId}&page=1&limit=4`,
          );
          if (!gamesResponse.ok) {
            log.warn("player-notes", `games API error: ${gamesResponse.status}`);
            return [];
          }
          const data: any = await gamesResponse.json();
          if (data && data.rows) {
            return (data.rows as any[]).map((game): LastGameEntry => ({
              role:
                game.role?.type === "don"
                  ? "godfather"
                  : game.role?.type || "civilian",
              isWin: game.result?.code === "success",
              mmrChange: parseInt(game.mmr?.mmr_diff, 10) || 0,
            }));
          }
          log.warn("player-notes", "games API returned empty data");
          return [];
        } catch (err) {
          log.warn("player-notes", "fetching games history failed", err);
          return [];
        }
      })();

      const result = await Promise.race([dataPromise, timeoutPromise]);
      // Кэшируем только непустой результат (как и оригинал не повторял запрос).
      if (result.length > 0) {
        this.lastGamesCache.set(key, result);
        this.gamesFetchedAt.set(key, Date.now());
      }
      return result;
    } catch (e) {
      log.error("player-notes", "getLastGames failed", e);
      return [];
    }
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
        </div>
      `,
      )
      .join("");
  }

  // ─────────── SVG ролей ───────────

  private resolveRoleSpriteBaseUrl(): string {
    if (this.roleSpriteBaseUrl !== null) return this.roleSpriteBaseUrl;

    const roleMarkers = ["#civilian", "#sheriff", "#mafia", "#godfather"];

    if (document.querySelector(SITE.roleSymbols)) {
      this.roleSpriteBaseUrl = "";
      return this.roleSpriteBaseUrl;
    }

    const useElements = document.querySelectorAll(SITE.roleUse);

    for (const useEl of Array.from(useElements)) {
      const rawHref =
        useEl.getAttribute("href") || useEl.getAttribute("xlink:href");
      if (!rawHref) continue;
      if (roleMarkers.includes(rawHref)) {
        this.roleSpriteBaseUrl = "";
        return this.roleSpriteBaseUrl;
      }
      if (!rawHref.includes("/bundle/") || !rawHref.includes(".svg")) continue;
      if (!roleMarkers.some((m) => rawHref.includes(m))) continue;
      const base = rawHref.split("#")[0];
      if (base) {
        this.roleSpriteBaseUrl = base;
        return base;
      }
    }

    for (const useEl of Array.from(useElements)) {
      const rawHref =
        useEl.getAttribute("href") || useEl.getAttribute("xlink:href");
      if (!rawHref) continue;
      if (!rawHref.includes("/bundle/") || !rawHref.includes(".svg")) continue;
      const base = rawHref.split("#")[0];
      if (base) {
        this.roleSpriteBaseUrl = base;
        return base;
      }
    }

    const defaultPrefix = window.location.pathname.includes("/new-room/")
      ? "/new-room/bundle/"
      : "/room/bundle/";
    this.roleSpriteBaseUrl = `${defaultPrefix}f59bacbc2885635c4d91.svg`;
    return this.roleSpriteBaseUrl;
  }

  private createRoleSvg(roleId: string, size: number): string {
    const base = this.resolveRoleSpriteBaseUrl();
    const href = `${base}#${roleId}`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttributeNS(
      "http://www.w3.org/2000/xmlns/",
      "xmlns:xlink",
      "http://www.w3.org/1999/xlink",
    );
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", href);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
    svg.appendChild(use);
    return svg.outerHTML;
  }

  // ─────────── Инъекция кнопок к игрокам ───────────

  private processExistingElements(): void {
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }
    try {
      // Сначала сторож (снимает чужое), потом обычный проход (вешает своё).
      this.sweepStaleDecorations();
      document
        .querySelectorAll(SITE.player)
        .forEach((el) => this.processElement(el));
      // Сайтовый список «Участники» — не плитки, обходится отдельно.
      this.applyParticipantColors();
    } catch (e) {
      log.error("player-notes", "processExistingElements failed", e);
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
  private buttonsSignature(username: string): string {
    const s = this.settings;
    return [
      username,
      s.btn_stats_enabled === false ? 0 : 1,
      s.btn_note_enabled === false ? 0 : 1,
      s.btn_last_games_enabled === false ? 0 : 1,
      s.btn_hide_video_enabled === false ? 0 : 1,
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

    const videoWrapper = container.querySelector(SITE.playerVideoWrapper);
    if (!videoWrapper) return;

    const sig = this.buttonsSignature(username);
    let iconsGroup = infoContainer.querySelector<HTMLElement>(`.${OWN.playerIcons}`);

    if (!iconsGroup || iconsGroup.dataset.pnSig !== sig) {
      // Чистим кнопки этого ника ТОЛЬКО в своей плитке и пересобираем её.
      this.removeOldButtons(username, container as HTMLElement);
      infoContainer.querySelectorAll(`.${OWN.playerIcons}`).forEach((g) => g.remove());

      iconsGroup = document.createElement("div");
      iconsGroup.className = OWN.playerIcons;
      iconsGroup.dataset.pnSig = sig;
      infoContainer.appendChild(iconsGroup);

      const s = this.settings;
      if (s.btn_stats_enabled !== false) {
        const statsButton = this.createStatsButton(username);
        if (statsButton) iconsGroup.appendChild(statsButton);
      }
      if (s.btn_note_enabled !== false) iconsGroup.appendChild(this.createNoteButton(username));
      if (s.btn_last_games_enabled !== false) {
        iconsGroup.appendChild(this.createLastGamesButton(username));
      }
      if (s.btn_hide_video_enabled !== false) {
        iconsGroup.appendChild(this.createHideVideoButton(username, container));
      }
    }

    // ── единый путь синхронизации (и для свежей группы, и для живой) ──
    this.ensureRotateButton(iconsGroup, container, username);
    this.ensureMuteButton(iconsGroup, container, username);
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

    this.applyPlayerTag(container as HTMLElement, username);
    this.applyNickColor(container as HTMLElement, username);
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
      `.${OWN.noteButton}[data-username="${sel}"]`,
      `.${OWN.statsButton}[data-username="${sel}"]`,
      `.${OWN.lastGamesButton}[data-username="${sel}"]`,
      `.${OWN.hideVideoButton}[data-username="${sel}"]`,
    ].forEach((s) => root.querySelectorAll(s).forEach((b) => b.remove()));
  }

  private removeStatisticsElements(): void {
    document
      .querySelectorAll(`${OWN_BUTTON_SELECTOR}, .${OWN.playerStats}, .${OWN.tooltip}`)
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
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
  white-space: normal;
  min-width: 120px;
  z-index: 1001;
  line-height: 1.3;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  margin-bottom: 5px;
  color: white;
`;

/** Экранирование значения для подстановки в [data-username="..."] селектор. */
function cssAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
