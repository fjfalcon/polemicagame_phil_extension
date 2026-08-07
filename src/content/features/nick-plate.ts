/**
 * Фича: плашка игрока — сворачивание ника «гармошкой» и её угол на плитке.
 *
 * Просьбы владельца (07–08.08.2026): «плашка 2 Cobalt ⓟ занимает место, а
 * в игре ориентируются по номерам — свернуть бы её до цифры» и «хочется
 * двигать: слева вверху или справа внизу».
 *
 * Разметка сайта (сверена с живым room/bundle/main.js и room/bundle/style.css):
 *   <div class="player">                        ← position: relative
 *     <div class="player__topleftmenu">…</div>   ← absolute, left/top .625rem
 *     <div class="player__toprightmenu">…</div>  ← absolute, right/top .625rem
 *     <div class="player__botleftmenu">          ← absolute, left/bottom .625rem
 *       <div class="player__info info" @click="showPlayerPreview">
 *         <div class="player-number player-N">N+1</div>
 *         <span class="info__name">ник</span>
 *         <img class="info__sub"> <img class="info__prime">
 *       </div>
 *       …сюда же наши иконки игрока (.player-icons)
 *     </div>
 *
 * Отсюда два решения:
 *  - СВОРАЧИВАНИЕ — чистый CSS по классу на <html>: ни одной записи в DOM
 *    сайта на тик (инвариант §4 п.1), Vue нечего у нас затирать;
 *  - ПОЗИЦИЯ — переопределение углов у КОНТЕЙНЕРА `.player__botleftmenu`, а
 *    не у самой плашки: плашка лежит внутри absolute-контейнера, и её
 *    собственный absolute считался бы от него же, а не от плитки. Заодно
 *    вместе с ником переезжают наши иконки — они и так один блок.
 *    Для верхних углов держим отступ вниз: там уже живут меню сайта
 *    (готовность слева, фолы и «…» справа), и лезть под них нельзя.
 *
 * Индивидуальный разворот ника живёт в модульном Set позиций, а в DOM
 * попадает атрибутом `data-pn-nick` — идемпотентно и только при изменении.
 * Vue перерисовкой атрибут снять может, следующий тик вернёт.
 *
 * Переключение — клик по НОМЕРУ, перехваченный в capture с остановкой
 * всплытия: у плашки висит сайтовый onClick (превью игрока), и без этого
 * каждое сворачивание открывало бы чужое окно. Перехват работает ТОЛЬКО
 * при включённом сворачивании — выключил, и клики снова целиком сайтовые.
 */
import { onDomChange } from "@core/dom";
import { OWN, SITE } from "@core/selectors";
import { log } from "@core/log";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";
import { PLATE_POSITIONS, readPlatePosition } from "@shared/nick-plate";
import type { PlatePosition } from "@shared/nick-plate";

const SCOPE = "nick-plate";

/** Класс-переключатель сворачивания на <html>. */
export const ROOT_CLASS = "pn-compact-nicks";
/** Префикс класса позиции: `pn-nick-pos-top-left` и т.п. */
export const POS_CLASS_PREFIX = "pn-nick-pos-";
/** Атрибут развёрнутой вручную плашки. */
const OPEN_ATTR = "data-pn-nick";
const STYLE_ID = "pn-nick-plate-styles";


/**
 * Отступ сверху для верхних углов: там уже стоят меню сайта (готовность и
 * роль слева, фолы и «…» справа). Плашка встаёт ПОД ними, а не поверх.
 */
const TOP_OFFSET = "3.25rem";
/** Отступ сайта от края плитки — повторяем, чтобы углы выглядели родными. */
const EDGE = "0.625rem";
/**
 * На сколько ряд наших иконок отстоит от плашки. Значение — из notes.css
 * (`.player-icons { top: -28px }`): там ряд висит НАД плашкой, потому что
 * снизу у плитки край. При верхнем угле это выглядит наоборот — иконки
 * прилипают к самой кромке, а номер оказывается под ними, поэтому там мы
 * ряд переворачиваем вниз (просьба владельца 08.08.2026).
 */
const ICONS_OFFSET = "28px";

/** Позиции (id игрока из класса `player-N`), развёрнутые вручную. */
const opened = new Set<string>();

let settings: Settings | null = null;
let unsubscribe: (() => void) | null = null;
let clickListener: ((e: Event) => void) | null = null;
/** Что применено сейчас — чтобы не трогать DOM, когда ничего не изменилось. */
let appliedCompact = false;
let appliedPosition: PlatePosition = "default";

function compactOn(): boolean {
  return settings?.compact_nicknames_enabled === true;
}

