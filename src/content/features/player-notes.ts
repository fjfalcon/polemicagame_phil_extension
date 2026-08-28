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
  FULL_HISTORY_LIMIT,
  fetchFirstPage,
  fetchHistory,
  oldestDate,
    type Crossover,
  type History,
  getOwnHistory,
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
import {
  ACTIVE_GAMES_TTL_MS,
  fetchActiveGames,
  findRatingPlayer,
  resetActiveGamesCacheForTest,
  type RatingPlayer,
} from "@core/polemica-api";
import {
  HistoryStore,
  WARM_PAGE_LIMIT,
  type LastGameEntry,
} from "./player-notes/history-store";
import { parseFlippedPlayers } from "./player-notes/flipped-players";
import {
  MUTED_PLAYERS_KEY,
  TileMediaState,
} from "./player-notes/tile-media-state";
import type { ModalPort } from "./player-notes/modal-port";
import { openNickColorManager } from "./player-notes/nick-color-manager";
import { showNoteModal } from "./player-notes/note-modal";
import { NotesModel } from "./player-notes/notes-model";
import { TAG_PRESETS } from "./player-notes/tag-palette";
import { normalizeTouched } from "./player-notes/normalize-touched";
import {
  PlayerStatsStore,
  STATS_TTL_MS,
  unavailablePlayerStats,
  type PlayerStatsEntry,
} from "./player-notes/player-stats";
import {
  BUTTON_CIRCLE_CSS,
  BUTTON_PLAIN_CSS,
  cssAttr,
  TOOLTIP_CSS,
} from "./player-notes/styles";
import { createRoleSvg } from "../role-sprite";
import { formatCrossover } from "../crossover-view";
import { redactNick } from "@shared/redact";

