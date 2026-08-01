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
import { onDomChange, safeClick, isVisible } from "@core/dom";
import { keyboard } from "@core/keyboard";
import { log } from "@core/log";
import { SITE, TEXT, OWN, classifyPhaseText } from "@core/selectors";
import { isAutoAcceptSuppressed } from "../auto-accept-gate";
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
let acceptScanTimer: ReturnType<typeof setTimeout> | null = null;
let videoButtonClicked = false;

// Игровая страница
let gameInterval: ReturnType<typeof setInterval> | null = null;
let unsubGameDom: (() => void) | null = null;
let unsubKeyboard: (() => void) | null = null;
let roleHideKey = "KeyD";
let onRoleMenuClick: ((e: MouseEvent) => void) | null = null;
let onUserClick: ((e: Event) => void) | null = null;
let webcamDisabled = false;
/** 10 кликов не выключили камеру — до следующего лобби не пытаемся. */
let webcamGaveUp = false;
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

/** Кликабельные кандидаты на «Принять игру» — вместо обхода всего документа. */
const ACCEPT_CANDIDATE_SELECTOR =
  'button, a, [role="button"], div.cursor-pointer, [class*="accept"]';

/**
 * Элементы с текстом «Принять игру».
 *
 * Раньше здесь был querySelectorAll("*"): textContent наследуется, поэтому под
 * фильтр попадали html, body и вся цепочка контейнеров — и все они получали
 * safeClick раз в секунду. Берём только кликабельные узлы и оставляем самые
 * глубокие совпадения.
 */
/** Панель принятия игры — вне её мы не кликаем ничего (см. ниже). */
const ACCEPT_SCOPE_SELECTOR =
  ".p-play__profile-accept, .p-play-profile__wr, .p-play__profile-panel";

function findAcceptTextElements(): HTMLElement[] {
  const matched = Array.from(
    document.querySelectorAll<HTMLElement>(ACCEPT_CANDIDATE_SELECTOR),
  ).filter(
    (el) =>
      containsAny(norm(el), TEXT.acceptGameText) &&
      // Гейт по контейнеру: текстовый фолбэк кликал любой элемент страницы с
      // подстрокой «принять игру» — сайт (или его будущая разметка) мог
      // подсунуть посторонний элемент с таким текстом (аудит безопасности
      // 01.08.2026, находка 11).
      el.closest(ACCEPT_SCOPE_SELECTOR) !== null,
  );
  return matched.filter((el) => !matched.some((other) => other !== el && el.contains(other)));
}

/**
 * Бюджет автокликов: не больше нескольких попыток на один и тот же элемент.
 * Если элемент не ушёл из DOM после трёх кликов — он не про приём игры,
 * и продолжать жать его значит воевать с интерфейсом (или с игроком).
 */
const acceptClickCounts = new WeakMap<Element, number>();
const MAX_ACCEPT_CLICKS_PER_ELEMENT = 3;

function consumeClickBudget(el: Element): boolean {
  if (!isVisible(el)) return false;
  const used = acceptClickCounts.get(el) ?? 0;
  if (used >= MAX_ACCEPT_CLICKS_PER_ELEMENT) return false;
  acceptClickCounts.set(el, used + 1);
  return true;
}

