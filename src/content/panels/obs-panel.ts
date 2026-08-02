/**
 * Фича: плавающая панель управления сценами OBS на странице игры
 * + авто-переключение сцен день/ночь по анализу DOM-стадий.
 *
 * Порт obs-floating-panel.js в новую TS-архитектуру.
 *
 * Состоит из двух частей:
 *  • ObsPanel  — UI-панель на базе FloatingPanel (список сцен, статус, клик-переключение).
 *  • obsPanelFeature — Feature: жизненный цикл, авто-режим день/ночь, OBS-messaging.
 *
 * Команды OBS идут в background через sendRuntime({type:"obs_command", ...}),
 * события OBS приходят через onMessage (obs_event).
 *
 * Авто-настройки сцен (obs_auto_mode_enabled / obs_day_scene / obs_night_scene)
 * берутся из ctx.settings. Позицию/размер панели persist'ит сам FloatingPanel
 * (storageKey "obs-panel"); состояние авто-сцены — в browser.storage.local
 * (ключ obs_auto_scene_state).
 *
 * settingKey: "obs_floating_panel_enabled".
 */
import { FloatingPanel } from "@core/FloatingPanel";
import { onDomChange } from "@core/dom";
import { browser } from "@core/env";
import { log } from "@core/log";
import { onMessage, sendRuntime } from "@core/messaging";
import {
  SITE,
  classifyPhaseText,
  endedScreenVisible,
  matchFinishedVisible,
} from "@core/selectors";
import { isGameRoomPath } from "@shared/routes";
import type { Feature, FeatureContext } from "@core/feature";
import type { ObsConnectionState, ObsScene } from "@shared/types";

const SCOPE = "obs-panel";
const OBS_STATE_MAX_AGE_MS = 2 * 60_000;

type TimeOfDay = "day" | "night";
type ConnStatus = "default" | "connected" | "error";

interface AutoSceneState {
  sessionId: string | null;
  currentTimeOfDay: TimeOfDay | null;
  lastAppliedRoleVisibility: string | null;
  timestamp: number;
}

// ─────────────────────────── вспомогательные функции DOM ───────────────────────────

function norm(el: { textContent?: string | null } | null | undefined): string {
  return (el?.textContent || "").toLowerCase();
}

/**
 * Ведёт ли ЭТА вкладка автосцену прямо сейчас — ответ на пинг владения.
 *
 * Чистая функция с явными входами: предикат из четырёх условий, и в нём уже
 * была ошибка (отвечали по одной настройке, а она остаётся включённой до
 * закрытия вкладки — вкладка с доигранным матчем держала сцену до 20 минут).
 *
 * `phaseKnown` — «я в этой вкладке уже определял фазу», а не «на странице
 * сейчас видно 10 плиток»: сайт пересобирает плитки на КАЖДОЙ смене фазы, и
 * пинг, прилетевший ровно в этот кадр, отнял бы владение у настоящего эфира
 * (ревью 02.08.2026).
 */
export function drivesAutoScene(input: {
  autoModeOn: boolean;
  pathname: string;
  phaseKnown: boolean;
  matchFinished: boolean;
}): boolean {
  return (
    input.autoModeOn &&
    isGameRoomPath(input.pathname) &&
    input.phaseKnown &&
    !input.matchFinished
  );
}

/** Есть ли на странице активный игровой интерфейс (≥10 игроков/камер + контролы). */
function hasActiveGameInterface(): boolean {
  const playerCount = document.querySelectorAll(SITE.playerDesktop).length;
  const webcamCount = document.querySelectorAll(SITE.playerVideo).length;
  const gameControlCount = document.querySelectorAll(SITE.obsGameControls).length;

  return (
    (playerCount >= 10 || webcamCount >= 10 || (playerCount >= 8 && webcamCount >= 8)) &&
    gameControlCount > 0
  );
}

// ─────────────────────────── UI-панель ───────────────────────────

class ObsPanel extends FloatingPanel {
  private statusEl: HTMLElement | null = null;
  private scenesEl: HTMLElement | null = null;
  private scenes: ObsScene[] = [];
  private currentScene: string | null = null;
  /** Вызывается панелью при клике по сцене. */
  onSceneClick: ((sceneName: string) => void) | null = null;
  /** Вызывается при клике по кнопке закрытия. */
  onClose: (() => void) | null = null;

  constructor() {
    super({
      storageKey: "obs-panel",
      title: "OBS Scenes",
      width: 280,
      height: 220,
      minWidth: 240,
      minHeight: 160,
      resizable: true,
      className: "obs-floating-panel",
    });
  }

  protected renderBody(body: HTMLElement): void {
    // Кнопка закрытия в заголовке (отключает настройку плавающей панели).
    this.addHeaderButton(
      "×",
      () => {
        this.onClose?.();
      },
      "Закрыть",
    );

    const status = document.createElement("div");
    status.className = "obs-connection-status";
    status.textContent = "Подключение...";
    Object.assign(status.style, {
      textAlign: "center",
      padding: "6px 8px",
      borderRadius: "8px",
      fontSize: "12px",
      marginBottom: "8px",
      background: "rgba(0,0,0,.12)",
      color: "rgba(255,255,255,.65)",
    } as CSSStyleDeclaration);

    const scenes = document.createElement("div");
    scenes.className = "obs-scenes-container";
    Object.assign(scenes.style, {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
    } as CSSStyleDeclaration);

    body.append(status, scenes);

    this.statusEl = status;
    this.scenesEl = scenes;

    this.renderScenes();
  }

