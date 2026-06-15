/**
 * Уведомление о новой версии. Раз в N часов проверяет последний релиз на GitHub
 * и, если он новее установленной версии, показывает ненавязчивый баннер со ссылкой
 * на страницу релиза. «Закрыть» прячет баннер для этой версии (больше не напоминаем).
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import type { Feature } from "@core/feature";

const REPO = "fjfalcon/polemicagame_phil_extension";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 часов
const LS_LAST_CHECK = "polemica:updateLastCheck";
const LS_LATEST = "polemica:updateLatest";
const LS_DISMISSED = "polemica:updateDismissed";

let banner: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Сравнение версий вида 8.1.4. Возвращает true, если a > b. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватный режим */
  }
}

function currentVersion(): string {
  return browser.runtime.getManifest().version;
}

function showBanner(latest: string): void {
  if (banner) return;
  if (lsGet(LS_DISMISSED) === latest) return;

  banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 2147483600; display: flex; align-items: center; gap: 12px;
    background: #1e1f26; color: #fff; padding: 10px 14px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.15); box-shadow: 0 8px 30px rgba(0,0,0,.45);
    font: 13px system-ui, sans-serif;
  `;

  const text = document.createElement("span");
  text.textContent = `Доступна новая версия Polemica Notes (${latest}) — обновитесь`;

  const link = document.createElement("a");
  link.href = RELEASES_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Обновить";
  link.style.cssText =
    "background:#3b82f6;color:#fff;text-decoration:none;padding:5px 12px;border-radius:8px;font-weight:600;";

  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Не напоминать про эту версию";
  close.style.cssText =
    "background:transparent;border:none;color:#fff;cursor:pointer;font-size:14px;line-height:1;";
  close.addEventListener("click", () => {
    lsSet(LS_DISMISSED, latest);
    banner?.remove();
    banner = null;
  });

  banner.append(text, link, close);
  document.body.appendChild(banner);
}

async function check(): Promise<void> {
  const last = parseInt(lsGet(LS_LAST_CHECK) || "0", 10);
  const cachedLatest = lsGet(LS_LATEST);

  // Если недавно проверяли — используем кэш, не дёргаем API.
  if (cachedLatest && Date.now() - last < CHECK_INTERVAL) {
    if (isNewer(cachedLatest, currentVersion())) showBanner(cachedLatest);
    return;
  }

  try {
    const res = await fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const data = await res.json();
    const tag = String(data.tag_name || "").replace(/^v/, "");
    if (!tag) return;
    lsSet(LS_LAST_CHECK, String(Date.now()));
    lsSet(LS_LATEST, tag);
    log.debug("update-notify", "latest", tag, "current", currentVersion());
    if (isNewer(tag, currentVersion())) showBanner(tag);
  } catch (e) {
    log.debug("update-notify", "check failed", e);
  }
}

export const updateNotifyFeature: Feature = {
  id: "update-notify",
  settingKey: "update_check_enabled",
  enable() {
    // Небольшая задержка, чтобы не мешать загрузке страницы.
    timer = setTimeout(() => void check(), 4000);
  },
  disable() {
    if (timer) clearTimeout(timer);
    timer = null;
    banner?.remove();
    banner = null;
  },
};