import { escapeHtml } from "@core/escape";
import { SITE, OWN, OWN_BUTTON_SELECTOR } from "@core/selectors";
import {
  MAX_OWN_NOTE_TEXT,
  normalizeNoteRecord,
  loadNotes as loadNotesFromStore,
  saveNotes as saveNotesToStore,
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

/* NoteRecord / NotesMap живут в @core/notes-store — их делят content и popup. */

const VERSION = NOTES_VERSION;

/**
 * Задержка намерения для ДОРОГИХ окон: сводка пересечений стоит двух историй,
 * а окно последних игр с «ПУ» — разбора каждой игры. Курсор, мазнувший по
 * столу, не должен поднимать десяток таких пачек. Дешёвые окна (и те же
 * последние игры без «ПУ») открываются сразу.
 */
const HOVER_INTENT_MS = 350;


/** sessionStorage: ники (lowercase) с перевёрнутой камерой в текущей игре. */

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

/**
 * Сеть и её кэши переехали в @core/polemica-api (арх-ревью 28.08.2026).
 * Ре-экспорт оставлен намеренно: перф-бюджеты сторожат «/api/games никогда не
 * перекрывается» именно через эту фичу, и точка импорта — часть их смысла.
 */
export { fetchActiveGames, resetActiveGamesCacheForTest };
/** Нормализация затронутых записей уехала в ./player-notes/normalize-touched. */
export { normalizeTouched };
/** Разбор перевёрнутых камер уехал в ./player-notes/flipped-players. */
export { parseFlippedPlayers };
/** Стили уехали в ./player-notes/styles; cssAttr сторожат тесты по этому пути. */
export { cssAttr };

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
  const SCOPE_SEL = SITE.playerScope;
  const CONTENT_SEL = SITE.playerContentScope;
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
   * Резолв «ник → ключ записи». Карту заметок и резолв id даёт менеджер:
   * слой ключей не знает ни про сеть, ни про DOM, ни про настройки.
   */
  /**
   * Статистика игроков: сеть, кэш и сборка цифр. Обратно фича получает ровно
   * один сигнал — «данные игрока приехали».
   */
  /**
   * История игр соперника: кэши пересечений и последних игр, прогрев.
   * Наружу отдаёт только данные — рисует их фича.
   */
  /**
   * Что игрок решил про чужие плитки: мьют (общий для вкладок, storage.local),
   * переворот камеры (sessionStorage вкладки) и скрытие видео (память).
   */
  private readonly tileMedia = new TileMediaState({
    onPersistError: (message) => this.toast(message, true),
    onExternalMuteChange: () => this.processExistingElements(),
  });
  private readonly history = new HistoryStore({
    isActive: () => this.active,
    lastGamesCount: () => this.settings.last_games_count,
    firstKilledEnabled: () => this.settings.last_games_first_killed !== false,
    crossoverEnabled: () => this.settings.btn_crossover_enabled !== false,
    isNight: () => isNightNow(),
    ownName: () => ownNameFromTable(),
    myUserId: () => this.myUserId(),
    resolveUserId: (username, key) => this.resolveUserId(username, key),
  });
  private readonly stats = new PlayerStatsStore({
    isActive: () => this.active,
    isEnabled: () => this.settings.statistics_enabled !== false,
    onLoaded: (username) => {
      // userId резолвлен — самое время лениво перевезти заметку с ник-ключа
      // на вечный id-ключ (смена ника больше не теряет заметку).
      const resolvedId = this.model.keys.userId(username);
      if (resolvedId !== undefined) {
        this.migrateNoteToId(username, resolvedId).catch((e) =>
          log.error("player-notes", "note migration failed", e),
        );
      }
      // Обновляем ВСЕ отрисованные тултипы этого игрока: сайт рендерит одного
      // игрока в двух плитках (десктоп/мобайл), а querySelector обновлял
      // только первую — вторая навсегда оставалась с заглушками «???».
      this.updatePlayerTooltips(username);
    },
  });
  /**
   * Полный проход по плиткам сейчас падает (латч, а не счётчик строк).
   * Проход идёт раз в 2 секунды: без латча устойчивая поломка давала бы
   * 1800 одинаковых строк в час и вытесняла из кольца первопричину
   * (аудит наблюдаемости 02.08.2026, PN-1).
   */
  private passFailed = false;
  private active = true;

  /**
   * Данные заметок: карта, палитра, очередь записи и правила сохранения.
   * Фича их только читает и заказывает перерисовку — владелец отдельный.
   */
  private readonly model = new NotesModel({
    isActive: () => this.active,
    onColorsChanged: () => this.refreshNickColors(),
    onIndicatorsChanged: () => this.refreshNoteIndicators(),
    onTagsChanged: () => this.refreshPlayerTags(),
    onTooltipsChanged: () => this.updateAllTooltips(),
    onPlayerTooltips: (username) => this.updatePlayerTooltips(username),
    toast: (message, warn) => this.toast(message, warn),
    lookupId: (lower) => this.stats.idOf(lower) ?? this.profileIdByNick.get(lower),
  });

  /** Палитра пользовательских цветов — только для чтения. */
  private get customTags(): string[] {
    return this.model.customTags;
  }
  /**
   * id игроков, известные ПОМИМО статистики (страница профиля: id из URL).
   * Отдельная карта, а не фейковая запись в статистике: та несёт mmr/winrate,
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
  /** Своя история в полёте: прогрев и наведение мыши не тянут её дважды. */
  /** Тултипы, живущие порталом в body (для уборки осиротевших). */
  private portaledTooltips = new Set<HTMLElement>();
  /** Снятые в этой вкладке мьюты — не воскрешаем их при слиянии с диском. */
  /** Удалённые в этой вкладке свои цвета — то же для палитры. */
  /** Живые плашки-уведомления (снимаются в disable). */
  private toasts = new Set<HTMLElement>();
  /** Ники с временно скрытым видео (в пределах сессии). */
  /**
   * Локально замьюченные игроки (ники, lowercase). ПЕРСИСТЕНТНО в
   * storage.local (ключ pn_muted_players) — по просьбе владельца мьют
   * действует во всех следующих играх, пока его не сняли. Глушим через
   * volume = 0 на ВСЕХ media-элементах плитки (см. applyMuteState — звук
   * идёт через отдельный <audio>, НЕ через video): Vue сайта биндит muted
   * и srcObject, но НЕ volume, поэтому наше значение переживает апдейты
   * компонента; пересоздание элемента ловится обычным refresh-циклом.
   */
  /** Закрытие открытой модалки заметки — нужно, чтобы disable() снял её слушатели. */
  private closeOpenModal: (() => void) | null = null;
  /**
   * Игроки (lowercase), чьи камеры пользователь перевернул в ЭТОЙ игре.
   * sessionStorage: живёт в рамках вкладки и переживает F5, но не тащится в
   * следующие игры/дни — сайт пересоздаёт video на каждой смене фазы, и без
   * этого набора переворот приходилось нажимать заново после каждой ночи.
   */
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
    await this.tileMedia.loadMuted();
    this.tileMedia.loadFlipped();

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
        this.model.adoptExternalTags(next);
      }
      // Мьюты общие между вкладками: без этой ветки вкладка со старым Set
      // затирала бы чужие мьюты при первом же своём клике (пишется весь список).
      if (changes[MUTED_PLAYERS_KEY]) {
        this.tileMedia.adoptExternalMuted(changes[MUTED_PLAYERS_KEY].newValue);
      }
      if (!changes[NOTES_KEY]) return;
      this.model.adoptExternalNotes(changes[NOTES_KEY].newValue);
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
          target?.closest?.(SITE.videoClickZone) ?? null;
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

    this.stats.reset();
    this.history.reset();
    this.stats.clearErrorBackoff();
    this.portaledTooltips.clear();
    for (const t of this.toasts) t.remove();
    this.toasts.clear();
    this.tileMedia.clearUnmutedHere();
    this.profileIdByNick.clear();
    this.idResolveAttempted.clear();
    this.idResolveFailedAt = 0;
    this.model.keys.reset();
    this.colorIndexCache = null;
    // Мьют персистентный, но при выключенной фиче звук обязан вернуться:
    // расширение «ничего не делает», когда его выключили (§4 п.7).
    document
      .querySelectorAll<HTMLMediaElement>('video[data-pn-muted="true"], audio[data-pn-muted="true"]')
      .forEach((v) => {
        if (v.volume === 0) v.volume = 1;
        delete v.dataset.pnMuted;
      });
    this.tileMedia.reset();
  }

  update(ctx: FeatureContext): void {
    const cameraWasEnabled = this.settings.camera_rotate_enabled;
    const gamesViewChanged =
      this.settings.last_games_count !== ctx.settings.last_games_count ||
      this.settings.last_games_first_killed !== ctx.settings.last_games_first_killed;
    this.settings = ctx.settings;
    // В кэше лежат СТАРЫЕ списки: без сброса «показывать 8» и «показывать ПУ»
    // включались бы только через пять минут, когда кэш протухнет сам.
    if (gamesViewChanged) this.history.resetLastGames();
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









  /** userId игрока, если статистика его уже резолвила (иначе undefined). */
  /**
   * Порт модальных окон: диалоги живут отдельными модулями и получают ровно
   * то, чего им не хватает сверх модели данных.
   */
  private readonly modalPort: ModalPort = {
    model: this.model,
    toast: (message, warn) => this.toast(message, warn),
    registerModal: (close) => {
      this.closeOpenModal = close;
    },
    unregisterModal: (close) => {
      // Только СВОЮ регистрацию: иначе закрытие старого окна разрегистрирует
      // уже открытое новое, и disable() не позовёт его close().
      if (this.closeOpenModal === close) this.closeOpenModal = null;
    },
    closeOpenModal: () => this.closeOpenModal?.(),
    resolvePlayerInput: (input) => this.resolvePlayerInput(input),
    confirmRemoveCustomTag: (css) => this.confirmRemoveCustomTag(css),
    refreshColors: () => this.refreshNickColors(),
    refreshIndicators: () => this.refreshNoteIndicators(),
    refreshTags: () => this.refreshPlayerTags(),
    refreshPlayer: (username) => this.updatePlayerTooltips(username),
  };

  private showNoteModal(username: string): void {
    showNoteModal(this.modalPort, username);
  }

  /** Диалог «Цвета ников» — открывается из попапа. */
  openNickColorManager(): void {
    openNickColorManager(this.modalPort);
  }

  // ─────── Заметки: делегаты к ./player-notes/notes-model ───────
  //
  // Данные, очередь записи и правила сохранения живут в модели. Здесь —
  // тонкие делегаты: мест вызова десятки, и переписывать их все значило бы
  // рисковать поведением ради косметики.

  private loadNotes(): Promise<void> {
    return this.model.load();
  }

  private migrateNoteToId(username: string, userId: number | string): Promise<void> {
    return this.model.migrateToId(username, userId);
  }

  // ─────── Резолв ключа заметки (./player-notes/note-keys) ───────
  //
  // Сам слой живёт отдельным модулем и проверяется без DOM: ошибка здесь
  // показывает игроку ЧУЖУЮ заметку (блокер 8.1.29). Здесь — только тонкие
  // делегаты, чтобы места вызова читались как раньше.

  private noteUserId(username: string): number | string | undefined {
    return this.model.keys.userId(username);
  }

  private noteKeyFor(username: string): string {
    return this.model.keys.keyFor(username);
  }

  private getNote(username: string): NoteRecord | string | undefined {
    return this.model.keys.get(username);
  }

  private getNoteText(username: string): string {
    return this.model.keys.text(username);
  }

  private getFormerNicks(username: string): string[] {
    return this.model.keys.formerNicks(username);
  }

  private getNoteTag(username: string): string {
    return this.model.keys.tag(username);
  }

  /** Цвет ника для отрисовки: пустая строка, если фича выключена. */
  private getNickColor(username: string): string {
    if (this.settings.nick_colors_enabled === false) return "";
    return this.model.keys.rawNickColor(username);
  }

  /** Все легаси-ключи-ники этого игрока (точный + отличающиеся регистром). */
  private nickKeysFor(username: string): string[] {
    return this.model.keys.nickKeys(username);
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
    const nickEl = document.querySelector<HTMLElement>(SITE.profileNickname);
    const nick = nickEl?.textContent?.trim() || "";
    if (!nickEl || !nick) return;

    this.profileIdByNick.set(nick.toLowerCase(), id);

    // Цвет ника (учитывает nick_colors_enabled и приоритет id-записи).
    paintNickEl(nickEl, this.colorForPlayer(id, nick), nick);

    // Рамка метки вокруг аватара.
    const avatar = document.querySelector<HTMLElement>(SITE.profileAvatarImg);
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
    const index = buildNickColorIndex(this.model.notes);
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
    const items = document.querySelectorAll<HTMLAnchorElement>(SITE.participantsItem);
    if (items.length === 0) return;
    items.forEach((item) => {
      const nameWrap = item.querySelector<HTMLElement>(SITE.participantsName);
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
          this.model.keys.reset();
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

  // ─────────── Статистика игрока ───────────
  //
  // Загрузка, кэш и сборка цифр живут в ./player-notes/player-stats: этот
  // кластер владел пятью картами состояния, которые не нужны больше никому,
  // а сами ЧИСЛА про человека теперь проверяются без живого стола.

  private loadPlayerStats(username: string): Promise<void> {
    return this.stats.load(username);
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
    const stats: PlayerStatsEntry = this.stats.get(username) || {
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
      // Снимаем маркер показа: иначе поздний рендер (прогресс «ПУ»,
      // пересечения) видел pnShown === "1" и ПРИКЛЕИВАЛ удалённый тултип
      // обратно в body — призрак в углу (adversarial 27.08.2026).
      delete tooltip.dataset.pnShown;
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
      const stats = this.stats.get(username);
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
        this.tileMedia.setFlipped(uname, flipped);
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

  /**
   * Восстановить переворот камеры после того, как сайт пересоздал video
   * (смена дня/ночи, переподключение камеры). Идемпотентно: у перевёрнутого
   * video стоит dataset.flipped, и повторного захода не будет; у свежего
   * элемента флага нет — переворачиваем один раз.
   */
  private ensureFlipState(container: Element, username: string): void {
    if (this.settings.camera_rotate_enabled === false) return;
    if (!this.tileMedia.isFlipped(username)) return;
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
      if (this.tileMedia.toggleHidden(uname)) {
        videoEl.style.display = "none";
        videoEl.dataset.polemicaHidden = "true";
      } else {
        videoEl.style.display = "";
        delete videoEl.dataset.polemicaHidden;
      }
      this.syncHideVideoButton(button, username);
    });
    this.applyButtonTheme(button);
    this.syncHideVideoButton(button, username);
    return button;
  }

  private syncHideVideoButton(button: HTMLElement, username: string): void {
    const opacity = this.tileMedia.isHidden(username) ? "1" : "0.7";
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
      this.tileMedia.toggleMute(uname);
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
    const muted = this.tileMedia.isMuted(username);
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
    const wantMute = muteActive && this.tileMedia.isMuted(username);
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
    const key = username.toLowerCase();
    const paintGames = (games: LastGameEntry[] | null): void => {
      if (tooltip.dataset.pnShown !== "1") return;
      tooltip.innerHTML =
        games === null
          ? "Не удалось загрузить историю игр"
          : games.length > 0
            ? this.formatGamesHistory(games)
            : "Нет данных о последних играх";
      this.showTooltip(tooltip, button);
    };
    const load = async (): Promise<void> => {
      const games = await this.history.getLastGames(username);
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
      // Дорисовка «ПУ» по мере готовности разборов (п.4): пока тултип открыт,
      // он подписан на обновление того же списка.
      this.history.watchProgress(key, paintGames);
      // Готовый список — мгновенно (п.6): 350 мс намерения нужны только
      // перед ЕЩЁ НЕ начатыми дорогими запросами.
      const ready = this.history.peekLastGames(username);
      if (ready) {
        // Сначала ПОКАЗАТЬ, потом красить: paintGames молчит при скрытом
        // тултипе (страж записи в невидимый DOM), и кэш-хит рисовал пустоту
        // — поймано тестом «кэш-хит рисуется синхронно».
        tooltip.innerHTML =
          ready.length > 0 ? this.formatGamesHistory(ready) : "Нет данных о последних играх";
        this.showTooltip(tooltip, button);
        return;
      }
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
      this.history.unwatchProgress(key);
      this.hideTooltip(tooltip);
    });

    button.appendChild(tooltip);
    this.tooltipAnchors.set(tooltip, button);
    this.applyButtonTheme(button);
    return button;
  }

  // ─────────── Модалка заметок ───────────


  // ─────────── Менеджер цветов ников ───────────


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
    for (const [k, v] of Object.entries(this.model.notes)) {
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
    const used = this.model.countTagUsages(css);
    const tail = used
      ? `\n\nИгроков с этим цветом: ${used}. Их цвет останется как есть — из палитры пропадёт только заготовка.`
      : "";
    return window.confirm(`Удалить свой цвет из палитры?${tail}`);
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
    const stats = this.stats.get(key);
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

  // ─────────── История игр (./player-notes/history-store) ───────────
  //
  // Кэши пересечений и последних игр, дедуп запросов, ночной прогрев и
  // правило «ошибка ≠ игр нет» живут отдельным модулем: это восемь полей
  // состояния, не нужных больше никому в фиче. Здесь остаётся ОТРИСОВКА.

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
    const paint = (data: Crossover | null | undefined): void => {
      if (tooltip.dataset.pnShown !== "1") return;
      tooltip.innerHTML =
        data === undefined
          ? "Не удалось определить твой профиль — открой страницу поиска игры, и он запомнится"
          : data === null
            ? "Не удалось посчитать пересечения"
            : formatCrossover(data);
      this.showTooltip(tooltip, button);
    };
    button.addEventListener("mouseenter", () => {
      // Готовая ПОЛНАЯ сводка — мгновенно, без «Загрузка…» и без намерения
      // (замер 27.08.2026, п.2: повторный ховер платил 350 мс ни за что).
      const ready = this.history.peekCrossover(username);
      if (ready) {
        tooltip.innerHTML = formatCrossover(ready);
        this.showTooltip(tooltip, button);
        return;
      }
      // Мелкая сводка ночного прогрева — показываем СРАЗУ (в ней уже стоит
      // честная пометка «учтён доступный отрезок»), а точную докачиваем
      // после намерения и дорисовываем поверх (п.3).
      const shallow = this.history.peekShallowCrossover(username);
      tooltip.innerHTML = shallow ? formatCrossover(shallow) : "Загрузка...";
      this.showTooltip(tooltip, button);
      // Задержка намерения: точная сводка стоит двух историй, и курсор,
      // мазнувший по столу, не должен поднимать десяток таких пар.
      intent = setTimeout(() => {
        intent = null;
        void this.history.getCrossover(username).then(paint);
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
      this.history.pumpWarm(names);
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
    if (this.tileMedia.isHidden(uname)) {
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