/**
 * id игрока по элементу номера: сайт даёт классы `player-number player-N`,
 * где N — id (0-based), а текстом рисует N+1. Берём класс, а не текст:
 * текст — это то, что видит человек, а класс — то, чем сайт различает
 * плитки, и он не зависит от локали и форматирования.
 */
export function playerIdFromNumberEl(el: Element): string | null {
  for (const cls of Array.from(el.classList)) {
    const m = /^player-(\d+)$/.exec(cls);
    if (m) return m[1];
  }
  return null;
}

/**
 * Решение по клику: какой плашке переключать состояние. Чистая функция —
 * тестовый шов: jsdom не умеет доверенные события, а поведение перехвата
 * обязано быть покрыто мутационно.
 */
export function resolveToggleTarget(target: Element): { id: string; info: HTMLElement } | null {
  const numberEl = target.closest(SITE.playerNumber);
  if (!numberEl) return null;
  const info = numberEl.closest<HTMLElement>(SITE.playerInfo);
  if (!info) return null;
  const id = playerIdFromNumberEl(numberEl);
  return id === null ? null : { id, info };
}

/** CSS позиции для одного угла. Пустая строка — оставить как у сайта. */
export function positionCss(position: PlatePosition): string {
  if (position === "default") return "";
  const corner: Record<Exclude<PlatePosition, "default">, string> = {
    "top-left": `top: ${TOP_OFFSET}; bottom: auto; left: ${EDGE}; right: auto;`,
    "top-right": `top: ${TOP_OFFSET}; bottom: auto; right: ${EDGE}; left: auto;`,
    "bottom-right": `bottom: ${EDGE}; top: auto; right: ${EDGE}; left: auto;`,
  };
  // Правые углы выравнивают содержимое по правому краю — иначе иконки и
  // плашка «висят» слева от угла и выглядят сдвинутыми.
  const align = position === "top-left" ? "" : " align-items: flex-end;";
  // Ряд иконок абсолютен относительно плашки (notes.css): у верхних углов
  // разворачиваем его ВНИЗ, у правых — прижимаем к правому краю плашки.
  const iconsTop = position.startsWith("top-")
    ? `top: auto !important; bottom: -${ICONS_OFFSET} !important;`
    : "";
  const iconsSide = position.endsWith("-right")
    ? " left: auto !important; right: 0 !important;"
    : "";
  const icons = iconsTop || iconsSide
    ? `
    .${POS_CLASS_PREFIX}${position} ${SITE.playerInfo} > .${OWN.playerIcons} {
      ${iconsTop}${iconsSide}
    }`
    : "";
  return `
    .${POS_CLASS_PREFIX}${position} ${SITE.plateContainer} {
      ${corner[position]}${align}
    }${icons}`;
}

/**
 * Стили фичи одной строкой.
 *
 * Ключевое про сворачивание: ширину «пустой полосы» держит РОДИТЕЛЬ, а не
 * спрятанные дети. Сайт задаёт плашке gap .438rem и padding .25rem .684rem
 * .25rem .25rem, а марджины ника у него и так нули; скрытые элементы
 * остаются флекс-айтемами, поэтому все зазоры сохраняются. Без обнуления
 * gap и правого паддинга свёрнутая плашка выходила вдвое шире номера
 * (ревью 08.08.2026, блокер). !important обязателен: селектор сайта
 * специфичнее нашего.
 */
function styleText(): string {
  return `
    .${ROOT_CLASS} .player__info:not([${OPEN_ATTR}="open"]) {
      gap: 0 !important;
      padding-right: 0.25rem !important;
      transition: gap .18s ease, padding-right .18s ease;
    }
    .${ROOT_CLASS} ${SITE.playerName},
    .${ROOT_CLASS} .player__info .info__sub,
    .${ROOT_CLASS} .player__info .info__prime {
      max-width: 0 !important;
      opacity: 0;
      overflow: hidden;
      white-space: nowrap;
      transition: max-width .18s ease, opacity .14s ease;
    }
    .${ROOT_CLASS} .player__info[${OPEN_ATTR}="open"] .info__name,
    .${ROOT_CLASS} .player__info[${OPEN_ATTR}="open"] .info__sub,
    .${ROOT_CLASS} .player__info[${OPEN_ATTR}="open"] .info__prime {
      max-width: 240px !important;
      opacity: 1;
    }
    /* Номер — ручка гармошки: показываем это курсором. */
    .${ROOT_CLASS} .player__info ${SITE.playerNumber} { cursor: pointer; }
${PLATE_POSITIONS.map(positionCss).join("")}
  `;
}

