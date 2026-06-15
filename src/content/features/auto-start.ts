/**
 * Фича: автостарт/автопринятие игр + игровая страница.
 * Порт auto-start.js.
 *
 * Управляется НЕСКОЛЬКИМИ настройками, поэтому settingKey: null (фича включена
 * всегда), а под-поведения включаются/выключаются индивидуально по ctx.settings:
 *
 *  • auto_accept_enabled          — автоклик кнопок «Принять/Готов/Старт» на странице поиска.
 *  • skip_start_screen_enabled    — автоклик «НАЧАТЬ ИГРУ» на приветственном экране.
 *  • disable_webcam_clicks        — запрет автокликов по кнопке веб-камеры.
 *  • auto_hide_roles_enabled      — авто-скрытие своей роли (CSS-инъекция).
 *  • role_phase_auto_switch_enabled — переключение видимости роли по фазе день/ночь.
 *
 * Хоткей D/В (event.code === "KeyD") — ручной toggle видимости роли.
 *
 * update(ctx) переприменяет настройки без выкл/вкл фичи.
 */
import { onDomChange, safeClick } from "@core/dom";
import { keyboard } from "@core/keyboard";
import { log } from "@core/log";
import { SITE, TEXT, OWN } from "@core/selectors";
import type { Feature, FeatureContext } from "@core/feature";

const SCOPE = "auto-start";

/** Текст элемента в нижнем регистре, со схлопнутыми пробелами. */
function norm(el: { textContent?: string | null } | null | undefined): string {
  return (el?.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text: string, markers: readonly string[]): boolean {
  return markers.some((m) => text.includes(m));
}

// ─────────────────────────── состояние под-поведений ───────────────────────────

let cfg = {
  autoAccept: true,
  skipStartScreen: true,
  disableWebcam: false,
  autoHideRoles: false,
  rolePhaseSwitch: false,
};

// Автопринятие (страница поиска)
let acceptInterval: ReturnType<typeof setInterval> | null = null;
let unsubAcceptDom: (() => void) | null = null;
let videoButtonClicked = false;

// Игровая страница
let gameInterval: ReturnType<typeof setInterval> | null = null;
let unsubGameDom: (() => void) | null = null;
let unsubKeyboard: (() => void) | null = null;
let roleHideKey = "KeyD";
let onRoleMenuClick: ((e: MouseEvent) => void) | null = null;
let webcamDisabled = false;
let webcamClickInterval: ReturnType<typeof setInterval> | null = null;

// Скрытие/показ роли
const roleVisibilityState = new WeakMap<
  HTMLElement,
  { display: string; visibility: string; opacity: string; pointerEvents: string }
>();
let trackedRolesVisible: boolean | null = null;
let pendingRoleSyncTimer: ReturnType<typeof setTimeout> | null = null;
let suppressRoleKeyHandlingUntil = 0;
let lastManualRoleActionAt = 0;
let initialAutoHideTimer: ReturnType<typeof setInterval> | null = null;
let initialAutoHideAttempts = 0;

// Фаза день/ночь
let rolePhaseInitialized = false;
let rolePhaseCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastDetectedRolePhase: "day" | "night" | null = null;
let pendingNightRoleShowTimer: ReturnType<typeof setTimeout> | null = null;
let nightAutoShowAttempts = 0;
let nightAutoShowStartedAt = 0;

// ─────────────────────────── автопринятие игр ───────────────────────────

function clickAcceptButtons() {
  log.debug(SCOPE, "checking accept buttons");

  const acceptGameElements = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) =>
    containsAny(norm(el), TEXT.acceptGameText),
  );

  const readyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (btn) => containsAny((btn.textContent || "").toLowerCase(), TEXT.acceptGameButton),
  );

  let gameAcceptDivs: HTMLElement[] = [];

  try {
    Array.from(document.querySelectorAll<HTMLElement>(SITE.acceptGameDivPrimary)).forEach((el) =>
      gameAcceptDivs.push(el),
    );
  } catch (e) {
    log.debug(SCOPE, "primary accept selector failed", e);
  }

  try {
    Array.from(document.querySelectorAll<HTMLElement>(SITE.acceptGameWrapperDiv))
      .filter((el) => containsAny(norm(el), TEXT.acceptGameText))
      .forEach((el) => gameAcceptDivs.push(el));
  } catch (e) {
    log.debug(SCOPE, "wrapper accept selector failed", e);
  }

  try {
    Array.from(document.querySelectorAll<HTMLElement>(SITE.cursorPointerDiv))
      .filter((el) => containsAny(norm(el), TEXT.acceptGameText))
      .forEach((el) => gameAcceptDivs.push(el));
  } catch (e) {
    log.debug(SCOPE, "cursor-pointer accept selector failed", e);
  }

  // Fallback: по тексту «Принять игру» ИЛИ по названию режима
  if (gameAcceptDivs.length === 0) {
    gameAcceptDivs = Array.from(
      document.querySelectorAll<HTMLElement>(SITE.acceptGameDivLoose),
    ).filter((div) => {
      const t = norm(div);
      return containsAny(t, TEXT.acceptGameText) || containsAny(t, TEXT.gameMode);
    });
  }

  try {
    Array.from(document.querySelectorAll<HTMLElement>(SITE.profileAccept)).forEach((el) =>
      gameAcceptDivs.push(el),
    );
  } catch (e) {
    log.debug(SCOPE, "profileAccept selector failed", e);
  }

  gameAcceptDivs = Array.from(new Set(gameAcceptDivs));

  // Клик по обычным кнопкам
  readyButtons.forEach((button) => {
    log.debug(SCOPE, "click accept button", button.textContent);
    button.click();

    // После старта — один раз пытаемся включить видео
    if (!videoButtonClicked) {
      setTimeout(() => {
        const videoButton = document.querySelector<HTMLElement>(SITE.webcamButtonStartIcon);
        if (videoButton) {
          if (cfg.disableWebcam) {
            log.debug(SCOPE, "skip webcam autoclick (disabled by setting)");
          } else {
            videoButton.click();
            videoButtonClicked = true;
          }
        }
      }, 1000);
    }
  });

  // Клик по карточкам приёма игры
  gameAcceptDivs.forEach((div) => {
    safeClick(div);
  });

  // Доп. элементы с текстом «Принять игру»
  acceptGameElements.forEach((el) => {
    if (!readyButtons.includes(el as HTMLButtonElement) && !gameAcceptDivs.includes(el)) {
      safeClick(el);
    }
  });
}

