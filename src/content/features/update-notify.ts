/**
 * Уведомление о новой версии. Раз в N часов проверяет последний релиз на GitHub
 * и, если он новее установленной версии, показывает ненавязчивый баннер со ссылкой
 * на страницу релиза. «Закрыть» прячет баннер для этой версии (больше не напоминаем).
 */
import { browser, isStoreInstall } from "@core/env";
import { log } from "@core/log";
import type { Feature } from "@core/feature";

const REPO = "fjfalcon/polemicagame_phil_extension";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/**
 * Час, а не шесть: расширение раздаётся зипами через GitHub, и баннер —
 * единственный канал доставки новостей о релизе. С шестичасовым окном
 * пользователь узнавал о версии почти через сутки (жалоба 27.07.2026:
 * «уведомление не прилетает, версия вышла 5 минут назад» — на самом деле
 * работал кэш). Один запрос в час на браузер лимитам GitHub не мешает.
 */
const CHECK_INTERVAL = 60 * 60 * 1000;

/**
 * Состояние проверки — в storage.local, НЕ в localStorage страницы:
 * localStorage принадлежит сайту (AGENTS.md §5 — недоверенный источник, сайт
 * может подделать «последнюю версию» или проставить dismissed), и он не виден
 * попапу, которому нужна кнопка ручной проверки.
 */
const KEY_LAST_CHECK = "pn_update_last_check";
const KEY_LATEST = "pn_update_latest";
const KEY_DISMISSED = "pn_update_dismissed";

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

async function stateGet(): Promise<{ last: number; latest: string; dismissed: string }> {
  try {
    const res = await browser.storage.local.get({
      [KEY_LAST_CHECK]: 0,
      [KEY_LATEST]: "",
      [KEY_DISMISSED]: "",
    });
    return {
      last: Number(res[KEY_LAST_CHECK]) || 0,
      latest: String(res[KEY_LATEST] || ""),
      dismissed: String(res[KEY_DISMISSED] || ""),
    };
  } catch {
    return { last: 0, latest: "", dismissed: "" };
  }
}

function currentVersion(): string {
  return browser.runtime.getManifest().version;
}

function showBanner(latest: string, dismissed: string): void {
  if (banner) return;
  if (dismissed === latest) return;

  banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 2147483600; display: flex; align-items: center; gap: 12px;
    background: #1e1f26; color: #fff; padding: 10px 14px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.15); box-shadow: 0 8px 30px rgba(0,0,0,.45);
    font: 13px system-ui, sans-serif;
  `;

  // Сторовая установка обновляется самим браузером (и только после проверки
  // стором — версия с GitHub может быть ещё недоступна), поэтому призыв
  // «обновитесь» со ссылкой на zip тут не только бесполезен, но и вреден:
  // ручная установка поверх сторовой ломает автообновление.
  const store = isStoreInstall();
  const text = document.createElement("span");
  text.textContent = store
    ? `Вышла версия Polemica Notes ${latest} — браузер обновит расширение сам`
    : `Доступна новая версия Polemica Notes (${latest}) — обновитесь`;

  const link = document.createElement("a");
  link.href = RELEASES_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = store ? "Что нового" : "Обновить";
  link.style.cssText =
    "background:#3b82f6;color:#fff;text-decoration:none;padding:5px 12px;border-radius:8px;font-weight:600;";

  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Не напоминать про эту версию";
  close.style.cssText =
    "background:transparent;border:none;color:#fff;cursor:pointer;font-size:14px;line-height:1;";
  close.addEventListener("click", () => {
    void browser.storage.local.set({ [KEY_DISMISSED]: latest });
    banner?.remove();
    banner = null;
  });

  banner.append(text, link, close);
  document.body.appendChild(banner);
}

async function check(): Promise<void> {
  const { last, latest: cachedLatest, dismissed } = await stateGet();

  // Если недавно проверяли — используем кэш, не дёргаем API.
  if (cachedLatest && Date.now() - last < CHECK_INTERVAL) {
    // Раньше эта ветка молчала, и «баннер не появляется» выглядело как
    // поломка сети/API, хотя запроса просто не было.
    log.debug(
      "update-notify",
      "кэш свеж, запрос не нужен: latest",
      cachedLatest,
      "current",
      currentVersion(),
    );
    if (isNewer(cachedLatest, currentVersion())) showBanner(cachedLatest, dismissed);
    return;
  }

  try {
    const res = await fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) {
      log.debug("update-notify", "GitHub ответил", res.status);
      return;
    }
    const data = await res.json();
    const tag = String(data.tag_name || "").replace(/^v/, "");
    if (!tag) return;
    await browser.storage.local.set({ [KEY_LAST_CHECK]: Date.now(), [KEY_LATEST]: tag });
    log.debug("update-notify", "latest", tag, "current", currentVersion());
    if (isNewer(tag, currentVersion())) showBanner(tag, dismissed);
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
