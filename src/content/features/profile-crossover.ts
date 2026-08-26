/**
 * Фича: парная статистика на странице профиля (просьба владельца 26.08.2026).
 *
 * Ховер-кнопка за столом отвечает «как мы играли вместе» про соседа по игре,
 * но посмотреть то же самое про ПРОИЗВОЛЬНОГО игрока было негде. Теперь на
 * `/profile/<id>` чужого профиля вставляется карточка «Вместе с вами» с той
 * же таблицей (общий рендер @content/crossover-view — форма владельца от
 * 09.08.2026).
 *
 * Чем проще ховера: id цели уже в URL — резолв ника через рейтинг не нужен.
 *
 * Жизненный цикл: маршрут сообщает URL-роутер (syncProfileCrossoverRoute),
 * вставку сторожит общий onDomChange — профиль рисуется Vue асинхронно, и
 * перерисовка вкладок может смыть нашу карточку. Любая запись в DOM отсюда
 * ИДЕМПОТЕНТНА (инвариант §4): карточка с актуальным data-pn-for не трогается.
 *
 * Гейт — та же настройка, что у ховера (btn_crossover_enabled): это одна
 * фича «пересечения», просто в двух местах.
 */
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import {
  completeHistory,
  crossGames,
  fetchFirstPage,
  fetchHistory,
  oldestDate,
  type Crossover,
  type History,
} from "@core/crossover";
import { getOwnUserId } from "@core/own-user";
import { formatCrossover } from "../crossover-view";
import type { Feature } from "@core/feature";

const SCOPE = "profile-cross";

export const BLOCK_CLASS = "pn-profile-crossover";
/** Готовая сводка живёт 10 минут; неудача — 2, сеть чинится быстрее. */
const GOOD_TTL_MS = 10 * 60_000;
const BAD_TTL_MS = 2 * 60_000;

/** id из пути профиля: «/profile/993», «/profile/993/…». Чистая функция. */
export function profileIdFromPath(pathname: string): string | null {
  const m = /^\/profile\/(\d+)(?:[/?#]|$)/.exec(pathname);
  return m ? m[1] : null;
}

let enabled = false;
let routeId: string | null = null;
let unsubDom: (() => void) | null = null;

const crossCache = new Map<string, { at: number; ttl: number; data: Crossover | null }>();
const inFlight = new Map<string, Promise<Crossover | null>>();
let myHistory: { at: number; data: History } | null = null;
let myHistoryInFlight: Promise<History | null> | null = null;

/** Своя история — одна на все профили и дорогая; кэш + дедупликация. */
async function getMyHistory(myId: number): Promise<History | null> {
  if (myHistory && Date.now() - myHistory.at < GOOD_TTL_MS) return myHistory.data;
  if (myHistoryInFlight) return myHistoryInFlight;
  const p = fetchHistory(myId)
    .then((h) => {
      if (h) myHistory = { at: Date.now(), data: h };
      return h;
    })
    .finally(() => {
      myHistoryInFlight = null;
    });
  myHistoryInFlight = p;
  return p;
}

async function computeCrossover(profileId: string, myId: number): Promise<Crossover | null> {
  const hit = crossCache.get(profileId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
  const running = inFlight.get(profileId);
  if (running) return running;
  const p = (async () => {
    try {
      // Обе истории едут одновременно (урок ховера: ждать по очереди — вдвое дольше).
      const [mine, first] = await Promise.all([getMyHistory(myId), fetchFirstPage(profileId)]);
      if (!mine || !first) {
        crossCache.set(profileId, { at: Date.now(), ttl: BAD_TTL_MS, data: null });
        return null;
      }
      const full = await completeHistory(profileId, first, oldestDate(mine.rows));
      const data = crossGames(mine.rows, full.rows, mine.truncated || full.truncated);
      crossCache.set(profileId, { at: Date.now(), ttl: GOOD_TTL_MS, data });
      return data;
    } catch (e) {
      log.warn(SCOPE, "пересечения профиля не сложились", e);
      crossCache.set(profileId, { at: Date.now(), ttl: BAD_TTL_MS, data: null });
      return null;
    } finally {
      inFlight.delete(profileId);
    }
  })();
  inFlight.set(profileId, p);
  return p;
}

function removeBlock(): void {
  document.querySelector(`.${BLOCK_CLASS}`)?.remove();
}

/** Карточка в стиле карточек профиля (тёмная, скруглённая, Inter). */
function buildBlock(profileId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = BLOCK_CLASS;
  el.dataset.pnFor = profileId;
  el.style.cssText =
    "background:rgba(58,62,35,.26);border-radius:20px;padding:18px 20px;margin-top:14px;" +
    "color:#fff;font:14px/1.6 Inter,system-ui,sans-serif;";
  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:8px;">Вместе с вами</div>` +
    `<div class="pn-cross-body" style="opacity:.7;">Считаем совместные игры…</div>`;
  return el;
}

/**
 * Идемпотентная сверка DOM с маршрутом. Зовётся из onDomChange и route-sync:
 * не на маршруте — карточки нет; на маршруте — карточка одна и с верным id.
 */
function apply(): void {
  if (!enabled || routeId === null) {
    removeBlock();
    return;
  }
  const host = document.querySelector(".profile__right");
  if (!host) return; // Vue ещё рисует — следующая мутация вернёт нас сюда
  const existing = host.querySelector<HTMLElement>(`.${BLOCK_CLASS}`);
  if (existing && existing.dataset.pnFor === routeId) return; // уже актуальна
  // Карточка от прошлого профиля (SPA-переход) — заменяем целиком.
  document.querySelectorAll(`.${BLOCK_CLASS}`).forEach((n) => n.remove());
  const block = buildBlock(routeId);
  // Между «инфо» и вкладками; вкладок нет — в конец колонки.
  const tabs = host.querySelector(".profile__right-tabs");
  if (tabs) host.insertBefore(block, tabs);
  else host.appendChild(block);
  void fillBlock(routeId, block);
}

async function fillBlock(profileId: string, block: HTMLElement): Promise<void> {
  const body = block.querySelector<HTMLElement>(".pn-cross-body");
  if (!body) return;
  const myId = await getOwnUserId();
  if (myId === null) {
    // Не залогинен или профиль ещё не пойман — сравнивать не с кем.
    block.remove();
    return;
  }
  if (String(myId) === profileId) {
    block.remove(); // свой профиль: пересекаться не с кем
    return;
  }
  const data = await computeCrossover(profileId, myId);
  // Пока считали, могли уйти на другой профиль — чужую карточку не трогаем.
  if (routeId !== profileId || !block.isConnected) return;
  if (!data) {
    body.style.opacity = ".7";
    body.textContent = "Пересечения не посчитались — попробуйте обновить страницу";
    return;
  }
  body.style.opacity = "";
  body.innerHTML = formatCrossover(data);
}

/** Маршрут от URL-роутера: id профиля либо null. */
export function syncProfileCrossoverRoute(profileId: string | null): void {
  if (routeId === profileId) return;
  routeId = profileId;
  apply();
}

export const profileCrossoverFeature: Feature = {
  id: "profile-crossover",
  settingKey: "btn_crossover_enabled",

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
    routeId = profileIdFromPath(location.pathname);
    apply();
  },

  disable() {
    enabled = false;
    if (unsubDom) {
      unsubDom();
      unsubDom = null;
    }
    removeBlock();
    crossCache.clear();
    inFlight.clear();
    myHistory = null;
  },
};
