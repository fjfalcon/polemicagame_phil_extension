/**
 * Иконки ролей из СПРАЙТА САЙТА (#civilian/#sheriff/#mafia/#godfather).
 *
 * Жил приватными методами внутри player-notes (тултип последних игр); вынесен,
 * когда иконки понадобились и меткам ролей (просьба владельца 15.08.2026:
 * «использовать иконки из бандла сайта» вместо подписей Мир/Шер/Дон). Два
 * экземпляра одной и той же эвристики разъехались бы при первом изменении
 * сайта.
 *
 * Эвристика поиска спрайта (порядок важен, поведение прежнее, из 8.1.x):
 *  1. инлайновые <symbol> на странице — href без файла;
 *  2. живой <use> с ролевым фрагментом — берём его файл;
 *  3. любой <use> на бандловый .svg — берём файл;
 *  4. зашитый фолбэк по маршруту комнаты.
 */
import { SITE } from "@core/selectors";

let cachedBase: string | null = null;

/** Сброс кэша — для смены страницы/тестов (спрайт у комнат разный). */
export function resetRoleSpriteCache(): void {
  cachedBase = null;
}

export function resolveRoleSpriteBaseUrl(): string {
  if (cachedBase !== null) return cachedBase;

  const roleMarkers = ["#civilian", "#sheriff", "#mafia", "#godfather"];

  if (document.querySelector(SITE.roleSymbols)) {
    cachedBase = "";
    return cachedBase;
  }

  const useElements = document.querySelectorAll(SITE.roleUse);

  for (const useEl of Array.from(useElements)) {
    const rawHref = useEl.getAttribute("href") || useEl.getAttribute("xlink:href");
    if (!rawHref) continue;
    if (roleMarkers.includes(rawHref)) {
      cachedBase = "";
      return cachedBase;
    }
    if (!rawHref.includes("/bundle/") || !rawHref.includes(".svg")) continue;
    if (!roleMarkers.some((m) => rawHref.includes(m))) continue;
    const base = rawHref.split("#")[0];
    if (base) {
      cachedBase = base;
      return base;
    }
  }

  for (const useEl of Array.from(useElements)) {
    const rawHref = useEl.getAttribute("href") || useEl.getAttribute("xlink:href");
    if (!rawHref) continue;
    if (!rawHref.includes("/bundle/") || !rawHref.includes(".svg")) continue;
    const base = rawHref.split("#")[0];
    if (base) {
      cachedBase = base;
      return base;
    }
  }

  const defaultPrefix = window.location.pathname.includes("/new-room/")
    ? "/new-room/bundle/"
    : "/room/bundle/";
  cachedBase = `${defaultPrefix}f59bacbc2885635c4d91.svg`;
  return cachedBase;
}

/** Разметка <svg><use> на ролевой фрагмент спрайта. roleId — id сайта. */
export function createRoleSvg(roleId: string, size: number): string {
  const base = resolveRoleSpriteBaseUrl();
  const href = `${base}#${roleId}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:xlink", "http://www.w3.org/1999/xlink");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", href);
  use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
  svg.appendChild(use);
  return svg.outerHTML;
}
