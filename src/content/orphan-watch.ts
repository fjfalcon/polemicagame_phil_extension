/**
 * Сторож осиротевшего контент-скрипта.
 *
 * После обновления расширения Chrome НЕ перезапускает контент-скрипты в уже
 * открытых вкладках: старый скрипт продолжает жить «вслепую» — DOM доступен,
 * а extension-контекст мёртв (runtime.id пропадает, storage и messaging
 * бросают). Новый скрипт в старую вкладку не приходит до F5. Для игрока это
 * выглядит как «расширение сломалось»: две жалобы за неделю к 05.08.2026
 * («автопринятие через раз», «роли видны») сводились к этому. Мы выпускаем
 * по 2–3 версии в неделю — каждый релиз даёт волну таких вкладок.
 *
 * Firefox при обновлении убивает старые скрипты целиком — там сторож никогда
 * не сработает, и это нормально: там и симптома нет.
 *
 * Правила:
 *  - обнаружение — только чтение runtime.id: дёшево и не бросает;
 *  - ПОСЛЕ срабатывания никаких extension-API, включая log (его персист умер
 *    вместе с контекстом) — только DOM;
 *  - перезагрузку решает ИГРОК: авто-reload посреди живого матча недопустим;
 *  - баннер идемпотентен (guard по id) и показывается один раз: закрыл —
 *    значит решил, повторно не навязываемся (сторож после показа гаснет).
 */
import { browser } from "@core/env";

export const ORPHAN_BANNER_ID = "pn-orphan-banner";
/** Достаточно редко, чтобы быть бесплатным; достаточно часто, чтобы игрок
 *  узнал о поломке раньше, чем начнёт подозревать расширение. */
const CHECK_INTERVAL_MS = 10_000;

/**
 * Жив ли extension-контекст. У живого runtime.id — непустая строка; у
 * осиротевшего Chrome отдаёт undefined (а экзотические обёртки могут и
 * бросить на доступе — считаем это той же смертью).
 */
export function isContextAlive(runtime: { id?: unknown } | null | undefined): boolean {
  try {
    return typeof runtime?.id === "string" && runtime.id.length > 0;
  } catch {
    return false;
  }
}

/** Нарисовать баннер (идемпотентно). Только DOM — контекст уже мёртв. */
export function renderOrphanBanner(doc: Document): void {
  if (doc.getElementById(ORPHAN_BANNER_ID)) return;
  const el = doc.createElement("div");
  el.id = ORPHAN_BANNER_ID;
  el.style.cssText = `
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 2147483601; display: flex; align-items: center; gap: 12px;
    background: #161c2c; color: #e6e9f0; border: 1px solid rgba(255,255,255,.2);
    border-radius: 10px; padding: 10px 14px; max-width: 560px;
    font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45);
  `;

  const text = doc.createElement("span");
  text.textContent =
    "Расширение Polemica Notes обновилось — обновите страницу, чтобы оно продолжило работать.";

  const reload = doc.createElement("button");
  reload.textContent = "Обновить страницу";
  reload.style.cssText = `
    background: #2c5cff; color: #fff; border: 0; border-radius: 8px;
    padding: 6px 12px; font: inherit; cursor: pointer; white-space: nowrap;
  `;
  reload.addEventListener("click", () => doc.location.reload());

  const close = doc.createElement("button");
  close.textContent = "×";
  close.setAttribute("aria-label", "Закрыть");
  close.style.cssText = `
    background: none; border: 0; color: #9aa3b5; font: 16px/1 system-ui;
    cursor: pointer; padding: 2px 4px;
  `;
  close.addEventListener("click", () => el.remove());

  el.append(text, reload, close);
  (doc.body || doc.documentElement).appendChild(el);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startOrphanWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (isContextAlive(browser?.runtime)) return;
    // Контекст мёртв. Сторож гаснет НАВСЕГДА: если игрок закроет баннер,
    // перерисовывать его — значит переигрывать решение человека.
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      renderOrphanBanner(document);
    } catch {
      // Умер и DOM (вкладка выгружается) — молчим, сказать уже некому.
    }
  }, CHECK_INTERVAL_MS);
}

export function stopOrphanWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