  setConnectionStatus(text: string, status: ConnStatus = "default"): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    const muted = status === "default" ? "rgba(255,255,255,.65)" : "rgba(255,255,255,.85)";
    this.statusEl.style.color = muted;
  }

  setScenes(scenes: ObsScene[], currentScene: string | null): void {
    this.scenes = scenes || [];
    this.currentScene = currentScene;
    this.renderScenes();
  }

  setCurrentScene(currentScene: string | null): void {
    this.currentScene = currentScene;
    this.updateHighlight();
  }

  private updateHighlight(): void {
    if (!this.scenesEl) return;
    this.scenesEl.querySelectorAll<HTMLElement>(".obs-scene-item").forEach((item) => {
      const active = item.dataset.scene === this.currentScene;
      item.style.background = active ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.12)";
      item.style.fontWeight = active ? "600" : "400";
    });
  }

  private renderScenes(): void {
    if (!this.scenesEl) return;
    this.scenesEl.innerHTML = "";

    if (!this.scenes || this.scenes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "obs-no-scenes";
      empty.textContent = "Нет доступных сцен";
      Object.assign(empty.style, {
        textAlign: "center",
        color: "rgba(255,255,255,.55)",
        fontSize: "12px",
        padding: "20px",
        fontStyle: "italic",
      } as CSSStyleDeclaration);
      this.scenesEl.appendChild(empty);
      return;
    }

    this.scenes.forEach((scene) => {
      const item = document.createElement("div");
      item.className = "obs-scene-item";
      item.dataset.scene = scene.sceneName;
      const active = scene.sceneName === this.currentScene;
      Object.assign(item.style, {
        padding: "7px 10px",
        background: active ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.12)",
        borderRadius: "8px",
        cursor: "pointer",
        fontWeight: active ? "600" : "400",
      } as CSSStyleDeclaration);

      const name = document.createElement("span");
      name.className = "obs-scene-name";
      name.textContent = scene.sceneName;
      item.appendChild(name);

      item.addEventListener("click", () => {
        this.onSceneClick?.(scene.sceneName);
      });

      this.scenesEl!.appendChild(item);
    });
  }
}

// ─────────────────────────── состояние авто-режима ───────────────────────────

let panel: ObsPanel | null = null;

let autoModeEnabled = false;
/** Показ плавающей панели (obs_floating_panel_enabled). Автомод от неё не зависит. */
let panelEnabled = false;
let dayScene = "";
let nightScene = "";

let scenes: ObsScene[] = [];
let currentScene: string | null = null;
let obsSessionId: string | null = null;

let currentTimeOfDay: TimeOfDay | null = null;
let lastAppliedRoleVisibility: string | null = null;
const roleVisibilityDelayMs = 3000;
/**
 * Реестр изменённых нами элементов ролей.
 *
 * Set, а не только WeakMap: WeakMap нельзя обойти, поэтому при выключении
 * авто-режима мы не могли вернуть исходные стили — роль оставалась скрытой
 * (или наоборот, принудительно показанной) до перерисовки страницы сайтом
 * (аудит lifecycle 01.08.2026, находка 7). Храним и приоритет: мы пишем
 * !important, и «просто снять значение» недостаточно.
 */
interface RoleStyleSnapshot {
  visibility: string;
  visibilityPriority: string;
  opacity: string;
  opacityPriority: string;
  pointerEvents: string;
  pointerEventsPriority: string;
}
const roleVisibilityState = new WeakMap<HTMLElement, RoleStyleSnapshot>();
const touchedRoleElements = new Set<HTMLElement>();

/** Вернуть роли ровно те inline-стили (и приоритеты), что были до нас. */
function restoreRoleVisibility(): void {
  for (const el of touchedRoleElements) {
    const snap = roleVisibilityState.get(el);
    if (!snap) continue;
    restoreProp(el, "visibility", snap.visibility, snap.visibilityPriority);
    restoreProp(el, "opacity", snap.opacity, snap.opacityPriority);
    restoreProp(el, "pointer-events", snap.pointerEvents, snap.pointerEventsPriority);
    roleVisibilityState.delete(el);
  }
  touchedRoleElements.clear();
  lastAppliedRoleVisibility = null;
}

function restoreProp(el: HTMLElement, prop: string, value: string, priority: string): void {
  el.style.removeProperty(prop);
  if (value) el.style.setProperty(prop, value, priority || "");
}

// Таймеры/подписки (всё должно быть снято в disable()).
let unsubMessage: (() => void) | null = null;
let unsubDom: (() => void) | null = null;
let gameUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;

let timeOfDayCheckDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Страховочный редкий опрос фазы (см. startDOMMonitoring). */
let timeOfDayFallbackTimer: ReturnType<typeof setInterval> | null = null;
let timeOfDayCheckQueued = false;
let pendingTimeOfDay: TimeOfDay | null = null;
let pendingTimeOfDayConfirmTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRoleVisibilityTimer: ReturnType<typeof setTimeout> | null = null;

let isVisible = false;

// ─────────────────────────── OBS-команды (через background) ───────────────────────────

async function obsCommand(
  command: "get_status" | "set_scene",
  data?: { sceneName?: string; manual?: boolean },
): Promise<any> {
  return sendRuntime<any>({ type: "obs_command", command, data });
}

/**
 * Переключить сцену. manual=true — это КЛИК ПОЛЬЗОВАТЕЛЯ в панели: такая
 * команда проходит мимо проверки владельца автосцены и забирает владение
 * этой вкладке.
 */
async function switchScene(sceneName: string, manual = false): Promise<boolean> {
  const response = await obsCommand("set_scene", { sceneName, manual });
  // Отказ по владению приходит как success с data.ignored: сцену НЕ трогали,
  // поэтому ни currentScene, ни подсветку обновлять нельзя — иначе панель
  // показывала бы сцену, которой в OBS нет, а автопуть переставал бы
  // повторять попытки (ревью пакета D, блокер).
  if (response?.success && response.data?.ignored === "not_owner") {
    log.info(SCOPE, "смена сцены отклонена: автосценой владеет другая вкладка игры");
    return false;
  }
  if (response && response.success) {
    // Именно sceneName: раньше сюда передавалась модульная currentScene,
    // т.е. подсвечивалась ПРОШЛАЯ сцена, а не только что установленная.
    currentScene = sceneName;
    panel?.setCurrentScene(sceneName);
    return true;
  } else {
    log.error(SCOPE, "Failed to switch scene", response?.error);
    throw new Error(response?.error || "Unknown error");
  }
}