function clickAcceptButtons() {
  // Приём игры существует ТОЛЬКО на странице поиска. Без гейта скан шёл
  // каждую секунду на ЛЮБОЙ странице, включая игровую комнату, где точные
  // тексты «готов»/«подтвердить» — это подписи ИГРОВЫХ кнопок: лишний CPU
  // всегда и риск клика по чужому диалогу.
  if (!location.pathname.startsWith("/game-search")) return;
  // Идёт разведка очереди — принимать игру нельзя ни в коем случае
  // (см. content/auto-accept-gate.ts).
  if (isAutoAcceptSuppressed()) return;
  // Игрок только что кликал сам — не вмешиваемся, он пользуется интерфейсом.
  if (Date.now() - lastUserClickAt < USER_ACTION_BACKOFF_MS) return;

  const acceptGameElements = findAcceptTextElements();

  // ТОЧНОЕ совпадение текста, а не подстрока: «Не готов» содержит «готов»,
  // «Подтвердить пароль» — «подтвердить». Прежний вариант жал любую такую
  // кнопку на любой странице сайта, включая подтверждения во время голосования.
  // Кнопки внутри стартового окна не трогаем — у clickStartGameButton свой
  // лимит попыток и бэкофф, и обходить их отсюда нельзя (окно настроек камеры —
  // то же самое окно).
  // Кнопка должна лежать в контексте приёма игры (.p-play*/profile-accept):
  // точная «Подтвердить» — типовая подпись ЛЮБОГО диалога сайта, и без гейта
  // по контейнеру расширение подтверждало чужие диалоги на любой странице.
  const readyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (btn) =>
      (TEXT.acceptGameButton as readonly string[]).includes(norm(btn)) &&
      !btn.closest(SITE.welcomeModal) &&
      !!btn.closest('[class*="p-play"], [class*="profile-accept"], [class*="accept"]'),
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
      .filter(
        (el) =>
          containsAny(norm(el), TEXT.acceptGameText) &&
          // Тот же scope-гейт, что в findAcceptTextElements: без него любой
          // div.cursor-pointer с текстом «принять игру» где угодно на странице
          // оставался кликабельным (аудит безопасности, находка 11).
          el.closest(ACCEPT_SCOPE_SELECTOR) !== null,
      )
      .forEach((el) => gameAcceptDivs.push(el));
  } catch (e) {
    log.debug(SCOPE, "cursor-pointer accept selector failed", e);
  }

  // Прежний fallback «по названию режима» (культурный/обычный/без цензуры)
  // удалён: textContent наследуется, и под фильтр попадал любой крупный
  // cursor-pointer контейнер с названием режима где-то внутри — расширение
  // кликало по нему на каждый батч мутаций. Это был главный оставшийся цикл.

  try {
    Array.from(document.querySelectorAll<HTMLElement>(SITE.profileAccept)).forEach((el) =>
      gameAcceptDivs.push(el),
    );
  } catch (e) {
    log.debug(SCOPE, "profileAccept selector failed", e);
  }

  gameAcceptDivs = Array.from(new Set(gameAcceptDivs));
  // Оставляем только самые глубокие совпадения: textContent наследуется, и в
  // список попадали родитель И дитя — оба получали клик (дедуп 8.1.22 закрыл
  // это только для findAcceptTextElements, а div-ветку — нет).
  gameAcceptDivs = gameAcceptDivs.filter(
    (el) => !gameAcceptDivs.some((other) => other !== el && el.contains(other)),
  );

  // Клик по обычным кнопкам
  readyButtons.forEach((button) => {
    if (!consumeClickBudget(button)) return;
    log.debug(SCOPE, "click accept button", button.textContent);
    button.click();

    // После старта — один раз пытаемся включить видео
    if (!videoButtonClicked) {
      setTimeout(() => {
        const videoButton = findWebcamButton();
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
    if (consumeClickBudget(div)) safeClick(div);
  });

  // Доп. элементы с текстом «Принять игру»
  acceptGameElements.forEach((el) => {
    if (readyButtons.includes(el as HTMLButtonElement) || gameAcceptDivs.includes(el)) return;
    if (consumeClickBudget(el)) safeClick(el);
  });
}

function enableAutoAccept() {
  if (acceptInterval !== null) return;
  log.info(SCOPE, "auto-accept enabled");
  videoButtonClicked = false;
  acceptInterval = setInterval(clickAcceptButtons, 1000);
  // Подписка на мутации нужна только чтобы отреагировать на появление карточки
  // быстрее, чем раз в секунду. Без дросселя она вызывала скан+клики на каждый
  // батч мутаций (до 60 раз/с) и обходила интервал-ограничитель: клик порождал
  // перерисовку, перерисовка — новый клик.
  unsubAcceptDom = onDomChange((muts) => {
    if (acceptScanTimer !== null) return;
    if (!muts.some((m) => m.addedNodes.length)) return;
    acceptScanTimer = setTimeout(() => {
      acceptScanTimer = null;
      clickAcceptButtons();
    }, 250);
  });
}

function disableAutoAccept() {
  if (acceptInterval !== null) {
    clearInterval(acceptInterval);
    acceptInterval = null;
  }
  unsubAcceptDom?.();
  unsubAcceptDom = null;
  // Хвост дросселя: без этого через ≤250 мс после выключения прилетал
  // ещё один скан с кликами.
  if (acceptScanTimer !== null) {
    clearTimeout(acceptScanTimer);
    acceptScanTimer = null;
  }
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

    // Игрок только что сам скрыл/показал роль (D-D «глянул и спрятал») —
    // не переигрываем его решение принудительным показом.
    if (Date.now() - lastManualRoleActionAt < 2000) {
      log.debug(SCOPE, "night-show skipped: recent manual action");
      return;
    }
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

    // Верификация показа: синтетический D мог съесть dBlocker подмены роли,
    // или элементы ещё не смонтированы. Раньше счётчик попыток нигде не
    // инкрементировался (только обнулялся) — ретрай был мёртв со времён legacy.
    setTimeout(() => {
      const el = getPrimaryOwnRoleElement();
      const stillHidden = el ? getRoleUseHref(el).includes("#stop") : false;
      if (
        stillHidden &&
        cfg.rolePhaseSwitch &&
        lastDetectedRolePhase === "night" &&
        Date.now() - lastManualRoleActionAt > 2000
      ) {
        nightAutoShowAttempts++;
        if (nightAutoShowAttempts < 5) {
          log.debug(SCOPE, "night-show retry", nightAutoShowAttempts);
          scheduleNightRoleAutoShow(1000);
        }
      } else {
        nightAutoShowAttempts = 0;
      }
    }, 500);
  }, delayMs);
}