function enableAutoAccept() {
  if (acceptInterval !== null) return;
  log.info(SCOPE, "auto-accept enabled");
  videoButtonClicked = false;
  acceptInterval = setInterval(clickAcceptButtons, 1000);
  unsubAcceptDom = onDomChange((muts) => {
    if (muts.some((m) => m.addedNodes.length)) clickAcceptButtons();
  });
}

function disableAutoAccept() {
  if (acceptInterval !== null) {
    clearInterval(acceptInterval);
    acceptInterval = null;
  }
  unsubAcceptDom?.();
  unsubAcceptDom = null;
}

// ─────────────────────────── скрытие/показ роли ───────────────────────────

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

function getPrimaryOwnRoleElement(roleElements = getRoleVisibilityTargets()): HTMLElement | null {
  return roleElements[0] || null;
}

function getRoleUseHref(roleElement: HTMLElement | null): string {
  if (!roleElement) return "";
  const useElement = roleElement.querySelector("use");
  if (!useElement) return "";
  return (
    useElement.getAttribute("href") ||
    useElement.getAttribute("xlink:href") ||
    ""
  ).toLowerCase();
}

function isRoleElementActuallyVisible(roleElement: HTMLElement | null): boolean {
  if (!roleElement) return false;
  const style = window.getComputedStyle(roleElement);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = roleElement.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

interface OwnRoleState {
  nativeHidden: boolean;
  inlineHidden: boolean;
  visible: boolean;
}

function getOwnRoleState(roleElements = getRoleVisibilityTargets()): OwnRoleState {
  const primaryElement = getPrimaryOwnRoleElement(roleElements);
  const href = getRoleUseHref(primaryElement);
  const nativeHidden = href.includes("#stop");
  const inlineHidden = roleElements.some(
    (el) =>
      el.style.display === "none" ||
      el.style.visibility === "hidden" ||
      el.style.opacity === "0",
  );
  return {
    nativeHidden,
    inlineHidden,
    visible: isRoleElementActuallyVisible(primaryElement),
  };
}

function syncTrackedRolesVisibility(state: OwnRoleState = getOwnRoleState()): boolean | null {
  if (state.nativeHidden) {
    trackedRolesVisible = false;
    return trackedRolesVisible;
  }
  if (state.visible && !state.inlineHidden) {
    trackedRolesVisible = true;
    return trackedRolesVisible;
  }
  return trackedRolesVisible;
}

function rememberRoleInlineState(roleElements: HTMLElement[]) {
  roleElements.forEach((el) => {
    if (roleVisibilityState.has(el)) return;
    roleVisibilityState.set(el, {
      display: el.style.display,
      visibility: el.style.visibility,
      opacity: el.style.opacity,
      pointerEvents: el.style.pointerEvents,
    });
  });
}

function applyInlineRoleVisibility(roleElements: HTMLElement[], isVisible: boolean) {
  rememberRoleInlineState(roleElements);
  roleElements.forEach((el) => {
    const original =
      roleVisibilityState.get(el) || { display: "", visibility: "", opacity: "", pointerEvents: "" };
    if (isVisible) {
      el.style.display = original.display;
      el.style.visibility = original.visibility;
      el.style.opacity = original.opacity;
      el.style.pointerEvents = original.pointerEvents;
    } else {
      el.style.display = "none";
      el.style.visibility = "hidden";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
    }
  });
}

function clearPendingRoleSync() {
  if (!pendingRoleSyncTimer) return;
  clearTimeout(pendingRoleSyncTimer);
  pendingRoleSyncTimer = null;
}

function dispatchNativeRoleToggle(): boolean {
  suppressRoleKeyHandlingUntil = Date.now() + 250;
  const keyOptions = {
    key: "d",
    code: "KeyD",
    keyCode: 68,
    which: 68,
    bubbles: true,
    cancelable: true,
  };
  document.dispatchEvent(new KeyboardEvent("keydown", keyOptions));
  document.dispatchEvent(new KeyboardEvent("keyup", keyOptions));
  return true;
}

function syncRoleStateFromDom(): boolean {
  const roleElements = getRoleVisibilityTargets();
  if (roleElements.length === 0) return false;

  const state = getOwnRoleState(roleElements);
  if (!state.nativeHidden && state.inlineHidden) {
    applyInlineRoleVisibility(roleElements, true);
  }

  const nextState = getOwnRoleState(roleElements);
  syncTrackedRolesVisibility(nextState);
  return true;
}

function scheduleRoleStateSync(delayMs = 80) {
  clearPendingRoleSync();
  pendingRoleSyncTimer = setTimeout(() => {
    pendingRoleSyncTimer = null;
    syncRoleStateFromDom();
  }, delayMs);
}

function setRoleVisibility(isVisible: boolean): boolean {
  const roleElements = getRoleVisibilityTargets();
  if (roleElements.length === 0) {
    log.debug(SCOPE, "role elements not found for visibility update");
    return false;
  }

  clearPendingRoleSync();

  const currentState = getOwnRoleState(roleElements);
  if (trackedRolesVisible === null) {
    syncTrackedRolesVisibility(currentState);
  }
  if (isVisible) {
    applyInlineRoleVisibility(roleElements, true);
  }

  const alreadyDesired = isVisible
    ? !currentState.nativeHidden && !currentState.inlineHidden && currentState.visible
    : currentState.nativeHidden || currentState.inlineHidden || !currentState.visible;

  if (alreadyDesired) {
    return true;
  }

  const shouldUseNativeToggle = trackedRolesVisible !== isVisible;

  if (shouldUseNativeToggle) {
    dispatchNativeRoleToggle();
    trackedRolesVisible = isVisible;
    scheduleRoleStateSync(isVisible ? 100 : 60);
  } else {
    applyInlineRoleVisibility(roleElements, isVisible);
    scheduleRoleStateSync(60);
  }

  return true;
}

// ─────────────────────────── CSS-скрытие ВСЕХ ролей ───────────────────────────

const ROLE_HIDE_ID = OWN.roleHideStyle;
const ROLE_HIDE_CSS = `
    .player__role,
    .player__role.role,
    svg.role,
    .my-role .player__role,
    .my-player .player__role {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
    }
`;

function hideAllRolesCSS() {
  if (document.getElementById(ROLE_HIDE_ID)) return;
  const el = document.createElement("style");
  el.id = ROLE_HIDE_ID;
  el.textContent = ROLE_HIDE_CSS;
  (document.head || document.documentElement).appendChild(el);
  log.debug(SCOPE, "roles hidden via CSS");
}

function showAllRolesCSS() {
  const el = document.getElementById(ROLE_HIDE_ID);
  if (!el) return;
  el.remove();
  log.debug(SCOPE, "roles shown via CSS");
}

function isRolesHiddenByCSS(): boolean {
  return !!document.getElementById(ROLE_HIDE_ID);
}

function autoHideRole(): boolean {
  if (!cfg.autoHideRoles) return false;
  // Всегда прячем CSS. Ночью scheduleNightRoleAutoShow уберёт CSS через 3 сек.
  hideAllRolesCSS();
  trackedRolesVisible = false;
  return true;
}

function stopInitialAutoHideRole() {
  if (initialAutoHideTimer) {
    clearInterval(initialAutoHideTimer);
    initialAutoHideTimer = null;
  }
  initialAutoHideAttempts = 0;
}

function startInitialAutoHideRole() {
  stopInitialAutoHideRole();
  if (!cfg.autoHideRoles) return;

  initialAutoHideTimer = setInterval(() => {
    initialAutoHideAttempts += 1;
    if (!cfg.autoHideRoles) {
      stopInitialAutoHideRole();
      return;
    }
    if (autoHideRole()) {
      stopInitialAutoHideRole();
      return;
    }
    if (initialAutoHideAttempts >= 100) {
      stopInitialAutoHideRole();
    }
  }, 100);
}

// ─────────────────────────── фаза день/ночь ───────────────────────────

function scheduleNightRoleAutoShow(delayMs: number) {
  if (pendingNightRoleShowTimer) clearTimeout(pendingNightRoleShowTimer);

  log.debug(SCOPE, "night-show scheduled in", delayMs);
  pendingNightRoleShowTimer = setTimeout(() => {
    pendingNightRoleShowTimer = null;
    log.debug(SCOPE, "night-show fire");

    // 1) Убираем CSS-скрытие
    showAllRolesCSS();

    // 2) Нативный показ через D
    const roleElements = getRoleVisibilityTargets();
    const primary = getPrimaryOwnRoleElement(roleElements);
    const href = getRoleUseHref(primary);
    const nativeHidden = href.includes("#stop");

    if (nativeHidden) dispatchNativeRoleToggle();

    trackedRolesVisible = true;
  }, delayMs);
}

function getTexts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector))
    .map((el) => norm(el))
    .filter(Boolean);
}