async function requestOBSStatus(): Promise<void> {
  try {
    const response = await obsCommand("get_status");
    if (response && response.success) {
      const status = response.data;
      if (status && status.connected) {
        panel?.setConnectionStatus("Подключено", "connected");
        scenes = status.scenes || [];
        currentScene = status.currentScene ?? null;
        panel?.setScenes(scenes, currentScene);
      } else {
        panel?.setConnectionStatus("Не подключено", "error");
        scenes = [];
        currentScene = null;
        panel?.setScenes(scenes, currentScene);
      }
    } else {
      panel?.setConnectionStatus("Ошибка подключения", "error");
    }
  } catch (e) {
    log.error(SCOPE, "Failed to request OBS status", e);
    panel?.setConnectionStatus("Ошибка", "error");
  }
}

// ─────────────────────────── persist состояния авто-сцены ───────────────────────────

async function getStoredConnectionState(): Promise<ObsConnectionState | null> {
  try {
    const res = await browser.storage.local.get(["obs_connection_state"]);
    const state = (res as { obs_connection_state?: ObsConnectionState }).obs_connection_state;
    if (!state || !Number.isFinite(state.timestamp)) return null;
    if (Date.now() - state.timestamp > OBS_STATE_MAX_AGE_MS) return null;
    return state;
  } catch (e) {
    log.error(SCOPE, "Failed to load OBS connection state", e);
    return null;
  }
}

async function savePersistedAutoState(): Promise<void> {
  if (!autoModeEnabled || !currentTimeOfDay) return;

  try {
    if (!obsSessionId) {
      const connectionState = await getStoredConnectionState();
      obsSessionId = connectionState?.sessionId || null;
    }
    if (!obsSessionId) return;

    const state: AutoSceneState = {
      sessionId: obsSessionId,
      currentTimeOfDay,
      lastAppliedRoleVisibility,
      timestamp: Date.now(),
    };
    await browser.storage.local.set({ obs_auto_scene_state: state });
  } catch (e) {
    log.error(SCOPE, "Failed to save OBS auto scene state", e);
  }
}

async function clearPersistedAutoState(resetRuntimeState = false): Promise<void> {
  try {
    await browser.storage.local.remove("obs_auto_scene_state");
  } catch (e) {
    log.error(SCOPE, "Failed to clear OBS auto scene state", e);
  }

  if (resetRuntimeState) {
    if (pendingRoleVisibilityTimer) {
      clearTimeout(pendingRoleVisibilityTimer);
      pendingRoleVisibilityTimer = null;
    }
    obsSessionId = null;
    currentTimeOfDay = null;
    lastAppliedRoleVisibility = null;
  }
}

async function restorePersistedAutoState(status: any = null): Promise<boolean> {
  if (!autoModeEnabled) return false;

  try {
    const resolvedStatus = status || (await getStoredConnectionState());
    if (!resolvedStatus?.connected || !resolvedStatus.sessionId) return false;

    obsSessionId = resolvedStatus.sessionId;
    currentScene = resolvedStatus.currentScene || currentScene;
    scenes = resolvedStatus.scenes || scenes;

    const res = await browser.storage.local.get(["obs_auto_scene_state"]);
    const stored = (res as any).obs_auto_scene_state as AutoSceneState | undefined;
    if (!stored || stored.sessionId !== obsSessionId || !stored.currentTimeOfDay) return false;

    currentTimeOfDay = stored.currentTimeOfDay;
    lastAppliedRoleVisibility = stored.lastAppliedRoleVisibility || null;

    const applied = applyRoleVisibility(currentTimeOfDay === "night");
    if (!applied) scheduleRoleVisibility(currentTimeOfDay, 1);

    await autoSwitchScene(currentTimeOfDay);
    log.debug(SCOPE, "Restored persisted OBS auto scene state", stored);
    return true;
  } catch (e) {
    log.error(SCOPE, "Failed to restore OBS auto scene state", e);
    return false;
  }
}

// ─────────────────────────── видимость своей роли ───────────────────────────

function getRoleVisibilityTargets(): HTMLElement[] {
  const targets: HTMLElement[] = [];
  const seen = new Set<Element>();
  SITE.ownRoleTargets.forEach((selector) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      targets.push(el);
    });
  });
  return targets;
}

function applyRoleVisibility(isRoleVisible: boolean): boolean {
  // Ветка window.showOwnRole/hideOwnRole удалена: эти функции нигде не
  // определялись (наследие legacy page-script), в изолированном мире
  // content-скрипта их не существует — ветка была мертва всегда.

  const targets = getRoleVisibilityTargets();
  if (targets.length === 0) {
    log.debug(SCOPE, "Role visibility targets not found, skipping role update");
    return false;
  }

  targets.forEach((element) => {
    if (!roleVisibilityState.has(element)) {
      roleVisibilityState.set(element, {
        visibility: element.style.visibility,
        visibilityPriority: element.style.getPropertyPriority("visibility"),
        opacity: element.style.opacity,
        opacityPriority: element.style.getPropertyPriority("opacity"),
        pointerEvents: element.style.pointerEvents,
        pointerEventsPriority: element.style.getPropertyPriority("pointer-events"),
      });
    }
    touchedRoleElements.add(element);
    // Сайт пересобирает плитки на каждой смене фазы: без уборки реестр
    // держал бы сильные ссылки на отсоединённые поддеревья (ревью пакета C).
    for (const tracked of touchedRoleElements) {
      if (!tracked.isConnected) touchedRoleElements.delete(tracked);
    }

    const originalState = roleVisibilityState.get(element)!;
    if (isRoleVisible) {
      // Восстановление через setProperty(...,"important"): auto-start при
      // включённом авто-скрытии держит СВОЙ <style> c !important, и обычный
      // inline-показ ему проигрывал — роль ночью не показывалась никогда.
      // Inline !important сильнее любого stylesheet !important.
      setImportant(element, "visibility", originalState.visibility || "visible");
      setImportant(element, "opacity", originalState.opacity || "1");
      element.style.pointerEvents = originalState.pointerEvents;
    } else {
      setImportant(element, "visibility", "hidden");
      setImportant(element, "opacity", "0");
      element.style.pointerEvents = "none";
    }
  });

  const previous = lastAppliedRoleVisibility;
  lastAppliedRoleVisibility = isRoleVisible ? "visible" : "hidden";
  // info на СМЕНЕ состояния (несколько раз за игру): без неё в файле не видно,
  // была ли роль реально скрыта перед дневной сценой, и успешное переключение
  // сцены создавало ложное ощущение полного успеха (OP-1).
  if (previous !== lastAppliedRoleVisibility) {
    log.info(
      SCOPE,
      isRoleVisible ? "роль показана для ночной фазы" : "роль скрыта для дневной фазы",
    );
  }
  return true;
}