function getTexts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector))
    .map((el) => norm(el))
    .filter(Boolean);
}

// Классификация вынесена в selectors.ts (classifyPhaseText) — она общая с
// автосценами OBS. Причина появления: «Голосование мафии» (ночной этап
// в одном из словарей сайта) содержит дневное «голос» — раньше это включало
// «день» посреди ночи, прятало роли и воевало с ночным показом
// («подглючивает с переключением ролей», жалоба 31.07.2026).
function isNightText(text: string): boolean {
  return classifyPhaseText(text) === "night";
}

function isDayText(text: string): boolean {
  return classifyPhaseText(text) === "day";
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

  // (Ветка window.obsFloatingPanel удалена — этот объект нигде не определялся,
  // наследие legacy page-script; в изолированном мире её не существовало.)

  // 4) Любые .stage/.substage — последний fallback
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

/**
 * Скип стартового окна не должен воевать с игроком.
 *
 * Раньше эта функция вызывалась раз в секунду И на каждый батч мутаций, и жала
 * «Начать игру» безусловно. Если игрок сам открывал настройки камеры/звука
 * (это то же модальное окно), расширение закрывало их снова и снова.
 *
 * Теперь: не больше нескольких попыток на одно появление окна и пауза после
 * любого действия игрока — окно, которое он открыл сам, остаётся открытым.
 */
const MAX_START_CLICK_ATTEMPTS = 3;
const USER_ACTION_BACKOFF_MS = 5000;
let startClickAttempts = 0;
let startModalSeen = false;
let lastUserClickAt = 0;

function clickStartGameButton() {
  if (!cfg.skipStartScreen) return;

  const welcomeModal = document.querySelector<HTMLElement>(SITE.welcomeModal);
  if (!welcomeModal) {
    // Окно закрылось — следующее появление получит свежий лимит попыток.
    startModalSeen = false;
    startClickAttempts = 0;
    return;
  }
  if (!startModalSeen) {
    startModalSeen = true;
    startClickAttempts = 0;
  }

  // Игрок только что кликал — он пользуется интерфейсом, не мешаем.
  if (Date.now() - lastUserClickAt < USER_ACTION_BACKOFF_MS) return;

  // Окно не ушло после нескольких попыток — значит оно нужно игроку.
  if (startClickAttempts >= MAX_START_CLICK_ATTEMPTS) return;

  const modalText = norm(welcomeModal);
  const hasWelcomeText = containsAny(modalText, TEXT.welcome);

  const startButtons = Array.from(welcomeModal.querySelectorAll<HTMLButtonElement>("button")).filter(
    (btn) => containsAny((btn.textContent || "").toLowerCase(), TEXT.startGameButton),
  );

  if (!hasWelcomeText && startButtons.length === 0) return;

  startClickAttempts++;
  if (startClickAttempts === MAX_START_CLICK_ATTEMPTS) {
    log.info(SCOPE, "start-screen skip: attempt limit reached, leaving modal alone");
  }

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

/**
 * У кнопки камеры и кнопки настроек ОДИН И ТОТ ЖЕ класс
 * (div.button.preset-1.small.desktop-version) — селектором их не различить.
 * Раньше брался первый попавшийся элемент, и если это оказывалась шестерёнка,
 * расширение открывало/закрывало окно настроек до 10 раз подряд.
 * Различаем по иконке/подписи; если уверенности нет — не кликаем вовсе.
 */
/**
 * Иконки кнопок управления (webpack content-hash, снято с живого лобби
 * 27.07.2026). Хеш детерминирован содержимым файла, поэтому меняется только
 * при перерисовке иконки — тогда сработает позиционный фолбэк ниже.
 */
const CAMERA_ICON_HASHES = ["516810fd6c1e38f17335", "edf479f3365a51e1beca"]; // camera, camera-off
const NON_CAMERA_ICON_HASHES = [
  "652f9184e845e10a12e5", // mic
  "3a2b1603137ca0fb3eeb", // mic-off
  "e3a7cf4ee64b975985ad", // settings
];

function iconSrcOf(el: HTMLElement): string {
  return el.querySelector<HTMLImageElement>("img.button__icon")?.getAttribute("src") || "";
}

/**
 * Найти кнопку камеры среди кнопок управления комнатой.
 *
 * У камеры, микрофона и настроек ОДИН класс и НИ ОДНОГО текстового признака:
 * ни title, ни aria-label, а подпись хоткея в шаблоне сайта закомментирована
 * (`<!-- <span v-if="hotKey" -->` — проверено в живом лобби 27.07.2026).
 * Поэтому 8.1.41 с детектом по букве «V» не находил ничего, а прежняя версия
 * искала use[href]/title — их тоже нет. Единственный настоящий признак —
 * иконка (img.button__icon с хешированным именем).
 *
 * Порядок распознавания:
 *  1. хеш иконки в известном списке камеры → это она;
 *  2. хеш в списке «точно не камера» → пропускаем кандидата;
 *  3. иконка незнакома (сайт перерисовал) → позиционный фолбэк по шаблону
 *     [камера?, микрофон, настройки]: камера есть только когда кнопок ровно
 *     три, и она первая. Меньше трёх — камеры нет, НЕ кликаем: ошибка тут
 *     означала бы выключенный микрофон или открытые настройки.
 */
function findWebcamButton(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(SITE.webcamButton));
  if (candidates.length === 0) return null;

  const known = candidates.find((el) =>
    CAMERA_ICON_HASHES.some((hash) => iconSrcOf(el).includes(hash)),
  );
  if (known) return known;

  const allIconsKnown = candidates.every((el) => {
    const src = iconSrcOf(el);
    return NON_CAMERA_ICON_HASHES.some((hash) => src.includes(hash));
  });
  if (allIconsKnown) {
    // Все кнопки опознаны и камеры среди них нет (например, судья без видео).
    log.debug(SCOPE, "camera button absent among known icons");
    return null;
  }

  if (candidates.length === 3) {
    log.debug(SCOPE, "camera icon unknown — falling back to position 0 of 3");
    return candidates[0];
  }
  log.debug(SCOPE, `camera button not identified (${candidates.length} candidates) — skip`);
  return null;
}

/**
 * Предыгровой экран (в шаблоне сайта — стадия `voting_for_game_start`).
 *
 * Раньше требовалось СОВПАДЕНИЕ ТЕКСТА `.new-stage__name` со списком
 * «идет набор игроков» И наличие ссылки-приглашения. Оба условия протухли
 * (сверено с живым лобби и room-бандлом 27.07.2026):
 *  • в этом блоке теперь локализованный текст стадии («Голосование за начало
 *    игры»), слова «набор игроков» в комнатном бандле нет вообще — совпадение
 *    не срабатывало НИКОГДА, и камера не выключалась даже при найденной кнопке;
 *  • `.invitation-link` рендерится только когда у комнаты есть ссылка
 *    (в лиге её нет), так что требовать его нельзя.
 * Признак структурный и не зависит от языка: `.new-stage__name` существует
 * ТОЛЬКО на предыгровом экране (в остальных стадиях там `.stage__name`).
 */
function isInLobby(): boolean {
  if (document.querySelector(SITE.lobbyStageName)) return true;
  return document.querySelector(SITE.invitationLink) !== null;
}

function disableWebcams() {
  if (!isInLobby()) {
    // Вышли из лобби — сброс флагов: раньше webcamDisabled жил до disable(),
    // и в следующей игре той же вкладки камера не отключалась.
    webcamDisabled = false;
    webcamGaveUp = false;
    return;
  }
  if (webcamDisabled || webcamGaveUp) return;
  if (cfg.disableWebcam) {
    log.debug(SCOPE, "webcam disabling forbidden by setting");
    return;
  }
  // Интервал уже работает — не перезапускаем: каждый повторный вызов (тик 1с
  // + каждый батч мутаций) обнулял clickCount, превращая лимит 10 кликов
  // в бесконечные 5 кликов/с.
  if (webcamClickInterval) return;

  const webcamButton = findWebcamButton();
  if (!webcamButton) return;

  if (webcamButton.classList.contains(SITE.webcamButtonOffClass)) {
    webcamDisabled = true;
    return;
  }

  log.debug(SCOPE, "webcam on, turning off...");
  try {
    let clickCount = 0;
    const maxClicks = 10;

    webcamClickInterval = setInterval(() => {
      if (clickCount >= maxClicks) {
        if (webcamClickInterval) clearInterval(webcamClickInterval);
        webcamClickInterval = null;
        // Не помогло за 10 кликов — сдаёмся до следующего лобби, а не
        // начинаем заново с нулевым счётчиком.
        webcamGaveUp = true;
        return;
      }
      const currentButton = findWebcamButton();
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

function handleRoleKey(e?: KeyboardEvent) {
  if (Date.now() < suppressRoleKeyHandlingUntil) return;

  lastManualRoleActionAt = Date.now();

  // Если роли скрыты CSS — убираем CSS, показываем роли
  if (isRolesHiddenByCSS()) {
    // Гасим событие для сайта: иначе его собственный toggle срабатывал
    // ОДНОВРЕМЕННО с нашим снятием CSS — роль оставалась скрытой нативно,
    // а trackedRolesVisible становился true. Со второго нажатия — полная
    // инверсия учёта (роль видна, расширение уверено, что скрыта), и все
    // авто-решения дальше принимались по перевёрнутому состоянию.
    e?.stopPropagation();
    showAllRolesCSS();
    // Под CSS роль могла быть скрыта и нативно — досылаем D сайту сами.
    const primary = getPrimaryOwnRoleElement();
    if (getRoleUseHref(primary).includes("#stop")) dispatchNativeRoleToggle();
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

  // Отмечаем действия игрока, чтобы автоклики не спорили с ним.
  // isTrusted отсекает наши же синтетические клики.
  onUserClick = (e: Event) => {
    if ((e as MouseEvent).isTrusted) lastUserClickAt = Date.now();
  };
  document.addEventListener("click", onUserClick, true);
  document.addEventListener("pointerdown", onUserClick, true);

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
  if (onUserClick) {
    document.removeEventListener("click", onUserClick, true);
    document.removeEventListener("pointerdown", onUserClick, true);
  }
  onUserClick = null;
  startModalSeen = false;
  startClickAttempts = 0;
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

  const prevPhaseSwitch = cfg.rolePhaseSwitch;
  cfg = {
    autoAccept: s.auto_accept_enabled === true,
    skipStartScreen: s.skip_start_screen_enabled !== false,
    disableWebcam: s.disable_webcam_clicks === true,
    autoHideRoles: s.auto_hide_roles_enabled === true,
    // Фазовое переключение работает только при включённом авто-скрытии
    rolePhaseSwitch: s.auto_hide_roles_enabled === true && s.role_phase_auto_switch_enabled === true,
  };

  // Выключили фазовое переключение — гасим уже взведённый ночной таймер:
  // раньше он переживал выключение (проверка настройки жила в пути, который
  // сам этой настройкой гейтится) и через ≤3с показывал роль вопреки тумблеру.
  if (prevPhaseSwitch && !cfg.rolePhaseSwitch && pendingNightRoleShowTimer) {
    clearTimeout(pendingNightRoleShowTimer);
    pendingNightRoleShowTimer = null;
  }

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
