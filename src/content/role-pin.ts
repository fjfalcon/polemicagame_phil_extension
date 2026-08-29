/**
 * Inline-пин видимости СВОЕЙ роли — единственный владелец.
 *
 * Родился из аудита скрытия ролей 29.08.2026: пин писала obs-panel
 * (автосмена сцен), а «подсмотреть» (auto-start) снимал его вслепую — снимал
 * снимок ЧУЖОГО пина как «исходное состояние», дописывал своё display:none, и
 * роль оставалась скрытой от игрока всю ночь (находка 7). Плюс глобальный
 * латч «скрыто» относился к мёртвому узлу: Vue пересоздавал плитку, пин
 * умирал вместе с ней, а латч продолжал утверждать «скрыто» — настоящая роль
 * была видна в эфире (находки 1–2).
 *
 * Идиома: правда живёт НА УЗЛЕ (data-pn-role-pin), а не в глобальной
 * переменной — пересоздание узла стирает маркер вместе с пином, и pinHolds()
 * честно отвечает «пина больше нет». Снимки хранят приоритеты, чтобы вернуть
 * ровно то, что было до нас.
 *
 * Владельцы по ролям: obs-panel решает, КОГДА пинить (фазы, латч, ретраи);
 * peek из auto-start временно ПОДНИМАЕТ пин (liftPins/restoreLiftedPins) —
 * на время подъёма pinHolds отвечает «держится», чтобы владелец не воевал с
 * подсматриванием.
 */
import { SITE } from "@core/selectors";

export type PinTarget = "visible" | "hidden";

interface RoleStyleSnapshot {
  visibility: string;
  visibilityPriority: string;
  opacity: string;
  opacityPriority: string;
  pointerEvents: string;
  pointerEventsPriority: string;
}

const PIN_ATTR = "data-pn-role-pin";

const snapshots = new WeakMap<HTMLElement, RoleStyleSnapshot>();
const touched = new Set<HTMLElement>();
/** Логическая цель пина (null — пина нет). */
let pinTarget: PinTarget | null = null;
/** Пин временно поднят подсматриванием: стили сняты, цель осталась. */
let lifted = false;

export function getRoleVisibilityTargets(): HTMLElement[] {
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

/** Узел несёт наш пин — его видимостью владеет этот модуль, а не вызывающий. */
export function isPinnedElement(el: HTMLElement): boolean {
  return el.hasAttribute(PIN_ATTR);
}

function setImportant(el: HTMLElement, prop: string, value: string): void {
  if (value) el.style.setProperty(prop, value, "important");
  else el.style.removeProperty(prop);
}

function restoreProp(el: HTMLElement, prop: string, value: string, priority: string): void {
  el.style.removeProperty(prop);
  if (value) el.style.setProperty(prop, value, priority || "");
}

function applyToElement(el: HTMLElement, target: PinTarget): void {
  if (!snapshots.has(el)) {
    snapshots.set(el, {
      visibility: el.style.visibility,
      visibilityPriority: el.style.getPropertyPriority("visibility"),
      opacity: el.style.opacity,
      opacityPriority: el.style.getPropertyPriority("opacity"),
      pointerEvents: el.style.pointerEvents,
      pointerEventsPriority: el.style.getPropertyPriority("pointer-events"),
    });
  }
  touched.add(el);
  const snap = snapshots.get(el)!;
  if (target === "visible") {
    // Показ — тоже пином (inline !important): stylesheet-!important
    // авто-скрытия иначе перебивал бы ночной показ.
    setImportant(el, "visibility", snap.visibility || "visible");
    setImportant(el, "opacity", snap.opacity || "1");
    el.style.pointerEvents = snap.pointerEvents;
  } else {
    setImportant(el, "visibility", "hidden");
    setImportant(el, "opacity", "0");
    el.style.pointerEvents = "none";
  }
  el.setAttribute(PIN_ATTR, target);
}

function stripFromElement(el: HTMLElement): void {
  const snap = snapshots.get(el);
  if (snap) {
    restoreProp(el, "visibility", snap.visibility, snap.visibilityPriority);
    restoreProp(el, "opacity", snap.opacity, snap.opacityPriority);
    restoreProp(el, "pointer-events", snap.pointerEvents, snap.pointerEventsPriority);
  }
  el.removeAttribute(PIN_ATTR);
}

function dropDisconnected(): void {
  for (const el of touched) if (!el.isConnected) touched.delete(el);
}

/** Запинить видимость своей роли. false — целей на странице нет. */
export function pinOwnRole(target: PinTarget): boolean {
  const targets = getRoleVisibilityTargets();
  if (targets.length === 0) return false;
  dropDisconnected();
  for (const el of targets) applyToElement(el, target);
  pinTarget = target;
  lifted = false;
  return true;
}

/**
 * Держится ли пин цели НА ЖИВОМ узле. Vue-пересоздание уносит маркер вместе
 * с узлом — глобальный латч без этой проверки лгал (аудит, находки 1–2).
 * Во время подъёма подсматриванием пин ЛОГИЧЕСКИ держится.
 */
export function pinHolds(target: PinTarget): boolean {
  if (pinTarget !== target) return false;
  if (lifted) return true;
  return getRoleVisibilityTargets().some(
    (el) => el.isConnected && el.getAttribute(PIN_ATTR) === target,
  );
}

/** Снять пины и забыть всё (teardown владельца). */
export function releasePins(): void {
  for (const el of touched) {
    stripFromElement(el);
    snapshots.delete(el);
  }
  touched.clear();
  pinTarget = null;
  lifted = false;
}

/**
 * Поднять пин на время подсматривания. true — пин был и снят; вернуть его
 * обязан restoreLiftedPins() при отпускании. Снимки и цель переживают подъём.
 */
export function liftPins(): boolean {
  if (pinTarget === null || lifted) return false;
  for (const el of touched) stripFromElement(el);
  lifted = true;
  return true;
}

/** Вернуть поднятый пин. Если владелец за это время перепинил — не мешаем. */
export function restoreLiftedPins(): void {
  if (!lifted || pinTarget === null) return;
  lifted = false;
  const target = pinTarget;
  dropDisconnected();
  const targets = getRoleVisibilityTargets();
  for (const el of targets) applyToElement(el, target);
}

/** Тестовый шов: полное обнуление модульного состояния. */
export function resetRolePinForTest(): void {
  releasePins();
}