function setImportant(el: HTMLElement, prop: string, value: string): void {
  if (value) el.style.setProperty(prop, value, "important");
  else el.style.removeProperty(prop);
}

function scheduleRoleVisibility(timeOfDay: TimeOfDay, attempt = 0): void {
  const shouldShowRoles = timeOfDay === "night";
  const targetVisibility = shouldShowRoles ? "visible" : "hidden";

  if (pendingRoleVisibilityTimer) {
    clearTimeout(pendingRoleVisibilityTimer);
    pendingRoleVisibilityTimer = null;
  }

  if (lastAppliedRoleVisibility === targetVisibility) {
    log.debug(SCOPE, "Role visibility already set to", targetVisibility);
    return;
  }

  const delayMs = shouldShowRoles
    ? attempt === 0
      ? roleVisibilityDelayMs
      : 500
    : attempt === 0
      ? 0
      : 250;
  log.debug(SCOPE, "Scheduling role visibility change to", targetVisibility, "in", delayMs);
  pendingRoleVisibilityTimer = setTimeout(() => {
    pendingRoleVisibilityTimer = null;
    const applied = applyRoleVisibility(shouldShowRoles);
    if (applied) return;
    if (attempt < 5) {
      scheduleRoleVisibility(timeOfDay, attempt + 1);
      return;
    }
    // Терминальный исход: дальше попыток не будет. Без этой строки в файле
    // оставалась тишина, неотличимая от «всё получилось» (OP-1).
    log.warn(
      SCOPE,
      "видимость роли не подтверждена после",
      attempt + 1,
      "попыток; требуемое состояние:",
      targetVisibility,
    );
  }, delayMs);
}