function syncStyles(needed: boolean): void {
  const existing = document.getElementById(STYLE_ID);
  if (!needed) {
    existing?.remove();
    return;
  }
  const css = styleText();
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/** Привести атрибуты плашек к состоянию Set. Идемпотентно (§4 п.1). */
function syncOpenAttrs(): void {
  for (const info of Array.from(document.querySelectorAll<HTMLElement>(SITE.playerInfo))) {
    const numberEl = info.querySelector(SITE.playerNumber);
    const id = numberEl ? playerIdFromNumberEl(numberEl) : null;
    const shouldOpen = id !== null && opened.has(id);
    const isOpen = info.getAttribute(OPEN_ATTR) === "open";
    if (shouldOpen === isOpen) continue;
    if (shouldOpen) info.setAttribute(OPEN_ATTR, "open");
    else info.removeAttribute(OPEN_ATTR);
  }
}

function clearOpenAttrs(): void {
  for (const info of Array.from(document.querySelectorAll<HTMLElement>(SITE.playerInfo))) {
    info.removeAttribute(OPEN_ATTR);
  }
}

/** Классы на <html>: один переключатель сворачивания, один — позиции. */
function syncRootClasses(compact: boolean, position: PlatePosition): void {
  const root = document.documentElement;
  if (root.classList.contains(ROOT_CLASS) !== compact) root.classList.toggle(ROOT_CLASS, compact);
  for (const pos of PLATE_POSITIONS) {
    if (pos === "default") continue;
    const cls = `${POS_CLASS_PREFIX}${pos}`;
    const want = position === pos;
    if (root.classList.contains(cls) !== want) root.classList.toggle(cls, want);
  }
}

/** Привести всё к текущим настройкам. Идемпотентна, зовётся и из update(). */
function applyState(): void {
  const compact = compactOn();
  const position = readPlatePosition(settings?.nick_plate_position);
  const needed = compact || position !== "default";
  syncStyles(needed);
  syncRootClasses(compact, position);
  if (!compact) {
    // Свёрнутых больше нет — и разворачивать нечего.
    opened.clear();
    clearOpenAttrs();
  } else {
    syncOpenAttrs();
  }
  if (compact !== appliedCompact || position !== appliedPosition) {
    appliedCompact = compact;
    appliedPosition = position;
    log.info(SCOPE, "плашка игрока:", compact ? "ник свёрнут" : "ник целиком", "| угол:", position);
  }
}

export const nickPlateFeature: Feature = {
  // Выключателя нет: фича обслуживает ДВЕ настройки (сворачивание и угол), и
  // каждая может быть включена отдельно. Пока обе в дефолте, applyState()
  // не создаёт ни стилей, ни классов — цена присутствия нулевая.
  id: "nick-plate",
  settingKey: null,

  enable(ctx: FeatureContext) {
    settings = ctx.settings;
    clickListener = (e: Event) => {
      if (!compactOn()) return;
      if (!(e.target instanceof Element)) return;
      const hit = resolveToggleTarget(e.target);
      if (!hit) return;
      // Гасим ДО сайта: на плашке висит его собственный onClick (превью
      // игрока), и без этого каждое сворачивание открывало бы чужое окно.
      e.preventDefault();
      e.stopPropagation();
      if (opened.has(hit.id)) {
        opened.delete(hit.id);
        hit.info.removeAttribute(OPEN_ATTR);
      } else {
        opened.add(hit.id);
        hit.info.setAttribute(OPEN_ATTR, "open");
      }
    };
    document.addEventListener("click", clickListener, true);
    unsubscribe = onDomChange((records) => {
      // Ранний выход по состоянию: штатный режим — «всё свёрнуто», Set пуст,
      // и синхронизировать нечего. Дальше — фильтр по типу мутации:
      // `data-pn-nick` наблюдатель не видит вовсе (attributeFilter —
      // class/style), снять атрибут может только пересоздание узла, то есть
      // childList. Атрибутные батчи (таймеры, индикаторы речи) — большинство
      // на игровой странице, и они нам не интересны (ревью 08.08.2026).
      if (!compactOn() || opened.size === 0) return;
      for (const record of records) {
        if (record.type === "childList") {
          syncOpenAttrs();
          return;
        }
      }
    });
    applyState();
  },

  update(ctx: FeatureContext) {
    settings = ctx.settings;
    applyState();
  },

  disable() {
    unsubscribe?.();
    unsubscribe = null;
    if (clickListener) {
      document.removeEventListener("click", clickListener, true);
      clickListener = null;
    }
    opened.clear();
    clearOpenAttrs();
    syncRootClasses(false, "default");
    syncStyles(false);
    appliedCompact = false;
    appliedPosition = "default";
    settings = null;
  },
};
