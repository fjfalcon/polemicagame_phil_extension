/**
 * Фича: график MMR на СВОЁМ профиле (просьба владельца 26.08.2026).
 *
 * Сайт показывает текущий рейтинг, но не путь к нему. История игр отдаёт
 * MMR после каждой партии — рисуем спарклайн за последние партии прямо в
 * карточке на /profile/<свой id>. Дополняет «Вместе с вами» (та живёт
 * только на чужих профилях, эта — только на своём: один слот, два жильца
 * без конфликта).
 *
 * Устройство повторяет profile-crossover: маршрут от URL-роутера, вставка
 * из onDomChange идемпотентна (инвариант §4), кэш истории 10 минут.
 * График — инлайновый SVG (никакого canvas/скриптов в мире страницы).
 */
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import { getOwnHistory, type GameRow } from "@core/crossover";
import { getOwnUserId } from "@core/own-user";
import { profileIdFromPath } from "./profile-crossover";
import type { Feature } from "@core/feature";

const SCOPE = "mmr-chart";

export const CHART_CLASS = "pn-mmr-chart";
/** Сколько последних рейтинговых игр рисуем: больше — каша, меньше — обрубок. */
export const CHART_GAMES = 120;
const TTL_MS = 10 * 60_000;

/** ВСЕ значения MMR в хронологическом порядке (старые → новые). */
export function mmrSeriesAll(rows: GameRow[]): number[] {
  return rows
    .filter((r) => typeof r.mmrAfter === "number")
    .sort((a, b) => a.id - b.id)
    .map((r) => r.mmrAfter as number);
}

/** Ряд для РИСУНКА: последние CHART_GAMES игр (дальше линия — каша). */
export function mmrSeries(rows: GameRow[]): number[] {
  return mmrSeriesAll(rows).slice(-CHART_GAMES);
}

export interface MmrFacts {
  /** Значения для полилинии (окно графика). */
  window: number[];
  /** Максимум за ВСЮ доступную историю, а не за окно графика. */
  careerMax: number;
  careerMin: number;
  /** Сколько рейтинговых игр учтено в карьерных числах. */
  careerGames: number;
  /** История упёрлась в лимит выдачи — числа честно «за доступный отрезок». */
  capped: boolean;
}

/**
 * Факты для карточки. Жалоба игрока 27.08.2026: «Max MMR неправильный» —
 * подпись «макс» стояла под максимумом ОКНА графика (120 игр), а карьерный
 * максимум был на 199 очков выше и в другом году. Окно осталось (линия по
 * 3583 играм нечитаема), но ЧИСЛА теперь по всей истории, и подписи говорят,
 * что именно показано.
 */
export function mmrFacts(rows: GameRow[], capped = false): MmrFacts {
  const all = mmrSeriesAll(rows);
  return {
    window: all.slice(-CHART_GAMES),
    careerMax: all.length ? Math.max(...all) : 0,
    careerMin: all.length ? Math.min(...all) : 0,
    careerGames: all.length,
    capped,
  };
}

/**
 * Точки полилинии для viewBox w×h. Чистая функция — сторожится мутационно:
 * перевёрнутая ось Y рисовала бы рост рейтинга падением.
 */
export function chartPoints(values: number[], w: number, h: number, pad = 4): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // плоская линия при равных значениях, не NaN
  return values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      // Ось Y экрана растёт вниз, рейтинг — вверх: инвертируем.
      const y = pad + (1 - (v - min) / span) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

let enabled = false;
let routeId: string | null = null;
let unsubDom: (() => void) | null = null;
/** Вердикт «не мой профиль»: без него самоудаление карточки из fillBlock
 *  зацикливало вставку/удаление через onDomChange (см. profile-crossover,
 *  adversarial 26.08.2026, блокер). */
let hiddenFor: string | null = null;
let cache: { at: number; facts: MmrFacts } | null = null;
let inFlight: Promise<MmrFacts | null> | null = null;