function isNightText(text: string): boolean {
  return containsAny(text, TEXT.night);
}

function isDayText(text: string): boolean {
  return containsAny(text, TEXT.day);
}

function detectRolePhase(): "day" | "night" {
  const body = document.body;
  if (body?.classList.contains("night")) return "night";
  if (body?.classList.contains("day")) return "day";

  // 1) Текущий этап (.current) — высший приоритет
  const currentTexts = getTexts(SITE.substageCurrent);
  if (currentTexts.length > 0) {
    const curDay = currentTexts.some(isDayText);
    const curNight = currentTexts.some(isNightText);
    if (curDay && !curNight) return "day";
    if (curNight && !curDay) return "night";
    if (curDay && curNight) return "day"; // речь игрока = день
  }

  // 2) Активный этап (.active)
  const activeTexts = getTexts(SITE.substageActive);
  if (activeTexts.length > 0) {
    const actDay = activeTexts.some(isDayText);
    const actNight = activeTexts.some(isNightText);
    if (actDay && !actNight) return "day";
    if (actNight && !actDay) return "night";
    if (actDay && actNight) return "day";
  }

  // 3) Следующий этап (.next) — только если current/active не определили
  const nextTexts = getTexts(SITE.substageNext);
  if (nextTexts.length > 0) {
    const nxtDay = nextTexts.some(isDayText);
    const nxtNight = nextTexts.some(isNightText);
    if (nxtNight && !nxtDay) return "night";
    if (nxtDay && !nxtNight) return "day";
  }

  // 4) OBS panel
  const obs = (window as any).obsFloatingPanel;
  if (obs && typeof obs.detectTimeOfDay === "function") {
    const panelPhase = obs.detectTimeOfDay();
    if (panelPhase === "night" || panelPhase === "day") return panelPhase;
  }

  // 5) Любые .stage/.substage — последний fallback
  const allTexts = getTexts(SITE.stage);
  const allDay = allTexts.some(isDayText);
  const allNight = allTexts.some(isNightText);
  if (allDay && !allNight) return "day";
  if (allNight && !allDay) return "night";
  if (allDay && allNight) return "day";

  return lastDetectedRolePhase || "day";
}

