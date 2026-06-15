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
import { SITE } from "@core/selectors";
import type { Feature, FeatureContext } from "@core/feature";
import type { ObsScene } from "@shared/types";

const SCOPE = "obs-panel";

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
let dayScene = "";
let nightScene = "";

let scenes: ObsScene[] = [];
let currentScene: string | null = null;
let obsSessionId: string | null = null;

let currentTimeOfDay: TimeOfDay | null = null;
let lastAppliedRoleVisibility: string | null = null;
const roleVisibilityDelayMs = 3000;
const roleVisibilityState = new WeakMap<
  HTMLElement,
  { visibility: string; opacity: string; pointerEvents: string }
>();

// Таймеры/подписки (всё должно быть снято в disable()).
let unsubMessage: (() => void) | null = null;
let unsubDom: (() => void) | null = null;
let gameUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;

let timeOfDayCheckDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let timeOfDayCheckQueued = false;
let pendingTimeOfDay: TimeOfDay | null = null;
let pendingTimeOfDayConfirmTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRoleVisibilityTimer: ReturnType<typeof setTimeout> | null = null;

let isVisible = false;

// ─────────────────────────── OBS-команды (через background) ───────────────────────────

async function obsCommand(
  command: "get_status" | "set_scene",
  data?: { sceneName?: string },
): Promise<any> {
  return sendRuntime<any>({ type: "obs_command", command, data });
}