async function loadFacts(myId: number): Promise<MmrFacts | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.facts;
  if (inFlight) return inFlight;
  // ПОЛНАЯ история (жалоба 27.08.2026): карьерный максимум мог быть глубже
  // первой страницы, и подпись «макс» врала. Это общий кэш @core/crossover —
  // один запрос на всю глубину, переиспользуемый пересечениями.
  const p = getOwnHistory(myId)
    .then((h) => {
      if (!h) return null;
      const facts = mmrFacts(h.rows, h.truncated);
      cache = { at: Date.now(), facts };
      return facts;
    })
    .catch((e) => {
      log.warn(SCOPE, "история для графика не загрузилась", e);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = p;
  return p;
}

function removeBlock(): void {
  document.querySelectorAll(`.${CHART_CLASS}`).forEach((n) => n.remove());
}

function buildBlock(profileId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = CHART_CLASS;
  el.dataset.pnFor = profileId;
  el.style.cssText =
    "background:rgba(58,62,35,.26);border-radius:20px;padding:18px 20px;margin-top:14px;" +
    "color:#fff;font:14px/1.6 Inter,system-ui,sans-serif;";
  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:8px;">Путь MMR</div>` +
    `<div class="pn-chart-body" style="opacity:.7;">Строим график…</div>`;
  return el;
}

function renderChart(body: HTMLElement, facts: MmrFacts): void {
  const values = facts.window;
  if (values.length < 2) {
    body.style.opacity = ".7";
    body.textContent = "Рейтинговых игр пока мало — график появится позже";
    return;
  }
  const w = 600;
  const hgt = 140;
  const last = values[values.length - 1];
  const delta = last - values[0];
  const color = delta >= 0 ? "#4ade80" : "#f87171";
  const pts = chartPoints(values, w, hgt);
  // «за доступный отрезок» — та же честная оговорка, что у пересечений:
  // у аккаунта длиннее лимита выдачи карьерный максимум может быть глубже.
  const scope = facts.capped ? "за доступный отрезок" : "за всё время";
  body.style.opacity = "";
  body.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">` +
    `<span style="font-size:22px;font-weight:700;">${last}</span>` +
    `<span style="color:${color};font-weight:600;">${delta >= 0 ? "+" : ""}${delta} за ${values.length} игр</span>` +
    `</div>` +
    `<svg viewBox="0 0 ${w} ${hgt}" style="width:100%;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">` +
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `</svg>` +
    `<div style="display:flex;justify-content:space-between;color:rgba(255,255,255,.45);font-size:12px;">` +
    `<span>график: последние ${values.length} игр</span>` +
    `<span>макс ${facts.careerMax} · мин ${facts.careerMin} (${scope}, ${facts.careerGames} игр)</span>` +
    `</div>`;
}

function apply(): void {
  if (!enabled || routeId === null || routeId === hiddenFor) {
    removeBlock();
    return;
  }
  const host = document.querySelector(".profile__right");
  if (!host) return;
  const existing = host.querySelector<HTMLElement>(`.${CHART_CLASS}`);
  if (existing && existing.dataset.pnFor === routeId) return;
  removeBlock();
  const block = buildBlock(routeId);
  const tabs = host.querySelector(".profile__right-tabs");
  if (tabs) host.insertBefore(block, tabs);
  else host.appendChild(block);
  void fillBlock(routeId, block);
}

async function fillBlock(profileId: string, block: HTMLElement): Promise<void> {
  const body = block.querySelector<HTMLElement>(".pn-chart-body");
  if (!body) return;
  // Пауза перед сетью — как у «Вместе с вами»: листание профилей не должно
  // качать историю на каждый мелькнувший.
  await new Promise((r) => setTimeout(r, 350));
  if (routeId !== profileId || !block.isConnected) return;
  const myId = await getOwnUserId();
  // График — только про себя: чужой профиль обслуживает «Вместе с вами».
  if (myId === null || String(myId) !== profileId) {
    // Вердикт — ДО remove: удаление будит onDomChange, вставлять снова нельзя.
    hiddenFor = profileId;
    block.remove();
    return;
  }
  const facts = await loadFacts(myId);
  if (routeId !== profileId || !block.isConnected) return;
  if (!facts) {
    body.style.opacity = ".7";
    body.textContent = "История не загрузилась — попробуйте обновить страницу";
    return;
  }
  renderChart(body, facts);
}

/** Маршрут от URL-роутера: id профиля либо null. */
export function syncProfileMmrRoute(profileId: string | null): void {
  if (routeId === profileId) return;
  routeId = profileId;
  hiddenFor = null;
  apply();
}

export const profileMmrChartFeature: Feature = {
  id: "profile-mmr-chart",
  settingKey: "profile_mmr_chart_enabled",

  enable() {
    enabled = true;
    unsubDom = onDomChange((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          apply();
          return;
        }
      }
    });
    // Не ждём роутер: он зовёт sync только на СМЕНЕ URL, а включиться
    // могли уже стоя на профиле.
    routeId = profileIdFromPath(location.pathname);
    hiddenFor = null;
    apply();
  },

  disable() {
    enabled = false;
    hiddenFor = null;
    if (unsubDom) {
      unsubDom();
      unsubDom = null;
    }
    removeBlock();
    cache = null;
    inFlight = null;
  },
};