function applyRolePhase(phase: "day" | "night") {
  if (!cfg.rolePhaseSwitch) {
    if (pendingNightRoleShowTimer) {
      clearTimeout(pendingNightRoleShowTimer);
      pendingNightRoleShowTimer = null;
    }
    return;
  }

  if (phase !== "day" && phase !== "night") return;

  // Отменяем таймер ночного показа только при уходе ИЗ ночи
  if (phase !== "night" && pendingNightRoleShowTimer) {
    clearTimeout(pendingNightRoleShowTimer);
    pendingNightRoleShowTimer = null;
  }

  if (!rolePhaseInitialized) {
    rolePhaseInitialized = true;
    lastDetectedRolePhase = phase;

    if (phase === "night") {
      nightAutoShowAttempts = 0;
      nightAutoShowStartedAt = Date.now();
      scheduleNightRoleAutoShow(3000);
    } else {
      nightAutoShowAttempts = 0;
      nightAutoShowStartedAt = 0;
      if (cfg.autoHideRoles) {
        hideAllRolesCSS();
        trackedRolesVisible = false;
      }
    }
    return;
  }

  if (phase === lastDetectedRolePhase) return;

  lastDetectedRolePhase = phase;

  if (phase === "night") {
    nightAutoShowAttempts = 0;
    nightAutoShowStartedAt = Date.now();
    scheduleNightRoleAutoShow(3000);
    return;
  }

  nightAutoShowAttempts = 0;
  nightAutoShowStartedAt = 0;
  if (cfg.autoHideRoles) {
    hideAllRolesCSS();
    trackedRolesVisible = false;
  }
}