async function hideRoleBeforeDaySceneSwitch(): Promise<void> {
  if (pendingRoleVisibilityTimer) {
    clearTimeout(pendingRoleVisibilityTimer);
    pendingRoleVisibilityTimer = null;
  }
  const hidden = applyRoleVisibility(false);
  if (!hidden) {
    // Латч «скрыто» здесь НЕ ставим. Раньше он ставился безусловно, и
    // retry-машина считала работу сделанной: роль оставалась на экране, а
    // сцена переключалась — в логе это выглядело полным успехом, хотя роль
    // могла уехать в эфир (аудит наблюдаемости 02.08.2026, OP-1).
    log.warn(
      SCOPE,
      "роль НЕ скрыта перед дневной сценой: элементы роли не найдены;",
      "сцена переключается в ухудшенном режиме, повторяем скрытие",
    );
    scheduleRoleVisibility("day");
  }
  // Дать DOM перерисовать скрытое состояние перед переключением сцены OBS.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

// ─────────────────────────── определение времени суток ───────────────────────────

/**
 * Текст самого глубокого элемента, содержащего фразу (или "" если её нет).
 *
 * Раньше тут был querySelectorAll("*") с чтением textContent каждого узла —
 * квадратичный проход по всему документу на каждой проверке времени суток.
 * Спуск по дереву даёт тот же результат за O(глубина × братья).
 */
function findDeepestTextWith(root: Element, phrase: string): string {
  let node = root;
  if (!norm(node).includes(phrase)) return "";
  for (;;) {
    const child = Array.from(node.children).find((c) => norm(c).includes(phrase));
    if (!child) return norm(node);
    node = child;
  }
}

function getStageContainer(): Element | null {
  const stages = Array.from(document.querySelectorAll(SITE.stage));
  if (stages.length === 0) return null;
  let container: Element = stages[0].parentElement || stages[0];
  while (
    container.parentElement &&
    container.parentElement !== document.body &&
    !stages.every((stage) => container.contains(stage))
  ) {
    container = container.parentElement;
  }
  // Таймер обычно сосед списка стадий, поэтому берём один общий уровень выше,
  // но никогда не поднимаемся до body.
  return container.parentElement && container.parentElement !== document.body
    ? container.parentElement
    : container;
}

/**
 * Определяет время суток на основе DOM элементов страницы игры.
 * RU-логика сохранена из obs-floating-panel.js; EN-маркеры — best-effort.
 */
/**
 * Фазу не распознали в ЭТОМ вызове (взводится внутренним детектором).
 * Вынесено из детектора наружу: у него полтора десятка точек возврата, и
 * различать «распознали» и «оставили прежнее» надо в одном месте.
 */
let autoSettingsInitialized = false;
let phaseUnknownHit = false;
/** С какого момента длится «фазу не понимаем» (0 — понимаем). */
let phaseUnknownSince = 0;
/** Про это непонимание уже пожаловались (чтобы не повторяться). */
let phaseUnknownReported = false;
/**
 * Сколько терпим непонимание, прежде чем жаловаться.
 *
 * Комната первые 1.5-2.5 с рисует ТРИ ПУСТЫХ `.substage` (массив substages в
 * data фиксирован, текст берётся из ещё не пришедшей стадии), а детектор ходит
 * раз в 2 с. Без порога совершенно здоровый старт давал бы `warn` в каждой
 * вкладке при каждой загрузке — а `warn` поддержка грепает первым (ревью
 * 02.08.2026). Порог заодно прикрывает промахи в момент перерисовки роллера.
 */
const PHASE_UNKNOWN_GRACE_MS = 8000;

function detectTimeOfDay(): TimeOfDay {
  phaseUnknownHit = false;
  const result = detectTimeOfDayInner();
  if (phaseUnknownHit) {
    if (!phaseUnknownSince) {
      phaseUnknownSince = Date.now();
    } else if (!phaseUnknownReported && Date.now() - phaseUnknownSince > PHASE_UNKNOWN_GRACE_MS) {
      phaseUnknownReported = true;
      log.warn(
        SCOPE,
        "фаза игры не распознана дольше",
        `${Math.round(PHASE_UNKNOWN_GRACE_MS / 1000)} с:`,
        "ни один маркер стадии не подошёл; сохраняем прежнюю сцену —",
        result,
      );
    }
  } else if (phaseUnknownSince) {
    // О восстановлении говорим только если жаловались: иначе здоровый старт
    // порождал бы пару строк на ровном месте.
    if (phaseUnknownReported) {
      log.info(
        SCOPE,
        "фаза снова распознаётся:",
        result,
        `(не понимали ${Math.round((Date.now() - phaseUnknownSince) / 1000)} с)`,
      );
    }
    phaseUnknownSince = 0;
    phaseUnknownReported = false;
  }
  return result;
}

function detectTimeOfDayInner(): TimeOfDay {
  try {
    // 1. Терминальный экран (.ended): промах, победа любой из сторон, пауза.
    // Сайт перед gameOver стартует день, но фазовых маркеров на этом экране
    // нет — раньше побеждала «память» и OBS оставался на ночной сцене после
    // ночной победы (аудит устойчивости 01.08.2026, находка 5).
    if (endedScreenVisible()) {
      log.debug(SCOPE, "Detected ENDED screen - forcing DAY scene");
      return "day";
    }

    // 2. Ищем надпись "До смены этапа"
    const stageContainer = getStageContainer();
    // EN — best-effort, не проверено на живом EN-интерфейсе.
    let stageChangeText = stageContainer
      ? findDeepestTextWith(stageContainer, "до смены этапа") ||
        findDeepestTextWith(stageContainer, "until stage change")
      : "";
    // Страховка: эвристика контейнера («таймер — сосед списка стадий») —
    // предположение о вёрстке. При промахе возвращаемся к проверенному в бою
    // поиску от body: это старая цена ОДНОЙ проверки, зато ночь не будет
    // молча пропущена, если сайт разложил таймер иначе.
    if (!stageChangeText) {
      stageChangeText =
        findDeepestTextWith(document.body, "до смены этапа") ||
        findDeepestTextWith(document.body, "until stage change");
    }

    if (stageChangeText) {
      const nextStage = document.querySelector(SITE.substageNext);
      if (nextStage) {
        const nextStageText = norm(nextStage);
        log.debug(SCOPE, 'Found "До смены этапа", next stage:', nextStageText);

        // Общий классификатор вместо локальных списков: прежний список
        // проверял «голосование» ПЕРВЫМ, и next «Ночь | Голосование мафии»
        // возвращал день прямо на входе в ночь. RU «промах»/«лучший ход»
        // classify не знает (в TEXT.day только EN-варианты) — оставлены
        // явными дневными спецслучаями.
        const nextPhase = classifyPhaseText(nextStageText);
        if (
          nextPhase === "day" ||
          nextStageText.includes("промах") ||
          nextStageText.includes("лучший ход")
        ) {
          log.debug(SCOPE, "Detected DAY via next stage:", nextStageText);
          return "day";
        }
        if (nextPhase === "night") {
          log.debug(SCOPE, "Detected NIGHT via next stage:", nextStageText);
          return "night";
        }
      }

      if (
        /до смены этапа \d+ сек/.test(stageChangeText) ||
        /until stage change.*\d+\s*(?:s|sec|seconds?)/.test(stageChangeText)
      ) {
        const currentSubstage = document.querySelector(SITE.substageCurrent);
        if (currentSubstage) {
          const currentText = norm(currentSubstage);
          if (currentText.includes("ночь") || currentText.includes("night")) {
            log.debug(SCOPE, 'Detected NIGHT via "До смены этапа" with timer and night substage');
            return "night";
          }
        }
      }
    }

    // Изолированная "Ночь" без "ДО СМЕНЫ ЭТАПА" — игнорируем, остаёмся в текущем времени
    const currentSubstage = document.querySelector(SITE.substageCurrent);
    if (currentSubstage) {
      const currentText = norm(currentSubstage);
      if (currentText.trim() === "ночь" || currentText.trim() === "night") {
        const fallbackTime = currentTimeOfDay || "day";
        log.debug(
          SCOPE,
          'Found isolated "Ночь" in subtext without "ДО СМЕНЫ ЭТАПА" - keeping',
          fallbackTime.toUpperCase(),
        );
        return fallbackTime;
      }
    }

    // 3. Голосование с "Итоги подъема" — всегда ДЕНЬ
    const votingStage = document.querySelector(SITE.stage);
    const votingResultsSubstage = document.querySelector(SITE.substageCurrent) ||
      document.querySelector(SITE.stage);
    if (votingStage && votingResultsSubstage) {
      const votingText = norm(votingStage);
      const substageText = norm(votingResultsSubstage);
      if (
        (votingText.includes("голосование") ||
          votingText.includes("итоги подъема") ||
          votingText.includes("voting")) &&
        (substageText.includes("итоги подъема") || substageText.includes("results"))
      ) {
        log.debug(SCOPE, "Detected DAY: Голосование с итогами подъема");
        return "day";
      }
    }

    // 5. Текущая стадия игры (без "До смены этапа")
    const currentStage = document.querySelector(SITE.substageCurrent);
    if (currentStage) {
      const stageText = norm(currentStage);

      if (
        stageText.includes("раздача карт") ||
        stageText.includes("card deal") ||
        stageText.includes("dealing")
      ) {
        log.debug(SCOPE, "Detected NIGHT: Раздача карт");
        return "night";
      }

      const nightStages = ["ночь | знакомство мафии", "ночь | ход мафии", "ночь | проверки"];
      for (const nightStage of nightStages) {
        if (stageText.includes(nightStage)) {
          log.debug(SCOPE, "Detected NIGHT stage:", nightStage);
          return "night";
        }
      }

      // Общий классификатор (selectors.ts): «Ночь | Голосование мафии»
      // раньше проваливалась в дневную ветку по слову «голос» — дневная
      // сцена OBS включалась посреди хода мафии.
      const currentPhase = classifyPhaseText(stageText);
      if (currentPhase === "night") {
        log.debug(SCOPE, "Detected NIGHT stage via marker");
        return "night";
      }

      if (stageText.includes("день | речь игрока") || currentPhase === "day") {
        log.debug(SCOPE, "Detected DAY stage via marker");
        return "day";
      }
    }

    // 6. Fallback: все стадии
    const allStages = document.querySelectorAll(SITE.stage);
    let hasAnyNightStage = false;
    let hasAnyDayStage = false;
    allStages.forEach((stage) => {
      const stageText = norm(stage);
      const isSubstage = stage.classList.contains("substage");
      const isIsolatedNight =
        isSubstage && (stageText.trim() === "ночь" || stageText.trim() === "night");

      const phase = classifyPhaseText(stageText);
      if (phase === "night" && !isIsolatedNight) {
        hasAnyNightStage = true;
      }
      if (phase === "day" || stageText.includes("итоги подъема")) {
        hasAnyDayStage = true;
      }
    });

    // При обоих флагах (статичный список всех стадий) — день: это проверенный
    // в бою тай-брейк из auto-start; приоритет ночи здесь давал ложную ночь.
    if (hasAnyNightStage && !hasAnyDayStage) {
      log.debug(SCOPE, "Detected NIGHT via any night stage found");
      return "night";
    }
    if (hasAnyDayStage) {
      log.debug(SCOPE, "Detected DAY via any day stage found");
      return "day";
    }

    const fallbackTime = currentTimeOfDay || "day";
    // Ни один маркер не подошёл: сообщит обёртка, по фронту состояния. Иначе
    // после «слежение запущено» в файле идёт тишина, одинаковая и для здоровой
    // стабильной фазы, и для мёртвого наблюдателя, и для съехавшей разметки
    // сайта (аудит наблюдаемости 02.08.2026, OP-2).
    phaseUnknownHit = true;
    log.debug(SCOPE, "No specific stage detected - keeping", fallbackTime.toUpperCase());
    return fallbackTime;
  } catch (e) {
    log.error(SCOPE, "Error detecting time of day", e);
    phaseUnknownHit = true;
    return currentTimeOfDay || "day";
  }
}

function requestTimeOfDayCheck(): void {
  if (!autoModeEnabled) return;

  if (timeOfDayCheckDebounceTimer) {
    timeOfDayCheckQueued = true;
    return;
  }

  timeOfDayCheckDebounceTimer = setTimeout(() => {
    timeOfDayCheckDebounceTimer = null;
    void evaluateTimeOfDay();
    if (timeOfDayCheckQueued) {
      timeOfDayCheckQueued = false;
      requestTimeOfDayCheck();
    }
  }, 150);
}

function evaluateTimeOfDay(): void {
  const newTimeOfDay = detectTimeOfDay();
  const previousTimeOfDay = currentTimeOfDay;

  log.debug(SCOPE, "Time-of-day result:", newTimeOfDay, "(previous:", previousTimeOfDay, ")");

  if (newTimeOfDay === previousTimeOfDay) {
    pendingTimeOfDay = null;
    if (pendingTimeOfDayConfirmTimer) {
      clearTimeout(pendingTimeOfDayConfirmTimer);
      pendingTimeOfDayConfirmTimer = null;
    }
    return;
  }

  if (pendingTimeOfDay !== newTimeOfDay) {
    pendingTimeOfDay = newTimeOfDay;

    if (pendingTimeOfDayConfirmTimer) clearTimeout(pendingTimeOfDayConfirmTimer);

    pendingTimeOfDayConfirmTimer = setTimeout(async () => {
      pendingTimeOfDayConfirmTimer = null;
      if (pendingTimeOfDay !== newTimeOfDay) return;

      const confirmedTimeOfDay = detectTimeOfDay();
      if (confirmedTimeOfDay === newTimeOfDay && confirmedTimeOfDay !== currentTimeOfDay) {
        // info: точка, с которой начинается вся автосмена. Без неё в логе
        // не видно даже того, распознали мы фазу или нет.
        log.info(SCOPE, "фаза подтверждена:", currentTimeOfDay, "→", confirmedTimeOfDay);
        currentTimeOfDay = confirmedTimeOfDay;
        pendingTimeOfDay = null;
        if (confirmedTimeOfDay === "day") await hideRoleBeforeDaySceneSwitch();
        scheduleRoleVisibility(confirmedTimeOfDay);
        void savePersistedAutoState();
        await autoSwitchScene(confirmedTimeOfDay);
      } else {
        log.debug(
          SCOPE,
          "Time change not confirmed (expected:",
          newTimeOfDay,
          ", got:",
          confirmedTimeOfDay,
          ")",
        );
        pendingTimeOfDay = null;
      }
    }, 350);
  }
}

/** Автоматически переключает сцену в зависимости от времени суток. */
async function autoSwitchScene(timeOfDay: TimeOfDay): Promise<void> {
  // Ниже — info, а не debug. Это решения, принимаемые НЕСКОЛЬКО РАЗ ЗА ИГРУ
  // (на смене фазы), а не потиковый шум, зато без них жалоба «автосмена сцен
  // перестала работать» неразбираема: в файл лога пишется только info, и весь
  // путь автосцены был в нём невидим (разбор жалобы 02.08.2026).
  if (!autoModeEnabled) {
    log.info(SCOPE, "смена сцены пропущена: авто-режим выключен");
    return;
  }

  const targetScene = timeOfDay === "day" ? dayScene : nightScene;
  if (!targetScene) {
    log.info(SCOPE, "смена сцены пропущена: не выбрана сцена для фазы", timeOfDay);
    return;
  }
  if (currentScene === targetScene) {
    log.info(SCOPE, "смена не требуется: нужная сцена уже активна —", targetScene);
    return;
  }

  log.info(SCOPE, "автосмена сцены:", timeOfDay, "→", targetScene, "(было:", currentScene, ")");
  // currentScene обновляет switchScene ПОСЛЕ подтверждения. Оптимистичная
  // запись до запроса блокировала все повторы гвардом currentScene===target:
  // упавшее переключение (сцена удалена, дисконнект) молча замораживало
  // автомод до следующей смены фазы.
  try {
    // Подтверждение отдельной строкой: «попытались» и «сцена реально
    // переключилась» — разные события, и в жалобе важно именно второе.
    if (await switchScene(targetScene)) log.info(SCOPE, "сцена переключена:", targetScene);
  } catch (e) {
    log.error(SCOPE, "Failed to auto-switch scene", e, "(target:", targetScene, ")");
  }
}

// ─────────────────────────── мониторинг DOM (день/ночь) ───────────────────────────

function startDOMMonitoring(): void {
  if (!autoModeEnabled) {
    log.info(SCOPE, "слежение за фазой не запущено: авто-режим выключен");
    return;
  }
  if (unsubDom) return;

  log.info(SCOPE, "слежение за фазой запущено (день:", dayScene || "—", "ночь:", nightScene || "—", ")");

  // Реагируем только на мутации, связанные с элементами стадий: раньше
  // релевантной считалась ЛЮБАЯ childList/class/style-мутация документа
  // (звуковые индикаторы!) — до 4 полных detectTimeOfDay в секунду, до
  // 14 400 за часовую игру (аудит 01.08.2026, находка 5). Таймер «До смены
  // этапа» живёт соседом списка стадий и может не попасть под селектор —
  // его добирает редкий страховочный опрос ниже.
  const PHASE_SCOPE = ".stage, .substage, .ended__title";
  unsubDom = onDomChange((mutations) => {
    let shouldCheckTime = false;

    for (const mutation of mutations) {
      const t = mutation.target;
      const el = t instanceof Element ? t : t.parentElement;
      if (el?.closest(PHASE_SCOPE)) {
        shouldCheckTime = true;
        break;
      }
      if (mutation.type === "childList") {
        for (const n of mutation.addedNodes) {
          if (n instanceof Element && (n.matches(PHASE_SCOPE) || n.querySelector(PHASE_SCOPE))) {
            shouldCheckTime = true;
            break;
          }
        }
        if (shouldCheckTime) break;
      }
    }

    if (shouldCheckTime) requestTimeOfDayCheck();
  });

  // Страховочный редкий опрос (2с): ловит смену текста таймера вне
  // .stage-скоупа и любые нестандартные раскладки вёрстки.
  timeOfDayFallbackTimer = setInterval(() => requestTimeOfDayCheck(), 2000);

  // Начальная проверка времени суток.
  setTimeout(() => requestTimeOfDayCheck(), 1000);
}

function stopDOMMonitoring(): void {
  unsubDom?.();
  unsubDom = null;
  // Возвращаем роли сайта в исходный вид: авто-режим мог оставить их
  // скрытыми (день) или принудительно показанными (ночь), и без этого они
  // застывали в таком виде до перерисовки страницы сайтом (находка 7).
  restoreRoleVisibility();

  if (timeOfDayFallbackTimer) {
    clearInterval(timeOfDayFallbackTimer);
    timeOfDayFallbackTimer = null;
  }
  if (timeOfDayCheckDebounceTimer) {
    clearTimeout(timeOfDayCheckDebounceTimer);
    timeOfDayCheckDebounceTimer = null;
  }
  if (pendingTimeOfDayConfirmTimer) {
    clearTimeout(pendingTimeOfDayConfirmTimer);
    pendingTimeOfDayConfirmTimer = null;
  }
  timeOfDayCheckQueued = false;
  pendingTimeOfDay = null;
}

// ─────────────────────────── видимость панели по игровому интерфейсу ───────────────────────────

function syncPanelVisibilityWithGameState(): void {
  const hasGameUi = hasActiveGameInterface();

  if (!hasGameUi) {
    if (isVisible) doHide();
    return;
  }
  if (!isVisible) doShow();
}

function doShow(): void {
  if (!panelEnabled) return;
  if (!hasActiveGameInterface()) return;

  if (!panel) {
    panel = new ObsPanel();
    panel.onSceneClick = (sceneName) => {
      // Ручной клик: приоритетнее автоматики (см. switchScene). Ошибку ловим
      // здесь: без catch это необработанный rejection, а человек, кликнувший
      // по сцене, не узнавал, что переключение не удалось.
      void switchScene(sceneName, true).catch((e: Error) => {
        log.error(SCOPE, "ручное переключение сцены не удалось", e);
        panel?.setConnectionStatus(`Не удалось переключить: ${e.message}`, "error");
      });
    };
    panel.onClose = () => {
      doHide();
      // Также отключаем настройку плавающей панели.
      void browser.storage.sync.set({ obs_floating_panel_enabled: false });
    };
  }
  panel.show();
  isVisible = true;

  void requestOBSStatus();
  if (autoModeEnabled) startDOMMonitoring();
}

function doHide(): void {
  panel?.hide();
  isVisible = false;
}

let unsubGameUi: (() => void) | null = null;

function startGameUiMonitoring(): void {
  if (unsubGameUi) return;
  unsubGameUi = onDomChange(() => {
    if (gameUiDebounceTimer) return;
    gameUiDebounceTimer = setTimeout(() => {
      gameUiDebounceTimer = null;
      syncPanelVisibilityWithGameState();
    }, 150);
  });
}

function stopGameUiMonitoring(): void {
  unsubGameUi?.();
  unsubGameUi = null;
  if (gameUiDebounceTimer) {
    clearTimeout(gameUiDebounceTimer);
    gameUiDebounceTimer = null;
  }
}

// ─────────────────────────── приём событий OBS ───────────────────────────

function handleOBSEvent(eventType: string, data: any): void {
  log.debug(SCOPE, "OBS event:", eventType, data);

  switch (eventType) {
    case "obs_scenes_updated":
      if (data && data.scenes) {
        scenes = data.scenes;
        currentScene = data.currentScene ?? null;

        // Создаём панель если её нет и включён авторежим.
        if (!panel && autoModeEnabled && hasActiveGameInterface()) doShow();

        panel?.setScenes(scenes, currentScene);
        panel?.setConnectionStatus("Подключено", "connected");
      }
      break;

    case "obs_scene_changed":
      currentScene = data ?? null;
      if (!panel && autoModeEnabled && hasActiveGameInterface()) doShow();
      panel?.setCurrentScene(currentScene);
      break;

    case "obs_connected":
      // Раньше case отсутствовал: если GetSceneList после коннекта падал,
      // панель навсегда показывала «Не подключено» при живом соединении.
      panel?.setConnectionStatus("Подключено", "connected");
      break;

    case "obs_disconnected":
      void clearPersistedAutoState(true);
      scenes = [];
      currentScene = null;
      if (!panel && autoModeEnabled && hasActiveGameInterface()) doShow();
      panel?.setScenes(scenes, currentScene);
      panel?.setConnectionStatus("Не подключено", "error");
      break;
  }
}

// ─────────────────────────── применение настроек авто-режима ───────────────────────────

function applyAutoSettings(ctx: FeatureContext): void {
  const s = ctx.settings;
  const newAutoMode = s.obs_auto_mode_enabled === true;
  const newDayScene = s.obs_day_scene || "";
  const newNightScene = s.obs_night_scene || "";

  const changed =
    newAutoMode !== autoModeEnabled ||
    newDayScene !== dayScene ||
    newNightScene !== nightScene;

  autoModeEnabled = newAutoMode;
  dayScene = newDayScene;
  nightScene = newNightScene;

  if (!changed) return;

  // info: пользователь переключил тумблер или выбрал другие сцены — и ждёт,
  // что это сразу подействует. Раньше в файле не было ни самого изменения, ни
  // его последствия (аудит наблюдаемости 02.08.2026, OP-3).
  // Первый вызов — это ЗАПУСК, а не правка: при загрузке страницы значения
  // приезжают с дефолтов, и «изменены» было бы ложным следом «пользователь
  // только что трогал тумблер» (ревью 02.08.2026).
  log.info(
    SCOPE,
    autoSettingsInitialized ? "настройки автосцен изменены: авто-режим" : "автосцены при запуске: авто-режим",
    autoModeEnabled ? "вкл" : "выкл",
    "| день:",
    dayScene || "не выбрана",
    "| ночь:",
    nightScene || "не выбрана",
  );

  const wasInitialized = autoSettingsInitialized;
  autoSettingsInitialized = true;

  if (autoModeEnabled) {
    startDOMMonitoring();
    // Новую пару применяем к УЖЕ известной фазе. Обнулять currentTimeOfDay
    // нельзя: финальный фолбэк детектора — `currentTimeOfDay || "day"`, то
    // есть без памяти «не понял — оставь как было» превращается в «считай,
    // что день», и смена пары сцен ночью могла выдать дневную сцену в эфир
    // (ревью 02.08.2026).
    if (wasInitialized && currentTimeOfDay) void autoSwitchScene(currentTimeOfDay);
    requestTimeOfDayCheck();
  } else {
    stopDOMMonitoring();
  }
}

// ─────────────────────────── публичная фича ───────────────────────────

export const obsPanelFeature: Feature = {
  id: "obs-panel",
  // null: раньше здесь стоял "obs_floating_panel_enabled" (дефолт false) —
  // и ВЕСЬ автомод день/ночь, живущий внутри этой фичи, не запускался без
  // включённой плавающей панели. Попап при этом давал настроить сцены,
  // которые никогда не переключались. Теперь фича активна всегда, а панель
  // и мониторинг гейтятся каждый своей настройкой.
  settingKey: null,

  async enable(ctx) {
    panelEnabled = ctx.settings.obs_floating_panel_enabled === true;
    applyAutoSettings(ctx);

    // Приём событий OBS из background.
    unsubMessage = onMessage((msg) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as any;
      if (m.type === "obs_event") {
        handleOBSEvent(m.eventType, m.data);
      }
      if (m.type === "obs_scene_owner_ping") {
        // «Автосцену ведёшь ты ПРЯМО СЕЙЧАС?» Отвечать по одной настройке
        // нельзя: `autoModeEnabled` — это «мне разрешено», и он остаётся true
        // до конца жизни вкладки. Вкладка с доигранным матчем держала бы
        // владение ещё 20 минут, а следующая игра в новой вкладке всё это
        // время молчала бы (ревью 02.08.2026 — самый частый бытовой случай).
        return Promise.resolve({
          owning: drivesAutoScene({
            autoModeOn: autoModeEnabled,
            pathname: location.pathname,
            phaseKnown: currentTimeOfDay !== null,
            matchFinished: matchFinishedVisible(),
          }),
        });
      }
      // floating_panel_show/hide/toggle удалены: этих сообщений никто никогда
      // не отправлял (и их не было в ExtMessage) — слушатели-призраки.
      return undefined;
    });

    // Мониторинг появления/исчезновения игрового UI (нужен только панели).
    if (panelEnabled) startGameUiMonitoring();

    // Показываем панель если уже на странице игры.
    if (hasActiveGameInterface()) doShow();

    // Запрос статуса OBS + восстановление состояния авто-сцены.
    if (autoModeEnabled) {
      const response = await obsCommand("get_status");
      const status = response?.success ? response.data : null;
      await restorePersistedAutoState(status);
    }

    syncPanelVisibilityWithGameState();

    // Запуск авто-определения времени суток.
    if (autoModeEnabled) startDOMMonitoring();
  },

  update(ctx) {
    const nextPanelEnabled = ctx.settings.obs_floating_panel_enabled === true;
    if (nextPanelEnabled !== panelEnabled) {
      panelEnabled = nextPanelEnabled;
      if (panelEnabled) {
        startGameUiMonitoring();
        syncPanelVisibilityWithGameState();
      } else {
        stopGameUiMonitoring();
        doHide();
      }
    }
    applyAutoSettings(ctx);
  },

  disable() {
    // Снять подписки.
    unsubMessage?.();
    unsubMessage = null;
    stopGameUiMonitoring();
    stopDOMMonitoring();

    // Снять оставшиеся таймеры.
    if (pendingRoleVisibilityTimer) {
      clearTimeout(pendingRoleVisibilityTimer);
      pendingRoleVisibilityTimer = null;
    }

    // Демонтировать панель.
    panel?.unmount();
    panel = null;
    isVisible = false;

    // Сброс состояния.
    scenes = [];
    currentScene = null;
    obsSessionId = null;
    currentTimeOfDay = null;
    lastAppliedRoleVisibility = null;
    autoModeEnabled = false;
    dayScene = "";
    nightScene = "";
    // Иначе после выключения и повторного включения первая же удачная
    // детекция напечатала бы «не понимали 3600 с», посчитав и время, когда
    // фича вообще не работала — строка, чей единственный смысл в длительности,
    // врала бы (ревью 02.08.2026).
    phaseUnknownSince = 0;
    phaseUnknownReported = false;
    autoSettingsInitialized = false;
  },
};
