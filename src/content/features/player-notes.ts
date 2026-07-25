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
import { onDomChange } from "@core/dom";
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
  /** Закрытие открытой модалки заметки — нужно, чтобы disable() снял её слушатели. */
  private closeOpenModal: (() => void) | null = null;

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
        const buttonsExist = document.querySelectorAll(`.${OWN.statsButton}`).length > 0;
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
          }
          this.updateAllTooltips();
        }
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
      if (!changes[NOTES_KEY]) return;
      this.notes = (changes[NOTES_KEY].newValue as NotesMap) || {};
      this.refreshNoteIndicators();
      this.refreshPlayerTags();
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

  private async loadNotes(): Promise<void> {
    const { notes, customTags } = await loadNotesFromStore();
    this.notes = notes;
    this.customTags = customTags;
    log.debug("player-notes", "notes loaded", Object.keys(this.notes).length);
  }

  private async saveCustomTags(): Promise<void> {
    await saveCustomTagsToStore(this.customTags);
  }

  /** Возвращает false, если запись не удалась — интерфейс обязан это показать. */
  private async saveNotes(): Promise<boolean> {
    return await saveNotesToStore(this.notes);
  }

  private getNoteText(username: string): string {
    const note = this.notes[username];
    if (!note) return "";
    return typeof note === "string" ? note : note.text || "";
  }

  private getNoteTag(username: string): string {
    const note = this.notes[username];
    return note && typeof note !== "string" ? note.tag || "" : "";
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
    // Перерисовываем только при смене метки: безусловная запись style будила
    // общий MutationObserver (он следит за атрибутом style) на каждом проходе.
    if (ring.dataset.tag === tag) return;
    ring.dataset.tag = tag;
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

  private updateAllTooltips(): void {
    document
      .querySelectorAll<HTMLElement>(`.${OWN.statsButton} .${OWN.tooltip}`)
      .forEach((tooltip) => {
        const button = tooltip.closest<HTMLElement>(`.${OWN.statsButton}`);
        const username = button?.dataset.username;
        // Без проверки кэша: generateTooltipContent корректно рисует заглушки,
        // а гейт по playerStats.has оставлял в тултипе УДАЛЁННУЮ в другой
        // вкладке заметку, пока статистика не загрузилась.
        if (username) tooltip.innerHTML = this.generateTooltipContent(username);
      });
  }

  private updatePlayerTooltips(username: string): void {
    document
      .querySelectorAll(`.${OWN.statsButton}[data-username="${cssAttr(username)}"] .${OWN.tooltip}`)
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
    tooltip.style.cssText = TOOLTIP_CSS;
    tooltip.innerHTML = this.generateTooltipContent(username);
    return tooltip;
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

    statsButton.addEventListener("mouseenter", () => {
      void this.loadPlayerStats(username);
      const svg = statsButton.querySelector<SVGElement>("svg");
      if (svg) svg.style.stroke = themeColor;
      tooltip.style.visibility = "visible";
      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateY(0)";
    });
    statsButton.addEventListener("mouseleave", () => {
      const svg = statsButton.querySelector<SVGElement>("svg");
      if (svg) svg.style.stroke = themeColor;
      tooltip.style.visibility = "hidden";
      tooltip.style.opacity = "0";
      tooltip.style.transform = "translateY(10px)";
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
      toggleFlipForPlayer(container as HTMLElement);
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
        this.hiddenVideos.delete(uname);
      } else {
        videoEl.style.display = "none";
        this.hiddenVideos.add(uname);
      }
    });
    this.applyButtonTheme(button);
    return button;
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
      tooltip.style.visibility = "visible";
      tooltip.style.opacity = "1";
      const games = await this.getLastGames(username);
      tooltip.innerHTML =
        games.length > 0
          ? this.formatGamesHistory(games)
          : "Нет данных о последних играх";
    });
    button.addEventListener("mouseleave", () => {
      tooltip.style.visibility = "hidden";
      tooltip.style.opacity = "0";
    });

    button.appendChild(tooltip);
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

    // ── выбор цветной метки ──
    let selectedTag = this.getNoteTag(username);
    const tagLabel = document.createElement("div");
    tagLabel.textContent = "Метка";
    tagLabel.style.cssText = "color: rgba(255,255,255,.7); font-size: 12px; margin-bottom: 6px;";
    const tagRow = document.createElement("div");
    tagRow.style.cssText = "display: flex; gap: 8px; margin-bottom: 15px; flex-wrap: wrap;";

    const makeSwatch = (css: string, name: string, custom: boolean): HTMLButtonElement => {
      const sw = document.createElement("button");
      sw.dataset.css = css;
      sw.title = custom ? `${name} (ПКМ — удалить)` : name;
      sw.style.cssText = `
        width: 24px; height: 24px; border-radius: 50%; cursor: pointer; padding: 0;
        border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto;
        background: ${css || "transparent"};
        outline: ${css === selectedTag ? "2px solid #fff" : "2px solid transparent"};
        outline-offset: 2px; display: flex; align-items: center; justify-content: center;
      `;
      if (!css) {
        sw.textContent = "✕"; // «нет метки»
        sw.style.color = "rgba(255,255,255,.6)";
      }
      sw.addEventListener("click", () => {
        selectedTag = css;
        rebuild();
      });
      if (custom) {
        sw.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.customTags = this.customTags.filter((c) => c !== css);
          void this.saveCustomTags();
          if (selectedTag === css) selectedTag = "";
          rebuild();
        });
      }
      return sw;
    };

    const rebuild = () => {
      tagRow.replaceChildren();
      for (const { css, name } of TAG_PRESETS) tagRow.appendChild(makeSwatch(css, name, false));
      for (const css of this.customTags) tagRow.appendChild(makeSwatch(css, "свой цвет", true));

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
        selectedTag = c;
        rebuild();
      });
      tagRow.append(add, picker);
    };
    rebuild();

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

    /** true — заметка записана; false — запись не удалась, окно закрывать нельзя. */
    const save = async (): Promise<boolean> => {
      if (!isSafeNoteKey(username)) {
        log.warn("player-notes", "unsafe username, note not saved", username);
        return false;
      }
      const value = textarea.value.trim();
      const previous = this.notes[username];
      if (value || selectedTag) {
        this.notes[username] = {
          text: value,
          timestamp: Date.now(),
          version: VERSION,
          tag: selectedTag || undefined,
        };
      } else {
        delete this.notes[username];
      }
      if (!(await this.saveNotes())) {
        // Откатываем память под состояние хранилища, иначе интерфейс будет
        // показывать заметку, которой на диске нет.
        if (previous === undefined) delete this.notes[username];
        else this.notes[username] = previous;
        return false;
      }
      // Обе плитки игрока (десктоп/мобайл), не только первая.
      document
        .querySelectorAll(`.${OWN.statsButton}[data-username="${cssAttr(username)}"] .${OWN.tooltip}`)
        .forEach((tooltip) => {
          tooltip.innerHTML = this.generateTooltipContent(username);
        });
      this.refreshNoteIndicators();
      this.refreshPlayerTags();
      return true;
    };

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

    modal.append(title, textarea, tagLabel, tagRow, buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Фокус в поле, курсор в конец текста.
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}"><use href="${href}" xlink:href="${href}"></use></svg>`;
  }

  // ─────────── Инъекция кнопок к игрокам ───────────

  private processExistingElements(): void {
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }
    try {
      document
        .querySelectorAll(SITE.player)
        .forEach((el) => this.processElement(el));
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

  private injectPlayerButtons(container: Element, username: string): void {
    if (this.settings.statistics_enabled === false) {
      this.removeStatisticsElements();
      return;
    }

    const videoWrapper = container.querySelector(SITE.playerVideoWrapper);
    const infoContainer = container.querySelector<HTMLElement>(SITE.playerInfo);
    if (!videoWrapper || !infoContainer) return;

    // Если кнопки этого игрока уже на месте — ничего не пересоздаём (иначе
    // мерцание тултипов и лишние API-запросы на каждом тике DOM).
    const sel = cssAttr(username);
    const alreadyHas =
      infoContainer.querySelector(`.${OWN.statsButton}[data-username="${sel}"]`) &&
      infoContainer.querySelector(`.${OWN.noteButton}[data-username="${sel}"]`) &&
      infoContainer.querySelector(`.${OWN.lastGamesButton}[data-username="${sel}"]`) &&
      infoContainer.querySelector(`.${OWN.hideVideoButton}[data-username="${sel}"]`);
    if (alreadyHas) {
      if (this.hiddenVideos.has(username.toLowerCase())) {
        const vid = container.querySelector<HTMLElement>(SITE.playerVideo);
        // Только при реальном изменении — иначе будим MutationObserver вхолостую.
        if (vid && vid.style.display !== "none") vid.style.display = "none";
      }
      this.applyPlayerTag(container as HTMLElement, username);
      const grp = infoContainer.querySelector(`.${OWN.playerIcons}`);
      if (grp) this.ensureRotateButton(grp, container, username);
      return;
    }

    // Чистим кнопки этого ника ТОЛЬКО в своей плитке и пересобираем её.
    this.removeOldButtons(username, container as HTMLElement);
    infoContainer
      .querySelectorAll(`.${OWN.playerIcons}`)
      .forEach((g) => g.remove());

    const iconsGroup = document.createElement("div");
    iconsGroup.className = OWN.playerIcons;
    infoContainer.appendChild(iconsGroup);

    const statsButton = this.createStatsButton(username);
    if (statsButton) iconsGroup.appendChild(statsButton);
    iconsGroup.appendChild(this.createNoteButton(username));
    iconsGroup.appendChild(this.createLastGamesButton(username));
    iconsGroup.appendChild(this.createHideVideoButton(username, container));
    this.ensureRotateButton(iconsGroup, container, username);

    if (this.hiddenVideos.has(username.toLowerCase())) {
      const vid = container.querySelector<HTMLElement>(SITE.playerVideo);
      if (vid) vid.style.display = "none";
    }

    this.applyPlayerTag(container as HTMLElement, username);
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
      .querySelectorAll(`${OWN_BUTTON_SELECTOR}, .${OWN.playerStats}`)
      .forEach((el) => el.remove());
    document.querySelectorAll(".pn-tag-ring").forEach((r) => r.remove());
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