function queueRolePhaseCheck() {
  if (!cfg.rolePhaseSwitch) return;
  if (rolePhaseCheckTimer) return;

  rolePhaseCheckTimer = setTimeout(() => {
    rolePhaseCheckTimer = null;
    const phase = detectRolePhase();
    applyRolePhase(phase);

    if (phase === "night" && nightAutoShowStartedAt) {
      const ownRoleState = getOwnRoleState();
      const shouldRetryNightShow =
        ownRoleState.nativeHidden &&
        !pendingNightRoleShowTimer &&
        nightAutoShowAttempts > 0 &&
        nightAutoShowAttempts < 5 &&
        lastManualRoleActionAt < nightAutoShowStartedAt &&
        Date.now() - nightAutoShowStartedAt < 9000;

      if (shouldRetryNightShow) scheduleNightRoleAutoShow(700);
    }
  }, 150);
}

// ─────────────────────────── стартовый экран / лобби / веб-камера ───────────────────────────

function clickStartGameButton() {
  if (!cfg.skipStartScreen) return;

  const welcomeModal = document.querySelector<HTMLElement>(SITE.welcomeModal);
  if (!welcomeModal) return;

  const modalText = norm(welcomeModal);
  const hasWelcomeText = containsAny(modalText, TEXT.welcome);

  const startButtons = Array.from(welcomeModal.querySelectorAll<HTMLButtonElement>("button")).filter(
    (btn) => containsAny((btn.textContent || "").toLowerCase(), TEXT.startGameButton),
  );

  if (!hasWelcomeText && startButtons.length === 0) return;

  if (startButtons.length > 0) {
    log.debug(SCOPE, "click start-game button", startButtons[0].textContent);
    startButtons[0].click();
  }

  // Доп. элементы с точным текстом «НАЧАТЬ ИГРУ»
  const startElements = Array.from(welcomeModal.querySelectorAll<HTMLElement>("*")).filter((el) => {
    const t = norm(el);
    return (
      (TEXT.startGameButton as readonly string[]).includes(t) &&
      !startButtons.includes(el as HTMLButtonElement)
    );
  });

  if (startElements.length > 0) safeClick(startElements[0]);
}

