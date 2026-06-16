/**
 * Метки ролей («мой read»). У каждого игрока — квадратик; по клику выпадает список
 * ролей (Серый/Мирный/Шериф/Мафия/Дон). Выбранная роль красит квадратик.
 *
 * Хранится В ПАМЯТИ на сессию: переживает смену день/ночь и пересборку DOM,
 * но сбрасывается при перезагрузке страницы / выходе из игры — это личное
 * мнение на текущую игру, а не постоянная заметка (для постоянных — цветные метки).
 */
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import { SITE } from "@core/selectors";
import type { Feature } from "@core/feature";

interface RoleDef {
  id: string;
  label: string;
  abbr: string;
  color: string;
  text: string;
}

const ROLES: RoleDef[] = [
  { id: "none", label: "Серый", abbr: "?", color: "#6b7280", text: "#ffffff" },
  { id: "civ", label: "Мирный", abbr: "Мир", color: "#22c55e", text: "#06210f" },
  { id: "sheriff", label: "Шериф", abbr: "Шер", color: "#eab308", text: "#2b2000" },
  { id: "mafia", label: "Мафия", abbr: "Маф", color: "#111827", text: "#ffffff" },
  { id: "don", label: "Дон", abbr: "Дон", color: "#7f1d1d", text: "#ffffff" },
];
const roleById = (id: string) => ROLES.find((r) => r.id === id) || ROLES[0];

// Метки на текущую игру (в памяти). Ключ — ник игрока.
const marks = new Map<string, string>();

const MARKER_CLASS = "pn-role-marker";
const MENU_CLASS = "pn-role-menu";

let offDom: (() => void) | null = null;
let closeMenu: (() => void) | null = null;

function usernameOf(player: Element): string | null {
  const name = player.querySelector(SITE.playerName)?.textContent?.trim();
  return name || null;
}

function paintMarker(marker: HTMLElement, roleId: string): void {
  const r = roleById(roleId);
  marker.style.background = r.color;
  marker.style.color = r.text;
  marker.textContent = r.abbr;
  marker.title = `Мой read: ${r.label}`;
}

function openMenu(marker: HTMLElement, username: string): void {
  closeMenu?.();

  const menu = document.createElement("div");
  menu.className = MENU_CLASS;
  const rect = marker.getBoundingClientRect();
  menu.style.cssText = `
    position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; z-index: 2147483600;
    background: #1e1f26; border: 1px solid rgba(255,255,255,.15); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 4px; min-width: 120px;
    font: 12px system-ui, sans-serif;
  `;

  for (const r of ROLES) {
    const item = document.createElement("button");
    item.style.cssText = `
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
      background: transparent; border: none; color: #e6e9f0; cursor: pointer;
      padding: 6px 8px; border-radius: 6px; font: inherit;
    `;
    item.addEventListener("mouseenter", () => (item.style.background = "rgba(255,255,255,.08)"));
    item.addEventListener("mouseleave", () => (item.style.background = "transparent"));
    item.innerHTML = `<span style="width:14px;height:14px;border-radius:4px;flex:0 0 auto;border:1px solid rgba(0,0,0,.4);background:${r.color}"></span><span>${r.label}</span>`;
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (r.id === "none") marks.delete(username);
      else marks.set(username, r.id);
      paintMarker(marker, r.id);
      closeMenu?.();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  const onOutside = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== marker) closeMenu?.();
  };
  closeMenu = () => {
    document.removeEventListener("click", onOutside, true);
    window.removeEventListener("scroll", closeMenu as () => void, true);
    menu.remove();
    closeMenu = null;
  };
  // Вешаем на следующий тик, чтобы текущий клик не закрыл меню сразу.
  setTimeout(() => {
    document.addEventListener("click", onOutside, true);
    window.addEventListener("scroll", closeMenu as () => void, true);
  }, 0);
}

function ensureMarker(player: HTMLElement): void {
  const username = usernameOf(player);
  if (!username) return;

  let marker = player.querySelector<HTMLElement>(`.${MARKER_CLASS}`);
  if (!marker) {
    if (getComputedStyle(player).position === "static") player.style.position = "relative";
    marker = document.createElement("button");
    marker.className = MARKER_CLASS;
    marker.style.cssText = `
      position: absolute; top: 6px; left: 6px; width: 26px; height: 24px;
      border-radius: 6px; border: 1px solid rgba(0,0,0,.45); cursor: pointer; z-index: 6;
      font: 700 10px system-ui, sans-serif; display: flex; align-items: center;
      justify-content: center; padding: 0;
    `;
    marker.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(marker!, usernameOf(player) || username);
    });
    player.appendChild(marker);
  }
  marker.dataset.username = username;
  paintMarker(marker, marks.get(username) || "none");
}

function scan(): void {
  document.querySelectorAll<HTMLElement>(SITE.player).forEach(ensureMarker);
}

export const roleMarkerFeature: Feature = {
  id: "role-marker",
  settingKey: "role_marker_enabled",
  enable() {
    scan();
    offDom = onDomChange(() => scan());
    log.info("role-marker", "enabled");
  },
  disable() {
    offDom?.();
    offDom = null;
    closeMenu?.();
    document.querySelectorAll(`.${MARKER_CLASS}, .${MENU_CLASS}`).forEach((el) => el.remove());
    marks.clear();
  },
};