async function switchScene(sceneName: string): Promise<void> {
  const response = await obsCommand("set_scene", { sceneName });
  if (response && response.success) {
    panel?.setCurrentScene(currentScene);
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

async function getStoredConnectionState(): Promise<any> {
  try {
    const res = await browser.storage.local.get(["obs_connection_state"]);
    return (res as any).obs_connection_state || null;
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
  const directHandler = isRoleVisible
    ? (window as any).showOwnRole
    : (window as any).hideOwnRole;
  if (typeof directHandler === "function") {
    const handled = directHandler();
    if (handled) {
      lastAppliedRoleVisibility = isRoleVisible ? "visible" : "hidden";
      log.debug(SCOPE, "Role visibility applied via window handler", lastAppliedRoleVisibility);
      return true;
    }
  }

  const targets = getRoleVisibilityTargets();
  if (targets.length === 0) {
    log.debug(SCOPE, "Role visibility targets not found, skipping role update");
    return false;
  }

  targets.forEach((element) => {
    if (!roleVisibilityState.has(element)) {
      roleVisibilityState.set(element, {
        visibility: element.style.visibility,
        opacity: element.style.opacity,
        pointerEvents: element.style.pointerEvents,
      });
    }

    const originalState = roleVisibilityState.get(element)!;
    if (isRoleVisible) {
      element.style.visibility = originalState.visibility;
      element.style.opacity = originalState.opacity;
      element.style.pointerEvents = originalState.pointerEvents;
    } else {
      element.style.visibility = "hidden";
      element.style.opacity = "0";
      element.style.pointerEvents = "none";
    }
  });

  lastAppliedRoleVisibility = isRoleVisible ? "visible" : "hidden";
  log.debug(SCOPE, "Role visibility applied", lastAppliedRoleVisibility);
  return true;
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
    if (!applied && attempt < 5) scheduleRoleVisibility(timeOfDay, attempt + 1);
  }, delayMs);
}

async function hideRoleBeforeDaySceneSwitch(): Promise<void> {
  if (pendingRoleVisibilityTimer) {
    clearTimeout(pendingRoleVisibilityTimer);
    pendingRoleVisibilityTimer = null;
  }
  applyRoleVisibility(false);
  lastAppliedRoleVisibility = "hidden";
  // Дать DOM перерисовать скрытое состояние перед переключением сцены OBS.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

// ─────────────────────────── определение времени суток ───────────────────────────

/**
 * Определяет время суток на основе DOM элементов страницы игры.
 * Логика сохранена 1-в-1 из obs-floating-panel.js.
 */
function detectTimeOfDay(): TimeOfDay {
  try {
    // 1. Надпись "Промах" — всегда день
    const missElement = document.querySelector(SITE.endedTitle);
    if (missElement && (missElement.textContent || "").includes("Промах")) {
      log.debug(SCOPE, "Detected MISS - forcing DAY scene");
      return "day";
    }

    // 2. Ищем элементы "До смены этапа"
    const stageChangeElements = document.querySelectorAll("*");
    let stageChangeText = "";
    stageChangeElements.forEach((element) => {
      const text = norm(element);
      if (text.includes("до смены этапа")) stageChangeText = text;
    });

    if (stageChangeText) {
      const nextStage = document.querySelector(SITE.substageNext);
      if (nextStage) {
        const nextStageText = norm(nextStage);
        log.debug(SCOPE, 'Found "До смены этапа", next stage:', nextStageText);

        const dayStages = [
          "день | речь игрока",
          "голосование",
          "доп. речь",
          "прощальная минута",
          "лучший ход",
          "промах",
        ];
        for (const dayStage of dayStages) {
          if (nextStageText.includes(dayStage)) {
            log.debug(SCOPE, "Detected DAY via next stage:", dayStage);
            return "day";
          }
        }

        const nightStages = ["ночь", "знакомство мафии"];
        for (const nightStage of nightStages) {
          if (nextStageText.includes(nightStage)) {
            log.debug(SCOPE, "Detected NIGHT via next stage:", nightStage);
            return "night";
          }
        }
      }

      if (stageChangeText.match(/до смены этапа \d+ сек/)) {
        const currentSubstage = document.querySelector(SITE.substageCurrent);
        if (currentSubstage) {
          const currentText = norm(currentSubstage);
          if (currentText.includes("ночь")) {
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
      if (currentText.trim() === "ночь") {
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
        (votingText.includes("голосование") || votingText.includes("итоги подъема")) &&
        substageText.includes("итоги подъема")
      ) {
        log.debug(SCOPE, "Detected DAY: Голосование с итогами подъема");
        return "day";
      }
    }

    // 5. Текущая стадия игры (без "До смены этапа")
    const currentStage = document.querySelector(SITE.substageCurrent);
    if (currentStage) {
      const stageText = norm(currentStage);

      if (stageText.includes("раздача карт")) {
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

      if (stageText.includes("день | речь игрока")) {
        log.debug(SCOPE, "Detected DAY stage: День | Речь игрока");
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
      const isIsolatedNight = isSubstage && stageText.trim() === "ночь";

      if (stageText.includes("ночь") && !stageText.includes("день") && !isIsolatedNight) {
        hasAnyNightStage = true;
      }
      if (stageText.includes("день") || stageText.includes("итоги подъема")) {
        hasAnyDayStage = true;
      }
    });

    if (hasAnyNightStage) {
      log.debug(SCOPE, "Detected NIGHT via any night stage found");
      return "night";
    }
    if (hasAnyDayStage) {
      log.debug(SCOPE, "Detected DAY via any day stage found");
      return "day";
    }

    const fallbackTime = currentTimeOfDay || "day";
    log.debug(SCOPE, "No specific stage detected - keeping", fallbackTime.toUpperCase());
    return fallbackTime;
  } catch (e) {
    log.error(SCOPE, "Error detecting time of day", e);
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
        log.debug(SCOPE, "Confirmed time change", currentTimeOfDay, "->", confirmedTimeOfDay);
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
  if (!autoModeEnabled) {
    log.debug(SCOPE, "Auto mode disabled, skipping scene switch");
    return;
  }

  const targetScene = timeOfDay === "day" ? dayScene : nightScene;
  if (!targetScene) {
    log.debug(SCOPE, "No target scene configured for", timeOfDay);
    return;
  }
  if (currentScene === targetScene) {
    log.debug(SCOPE, "Scene already set to", targetScene);
    return;
  }

  log.debug(SCOPE, "Auto-switching to", timeOfDay, "scene:", targetScene, "(prev:", currentScene, ")");
  // Обновляем currentScene сразу для корректного логирования.
  currentScene = targetScene;

  try {
    await switchScene(targetScene);
    log.debug(SCOPE, "Switched to scene:", targetScene);
  } catch (e) {
    log.error(SCOPE, "Failed to auto-switch scene", e, "(target:", targetScene, ")");
  }
}

// ─────────────────────────── мониторинг DOM (день/ночь) ───────────────────────────

function startDOMMonitoring(): void {
  if (!autoModeEnabled) {
    log.debug(SCOPE, "Auto mode disabled, not starting DOM monitoring");
    return;
  }
  if (unsubDom) return;

  log.debug(SCOPE, "Starting DOM monitoring for automatic scene switching");

  unsubDom = onDomChange((mutations) => {
    let shouldCheckTime = false;

    for (const mutation of mutations) {
      if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        shouldCheckTime = true;
      } else if (
        mutation.type === "attributes" &&
        (mutation.attributeName === "class" || mutation.attributeName === "style")
      ) {
        shouldCheckTime = true;
      } else if (mutation.type === "characterData") {
        const target = mutation.target;
        let element: HTMLElement | null =
          target instanceof HTMLElement ? target : target.parentElement;
        while (element && element !== document.body) {
          if (
            element.classList &&
            (element.classList.contains("stage") ||
              element.classList.contains("substage") ||
              element.classList.contains("ended__title"))
          ) {
            shouldCheckTime = true;
            break;
          }
          element = element.parentElement;
        }
      }
      if (shouldCheckTime) break;
    }

    if (shouldCheckTime) requestTimeOfDayCheck();
  });

  // Начальная проверка времени суток.
  setTimeout(() => requestTimeOfDayCheck(), 1000);
}

function stopDOMMonitoring(): void {
  unsubDom?.();
  unsubDom = null;

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
  if (!hasActiveGameInterface()) return;

  if (!panel) {
    panel = new ObsPanel();
    panel.onSceneClick = (sceneName) => {
      void switchScene(sceneName);
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

  log.debug(SCOPE, "Auto scene settings changed", {
    autoModeEnabled,
    dayScene,
    nightScene,
  });

  if (autoModeEnabled) startDOMMonitoring();
  else stopDOMMonitoring();
}

// ─────────────────────────── публичная фича ───────────────────────────

export const obsPanelFeature: Feature = {
  id: "obs-panel",
  settingKey: "obs_floating_panel_enabled",

  async enable(ctx) {
    applyAutoSettings(ctx);

    // Приём событий OBS из background.
    unsubMessage = onMessage((msg) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as any;
      if (m.type === "obs_event") {
        handleOBSEvent(m.eventType, m.data);
        return { success: true };
      }
      if (m.type === "floating_panel_toggle") {
        if (isVisible) doHide();
        else doShow();
        return { success: true };
      }
      if (m.type === "floating_panel_show") {
        doShow();
        return { success: true };
      }
      if (m.type === "floating_panel_hide") {
        doHide();
        return { success: true };
      }
      return undefined;
    });

    // Мониторинг появления/исчезновения игрового UI.
    startGameUiMonitoring();

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
  },
};