function isInLobby(): boolean {
  const stageName = document.querySelector<HTMLElement>(SITE.lobbyStageName);
  const invitationLink = document.querySelector(SITE.invitationLink);
  const isRecruiting =
    !!stageName && (TEXT.recruiting as readonly string[]).includes(norm(stageName));
  return isRecruiting && invitationLink !== null;
}

function disableWebcams() {
  if (!isInLobby()) return;
  if (webcamDisabled) return;
  if (cfg.disableWebcam) {
    log.debug(SCOPE, "webcam disabling forbidden by setting");
    return;
  }

  const webcamButton = document.querySelector<HTMLElement>(SITE.webcamButton);
  if (!webcamButton) return;

  if (webcamButton.classList.contains(SITE.webcamButtonOffClass)) {
    webcamDisabled = true;
    return;
  }

  log.debug(SCOPE, "webcam on, turning off...");
  try {
    let clickCount = 0;
    const maxClicks = 10;

    if (webcamClickInterval) clearInterval(webcamClickInterval);
    webcamClickInterval = setInterval(() => {
      if (clickCount >= maxClicks) {
        if (webcamClickInterval) clearInterval(webcamClickInterval);
        webcamClickInterval = null;
        return;
      }
      const currentButton = document.querySelector<HTMLElement>(SITE.webcamButton);
      if (!currentButton) {
        if (webcamClickInterval) clearInterval(webcamClickInterval);
        webcamClickInterval = null;
        return;
      }
      if (currentButton.classList.contains(SITE.webcamButtonOffClass)) {
        webcamDisabled = true;
        if (webcamClickInterval) clearInterval(webcamClickInterval);
        webcamClickInterval = null;
        return;
      }
      currentButton.click();
      clickCount++;
    }, 200);
  } catch (e) {
    log.debug(SCOPE, "webcam disable error", e);
  }
}

// ─────────────────────────── хоткей D/В и меню «показать/скрыть роли» ───────────────────────────

function handleRoleKey() {
  if (Date.now() < suppressRoleKeyHandlingUntil) return;

  lastManualRoleActionAt = Date.now();

  // Если роли скрыты CSS — убираем CSS, показываем роли
  if (isRolesHiddenByCSS()) {
    showAllRolesCSS();
    trackedRolesVisible = true;
    return;
  }

  // Нет inline-скрытия — обычный toggle
  if (trackedRolesVisible === null) {
    syncTrackedRolesVisibility();
  }
  trackedRolesVisible = !trackedRolesVisible;
  log.debug(SCOPE, "role-hide toggle, trackedRolesVisible =", trackedRolesVisible);

  // Если хоткей переназначен (не дефолтный D) — сайт сам по нему не реагирует,
  // поэтому досылаем ему синтетический D, чтобы его собственный тоггл сработал.
  if (roleHideKey !== "KeyD") dispatchNativeRoleToggle();
}

function handleRoleMenuClick(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest?.(SITE.roleMenuClickable);
  if (!target) return;

  const text = norm(target);
  if (containsAny(text, TEXT.showRoles)) {
    lastManualRoleActionAt = Date.now();
    trackedRolesVisible = true;
    scheduleRoleStateSync(120);
    return;
  }
  if (containsAny(text, TEXT.hideRoles)) {
    lastManualRoleActionAt = Date.now();
    trackedRolesVisible = false;
    scheduleRoleStateSync(120);
  }
}

// ─────────────────────────── игровая страница: вкл/выкл ───────────────────────────

function enableGamePage() {
  if (gameInterval !== null) return;
  log.info(SCOPE, "game-page behaviors enabled");

  gameInterval = setInterval(() => {
    clickStartGameButton();
    disableWebcams();
    queueRolePhaseCheck();
  }, 1000);

  syncTrackedRolesVisibility();
  startInitialAutoHideRole();

  onRoleMenuClick = handleRoleMenuClick;
  document.addEventListener("click", onRoleMenuClick, true);

  unsubKeyboard = keyboard.register(roleHideKey, handleRoleKey, { preventDefault: false });

  unsubGameDom = onDomChange((muts) => {
    if (muts.some((m) => m.addedNodes.length)) {
      clickStartGameButton();
      disableWebcams();
      queueRolePhaseCheck();
    }
  });

  setTimeout(() => queueRolePhaseCheck(), 2000);
}

function disableGamePage() {
  if (gameInterval !== null) {
    clearInterval(gameInterval);
    gameInterval = null;
  }
  stopInitialAutoHideRole();
  if (webcamClickInterval) {
    clearInterval(webcamClickInterval);
    webcamClickInterval = null;
  }
  unsubGameDom?.();
  unsubGameDom = null;
  unsubKeyboard?.();
  unsubKeyboard = null;
  if (onRoleMenuClick) document.removeEventListener("click", onRoleMenuClick, true);
  onRoleMenuClick = null;
  if (rolePhaseCheckTimer) {
    clearTimeout(rolePhaseCheckTimer);
    rolePhaseCheckTimer = null;
  }
  if (pendingNightRoleShowTimer) {
    clearTimeout(pendingNightRoleShowTimer);
    pendingNightRoleShowTimer = null;
  }
  clearPendingRoleSync();
}

// ─────────────────────────── применение настроек ───────────────────────────

function applyConfig(ctx: FeatureContext) {
  const s = ctx.settings;
  const prevAutoHide = cfg.autoHideRoles;

  // Переназначаемая клавиша скрытия роли — перерегистрируем, если изменилась.
  const newHideKey = s.hotkey_role_hide || "KeyD";
  if (newHideKey !== roleHideKey) {
    roleHideKey = newHideKey;
    if (unsubKeyboard) {
      unsubKeyboard();
      unsubKeyboard = keyboard.register(roleHideKey, handleRoleKey, { preventDefault: false });
    }
  }

  cfg = {
    autoAccept: s.auto_accept_enabled === true,
    skipStartScreen: s.skip_start_screen_enabled !== false,
    disableWebcam: s.disable_webcam_clicks === true,
    autoHideRoles: s.auto_hide_roles_enabled === true,
    // Фазовое переключение работает только при включённом авто-скрытии
    rolePhaseSwitch: s.auto_hide_roles_enabled === true && s.role_phase_auto_switch_enabled === true,
  };

  // Автопринятие: тумблер
  if (cfg.autoAccept) enableAutoAccept();
  else disableAutoAccept();

  // Реакция на смену auto_hide_roles_enabled на лету
  if (prevAutoHide && !cfg.autoHideRoles) {
    // Выключили скрытие — показываем роли и снимаем CSS
    showAllRolesCSS();
    setRoleVisibility(true);
    stopInitialAutoHideRole();
  } else if (!prevAutoHide && cfg.autoHideRoles) {
    startInitialAutoHideRole();
  }
}

// ─────────────────────────── публичная фича ───────────────────────────

export const autoStartFeature: Feature = {
  id: "auto-start",
  // Управляется несколькими настройками сразу → включена всегда, гейтит под-поведения внутри.
  settingKey: null,

  enable(ctx) {
    applyConfig(ctx);
    // Игровая страница активна всегда: под-поведения сами проверяют свои тумблеры,
    // а наблюдатели/интервалы дёшевы благодаря общему onDomChange.
    enableGamePage();
  },

  update(ctx) {
    applyConfig(ctx);
  },

  disable() {
    disableAutoAccept();
    disableGamePage();

    // Снять CSS-скрытие и вернуть видимость ролей
    showAllRolesCSS();
    setRoleVisibility(true);

    // Сброс состояния
    cfg = {
      autoAccept: true,
      skipStartScreen: true,
      disableWebcam: false,
      autoHideRoles: false,
      rolePhaseSwitch: false,
    };
    trackedRolesVisible = null;
    rolePhaseInitialized = false;
    lastDetectedRolePhase = null;
    nightAutoShowAttempts = 0;
    nightAutoShowStartedAt = 0;
    suppressRoleKeyHandlingUntil = 0;
    lastManualRoleActionAt = 0;
    webcamDisabled = false;
    videoButtonClicked = false;
  },
};
