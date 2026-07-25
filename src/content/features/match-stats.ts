/**
 * Фича: пост-игровая статистика на странице /match/:id.
 * Слушает document-событие `gameDataParsed` и строит таблицу фаз
 * (дневные голосования, ночные действия), индикаторы «лучшего хода»
 * и точки штрафов. Порт match-enhancer.js.
 *
 * Гейтится настройкой match_page_stats_enabled (а также statistics_enabled —
 * это учитывает FeatureManager на уровне регистрации; здесь дополнительно
 * проверяем оба флага из ctx.settings, как в оригинале).
 */
import { SITE } from "@core/selectors";
import { onDomChange } from "@core/dom";
import { escapeHtml } from "@core/escape";
import { log } from "@core/log";
import { getLastGameData, getMatchId } from "../match-data";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const SCOPE = "match-stats";

// ───────────────────────── состояние для очистки ─────────────────────────

let settings: Settings | null = null;
let gameDataListener: ((event: Event) => void) | null = null;
/** Исходная разметка заголовка сайта — восстанавливается при disable(). */
let originalHeaderHtml: string | null = null;
let originalHeaderElement: HTMLElement | null = null;
let originalHeaderStyle: string | null = null;
let originalHeaderHadScopeAttr = false;
const intervals = new Set<ReturnType<typeof setInterval>>();
const timeouts = new Set<ReturnType<typeof setTimeout>>();
const injectedStyles: HTMLStyleElement[] = [];
const originalInlineStyles = new Map<HTMLElement, string | null>();
let activeMatchId: string | null = null;
let previousRouteTable: WeakRef<HTMLElement> | null = null;
let previousRouteTableHtml = "";
let previousRouteMatchId: string | null = null;
let routeReadyInterval: ReturnType<typeof setInterval> | null = null;
let routeDomUnsub: (() => void) | null = null;
let pendingGameData: any = null;
let lastPendingRetryAt = 0;

function trackInterval(id: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
  intervals.add(id);
  return id;
}
function clearTrackedInterval(id: ReturnType<typeof setInterval>): void {
  clearInterval(id);
  intervals.delete(id);
}
function trackTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    timeouts.delete(id);
    fn();
  }, ms);
  timeouts.add(id);
  return id;
}

function appendStyle(css: string, id?: string): HTMLStyleElement {
  // С id — переиспользуем существующий элемент. Без этого вызовы из
  // периодических задач добавляли новый <style> на каждый тик.
  if (id) {
    const existing = document.getElementById(id) as HTMLStyleElement | null;
    if (existing) {
      if (existing.textContent !== css) existing.textContent = css;
      return existing;
    }
  }
  const style = document.createElement("style");
  if (id) style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  injectedStyles.push(style);
  return style;
}

/**
 * Идемпотентная запись style. applyAutoHeight крутится по таймеру раз в 5 сек
 * и раньше переписывал десятки атрибутов на каждом тике — это будило общий
 * MutationObserver и всех его подписчиков вхолостую.
 */
function setStyleAttr(el: Element, css: string): void {
  if (el instanceof HTMLElement && !originalInlineStyles.has(el)) {
    originalInlineStyles.set(el, el.getAttribute("style"));
  }
  if (el.getAttribute("style") !== css) el.setAttribute("style", css);
}

/** То же для отдельного свойства. */
function setStyleProp(el: HTMLElement, prop: "height" | "maxHeight", value: string): void {
  if (!originalInlineStyles.has(el)) originalInlineStyles.set(el, el.getAttribute("style"));
  if (el.style[prop] !== value) el.style[prop] = value;
}

function statsEnabled(): boolean {
  return !(
    settings?.statistics_enabled === false || settings?.match_page_stats_enabled === false
  );
}

function clearPreviousRouteSnapshot(): void {
  previousRouteTable = null;
  previousRouteTableHtml = "";
  previousRouteMatchId = null;
}

function isRouteDomReady(): boolean {
  const header = document.querySelector<HTMLElement>(SITE.statsHeader);
  const table = document.querySelector<HTMLElement>(SITE.statsTable);
  if (!header || !table) return false;
  return !(
    table === previousRouteTable?.deref() && table.innerHTML === previousRouteTableHtml
  );
}

// ───────────────────────── построение таблицы ─────────────────────────

function enhance(gameData: any): void {
  // Идемпотентность + защита от SPA-гонки: повторное событие или ожидание
  // таблицы, пережившее переход на другой матч, раньше давало дубликаты строк
  // и вставку данных ЧУЖОГО матча в свежеоткрытую таблицу.
  const matchIdAtStart = getMatchId() || "";
  // Данные должны принадлежать ЭТОЙ странице: кэш getLastGameData при
  // перевключении тумблера после SPA-перехода приносил матч A на страницу B.
  if (gameData?.id && String(gameData.id) !== matchIdAtStart) {
    log.debug(SCOPE, "cached data is for another match, skip", gameData.id, matchIdAtStart);
    return;
  }
  if (!isRouteDomReady()) {
    pendingGameData = gameData;
    return;
  }
  pendingGameData = null;
  clearPreviousRouteSnapshot();
  removeEnhancements();

  const header = document.querySelector<HTMLElement>(SITE.statsHeader);
  if (header) {
    const gameId = gameData.id || "";
    if (originalHeaderHtml === null) {
      originalHeaderHtml = header.innerHTML;
      originalHeaderElement = header;
      originalHeaderStyle = header.getAttribute("style");
      originalHeaderHadScopeAttr = header.hasAttribute("data-v-33ae8458");
    }

    // winnerCode: 0 = мирные. Отсутствие поля раньше уверенно рисовало
    // «Победа мафии» — теперь нейтральный заголовок.
    const hasWinner = typeof gameData.winnerCode === "number";
    const isMafiaWin = hasWinner && gameData.winnerCode !== 0;
    const winnerColor = !hasWinner ? "#94a3b8" : isMafiaWin ? "#ef4444" : "#22c55e";
    const winnerText = !hasWinner ? "" : isMafiaWin ? "Победа мафии" : "Победа мирных";

    header.style.cssText = `
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 16px 24px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    `;

    header.innerHTML = `
      <span class="header-info" style="font-size: 24px; color: #0ea5e9;">Статистика игры (ID${escapeHtml(
        String(gameId),
      )})</span>
      <span class="header-info text-right" style="font-size: 24px; color: ${winnerColor}; font-weight: 500;">${escapeHtml(
        winnerText,
      )}</span>
    `;

    header.setAttribute("data-v-33ae8458", "");
  }

  log.debug(SCOPE, "Starting page enhancement");
  // Ждём появления таблицы.
  const checkTable = trackInterval(
    setInterval(() => {
      // SPA-переход на другой матч — данные этого больше не актуальны.
      if ((getMatchId() || "") !== matchIdAtStart) {
        clearTrackedInterval(checkTable);
        return;
      }
      const table = document.querySelector<HTMLElement>(SITE.statsTable);
      if (table) {
        clearTrackedInterval(checkTable);
        enhanceTable(table, gameData);
        // Небольшая задержка для гарантированного добавления точек.
        trackTimeout(() => {
          addPenaltyIndicators(table, gameData);
        }, 100);
      } else {
        log.debug(SCOPE, "Table not found, retrying...");
      }
    }, 500),
  );

  // Прекращаем поиск через 10 секунд.
  trackTimeout(() => clearTrackedInterval(checkTable), 10000);
}

function removeEnhancements(): void {
  document
    .querySelectorAll(
      ".row[data-phase], .best-move-dot, .best-move-tooltip, .penalty-dots, .pn-timeline",
    )
    .forEach((element) => element.remove());
}

/** Вернуть заголовок сайта как был (мы его переписываем через innerHTML). */
function restoreHeader(): void {
  if (originalHeaderHtml === null) return;
  const header = originalHeaderElement;
  if (header) {
    header.innerHTML = originalHeaderHtml;
    if (originalHeaderStyle === null) header.removeAttribute("style");
    else header.setAttribute("style", originalHeaderStyle);
    if (!originalHeaderHadScopeAttr) header.removeAttribute("data-v-33ae8458");
  }
  originalHeaderHtml = null;
  originalHeaderElement = null;
  originalHeaderStyle = null;
  originalHeaderHadScopeAttr = false;
}

function restoreInlineStyles(): void {
  for (const [element, style] of originalInlineStyles) {
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
  }
  originalInlineStyles.clear();
}

/**
 * ЕДИНАЯ палитра ролей (канон 8.1.30, согласована с владельцем):
 * мирный красный, шериф жёлтый, мафия светло-серая, дон фиолетовый.
 * До этого в проекте жили ЧЕТЫРЕ разные палитры — один и тот же игрок был
 * белым в голосах, синим в тултипе и серым в метках.
 */
export const ROLE_COLORS: Record<number, string> = {
  0: "#c084fc", // дон
  1: "#d1d5db", // мафия
  2: "#f87171", // мирный
  3: "#facc15", // шериф
};

function voterStyleFor(role: number): string {
  return `color: ${ROLE_COLORS[role] ?? ROLE_COLORS[2]};`;
}

function voterClassFor(role: number): string {
  let cls = "voter";
  if (role === 0) cls += " don-vote";
  if (role === 1) cls += " mafia-vote";
  if (role === 3) cls += " sheriff-vote";
  return cls;
}

function renderVotesBlock(
  voteList: any[],
  players: any[],
  extraStyle = "",
  tip = "",
  tourLabel = "",
): string {
  const spans = voteList
    .map((v) => {
      const voter = players.find((p) => p.position === v.from);
      const role = voter ? voter.role : -1;
      return `<span class="${voterClassFor(role)}" style="${voterStyleFor(
        role,
      )}">${escapeHtml(String(v.from))}</span>`;
    })
    .join("");
  const tipAttr = tip ? ` data-tip="${escapeHtml(tip)}"` : "";
  // Видимая подпись тура: три безымянных ряда чипов было невозможно прочитать
  // («почему у игрока 1 три группы цифр?»).
  const label = tourLabel
    ? `<span class="pn-tour-label">${escapeHtml(tourLabel)}</span>`
    : "";
  return `<div class="action"${extraStyle ? ` style="${extraStyle}"` : ""}${tipAttr}>${label}${spans}</div>`;
}

function enhanceTable(table: HTMLElement, gameData: any): void {
  const gameDetails = gameData.data || {};
  const players = gameDetails.players || [];
  const phases = processGamePhases(gameDetails);

  const rows = Array.from(table.querySelectorAll<HTMLElement>(SITE.statsRow));
  const roleRow = rows.find(
    (row) => row.querySelector(SITE.statsCellTitle)?.textContent?.trim() === "Роль",
  );

  if (!roleRow) {
    log.debug(SCOPE, "Role row not found");
    return;
  }

  let lastInsertedRow: HTMLElement = roleRow;
  phases.forEach((phase, index) => {
    const phaseNumber = index + 1;

    // Строка дня.
    const dayRow = document.createElement("div");
    dayRow.className = "row";
    dayRow.setAttribute("data-v-1db9d42a", "");
    dayRow.setAttribute("data-phase", `day-${phaseNumber}`);

    const dayTitleCell = document.createElement("div");
    dayTitleCell.className = "cell title role";
    dayTitleCell.innerHTML = `<span class="phase-title">${phaseNumber} ☀️</span>`;
    dayRow.appendChild(dayTitleCell);

    players.forEach((player: any) => {
      const cell = document.createElement("div");
      cell.className = "cell player role";
      cell.setAttribute("data-player", String(player.position));

      const votes = phase.day.filter((a: any) => a.to === player.position);
      const firstVotes = votes.filter((v: any) => !v.num);
      const secondVotes = votes.filter((v: any) => v.num === 1);
      const thirdVotes = votes.filter((v: any) => v.num === 2);

      let html = "";
      if (firstVotes.length > 0) {
        html += renderVotesBlock(
          firstVotes,
          players,
          "",
          `Голосование за №${player.position}`,
          "осн.",
        );
      }
      if (secondVotes.length > 0) {
        html += renderVotesBlock(
          secondVotes,
          players,
          "margin-top: 4px;",
          `Переголосовка за №${player.position}`,
          "перег.",
        );
      }
      if (thirdVotes.length > 0) {
        html += renderVotesBlock(
          thirdVotes,
          players,
          "margin-top: 4px;",
          `Голосование за подъём (№${player.position})`,
          "подъём",
        );
      }

      cell.style.cssText = `
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 0;
      `;
      cell.innerHTML = html;
      dayRow.appendChild(cell);
    });

    lastInsertedRow.insertAdjacentElement("afterend", dayRow);
    lastInsertedRow = dayRow;

    if (phase.night.length > 0) {
      const nightRow = createNightRow(phaseNumber, phase, players);
      lastInsertedRow.insertAdjacentElement("afterend", nightRow);
      lastInsertedRow = nightRow;
    }
  });

  // Таймлайн со сворачиванием: детальные строки фаз спрятаны, над таблицей —
  // компактная строка на каждый день (итог голосования + ночь + штрафы);
  // клик по строке раскрывает подробности. Таблица вдвое короче.
  buildPhaseTimeline(table, players, phases, gameDetails);

  trackTimeout(() => {
    addBestMoveIndicators(table, gameData);
    log.debug(SCOPE, "Best move indicators added");
  }, 100);
}

function buildPhaseTimeline(
  table: HTMLElement,
  players: any[],
  phases: Array<{ day: any[]; night: any[] }>,
  gameDetails: any,
): void {
  const detailRowsByPhase = new Map<number, HTMLElement[]>();
  table.querySelectorAll<HTMLElement>(".row[data-phase]").forEach((row) => {
    const m = row.getAttribute("data-phase")?.match(/^(?:day|night)-(\d+)$/);
    if (!m) return;
    const n = parseInt(m[1], 10);
    if (!detailRowsByPhase.has(n)) detailRowsByPhase.set(n, []);
    detailRowsByPhase.get(n)!.push(row);
    row.style.display = "none";
    row.classList.add("pn-phase-detail");
  });
  if (detailRowsByPhase.size === 0) return;

  const roleOf = (pos: number): number =>
    players.find((p: any) => p.position === pos)?.role ?? 2;
  const chip = (pos: number, extra = ""): string =>
    `<span class="pn-tl-chip" style="${voterStyleFor(roleOf(pos))}">${escapeHtml(String(pos))}${extra}</span>`;

  const timeline = document.createElement("div");
  timeline.className = "pn-timeline";

  phases.forEach((phase, index) => {
    const n = index + 1;
    // Итог голосования: последний тур (осн./переголос.), голоса по кандидатам.
    const votes = phase.day.filter((a: any) => a.type === "vote");
    const finalNum = votes.reduce((mx: number, v: any) => Math.max(mx, v.num || 0), 0);
    const finalVotes = votes.filter((v: any) => (v.num || 0) === finalNum);
    const counts = new Map<number, number>();
    for (const v of finalVotes) counts.set(v.to, (counts.get(v.to) || 0) + 1);
    const tourName = finalNum === 0 ? "" : finalNum === 1 ? " (перег.)" : " (подъём)";
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // Ничья по максимуму голосов: верхний чип НЕ «уехавший» (реальный день 1
    // референс-матча — шесть кандидатов по голосу, никто не покинул стол).
    const isTie = sorted.length >= 2 && sorted[0][1] === sorted[1][1];
    const dayHtml = counts.size
      ? sorted.map(([pos, cnt]) => chip(pos, `<i>·${cnt}</i>`)).join("") +
        escapeHtml(tourName) +
        (isTie ? '<span class="pn-tl-none"> · ничья</span>' : "")
      : '<span class="pn-tl-none">без голосования</span>';

    const nightHtml = phase.night
      .map(
        (a: any) =>
          `<span class="pn-tl-night">${getActionIcon(a.type)}${chip(a.to)}</span>`,
      )
      .join("");

    // Штрафы этой фазы (день ИЛИ ночь) — видны даже при свёрнутых деталях.
    // Дедуп — страховка по образцу penaltyKey у точек (в референс-JSON
    // penalty лежит один раз, в массиве инициатора; дублей там НЕТ, но
    // точки исторически защищаются от них — держим паритет).
    const seenPens = new Set<string>();
    const penaltyHtml = players
      .flatMap((p: any) => p.penalties || [])
      .filter((pen: any) => {
        if (pen?.stage?.day !== n && pen?.stage?.night !== n) return false;
        const key = `${pen.type}|${pen.initiator}|${pen.player}|${pen.stage?.day ?? ""}|${pen.stage?.night ?? ""}`;
        if (seenPens.has(key)) return false;
        seenPens.add(key);
        return true;
      })
      .map((pen: any) => `<span class="pn-tl-pen">⚠${escapeHtml(String(pen.player))}</span>`)
      .join("");

    const line = document.createElement("div");
    line.className = "pn-tl-line";
    line.innerHTML =
      `<span class="pn-tl-toggle">▸</span>` +
      `<span class="pn-tl-phase">${n} ☀️</span><span class="pn-tl-group">${dayHtml}</span>` +
      (nightHtml ? `<span class="pn-tl-phase">🌙</span><span class="pn-tl-group">${nightHtml}</span>` : "") +
      penaltyHtml;

    line.addEventListener("click", () => {
      const rows = detailRowsByPhase.get(n) || [];
      const show = rows[0]?.style.display === "none";
      rows.forEach((r) => (r.style.display = show ? "" : "none"));
      const t = line.querySelector(".pn-tl-toggle");
      if (t) t.textContent = show ? "▾" : "▸";
    });

    timeline.appendChild(line);
  });

  const root = table.closest<HTMLElement>(SITE.statsTableRoot) || table;
  root.parentElement?.insertBefore(timeline, root);

  appendStyle(
    `
    .pn-timeline { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px;
      padding: 10px 14px; background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(255,255,255,.08); border-radius: 12px; }
    .pn-tl-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      cursor: pointer; padding: 3px 4px; border-radius: 6px; font-size: 13px; }
    .pn-tl-line:hover { background: rgba(255,255,255,.05); }
    .pn-tl-toggle { color: #8b90a0; width: 12px; }
    .pn-tl-phase { color: #8b90a0; font-size: 12px; }
    .pn-tl-group { display: inline-flex; gap: 5px; align-items: center; flex-wrap: wrap; }
    .pn-tl-chip { background: rgba(255,255,255,.07); border-radius: 5px;
      padding: 1px 7px; font-size: 12px; }
    .pn-tl-chip i { font-style: normal; color: #8b90a0; font-size: 11px; }
    .pn-tl-night { display: inline-flex; align-items: center; gap: 2px; }
    .pn-tl-none { color: #5b6070; font-size: 12px; }
    .pn-tl-pen { color: #fbbf24; font-size: 12px; margin-left: 4px; }
    .pn-tour-label { color: rgba(255,255,255,.45); font-size: 10px;
      margin-right: 4px; align-self: center; }
  `,
    "pn-timeline-styles",
  );
}

function createNightRow(phaseNumber: number, phase: any, players: any[]): HTMLElement {
  const nightRow = document.createElement("div");
  nightRow.className = "row";
  nightRow.setAttribute("data-v-1db9d42a", "");
  nightRow.setAttribute("data-phase", `night-${phaseNumber}`);

  const nightTitleCell = document.createElement("div");
  nightTitleCell.className = "cell title";
  nightTitleCell.innerHTML = `<span class="phase-title">${phaseNumber} 🌙</span>`;
  nightRow.appendChild(nightTitleCell);

  players.forEach((player) => {
    const cell = document.createElement("div");
    cell.className = "cell player";
    cell.setAttribute("data-player", String(player.position));

    const actions = phase.night.filter((a: any) => a.from === player.position);
    cell.innerHTML = actions
      .map((action: any) => {
        const icon = getActionIcon(action.type);
        return `<div class="action ${escapeHtml(String(action.type))}" data-tip="${escapeHtml(
          actionTip(action.type, action.to),
        )}">
          ${icon} ${escapeHtml(String(action.to))}
        </div>`;
      })
      .join("");

    nightRow.appendChild(cell);
  });

  return nightRow;
}

// ───────────────────────── индикаторы «лучшего хода» ─────────────────────────

function addBestMoveIndicators(table: HTMLElement, gameData: any): void {
  const players = gameData.data?.players || [];

  players.forEach((player: any) => {
    if (
      player.guess?.completed ||
      player.guess?.mafs ||
      player.guess?.civs ||
      player.guess?.vice !== undefined
    ) {
      const playerPosition = player.position;
      const hasGuesses =
        (player.guess.mafs && player.guess.mafs.length > 0) ||
        (player.guess.civs && player.guess.civs.length > 0) ||
        player.guess.vice !== undefined;

      if (hasGuesses) {
        const shotNight = findShotNight(playerPosition, gameData);
        const votedDay = shotNight === null ? findVotedDay(playerPosition, gameData) : null;

        if (shotNight !== null) {
          addDotToCell(table, playerPosition, "night", shotNight, player.guess, gameData);
        } else if (votedDay !== null) {
          addDotToCell(table, playerPosition, "day", votedDay, player.guess, gameData);
        }
      }
    }
  });

  addBestMoveStyles();
}

function addDotToCell(
  table: HTMLElement,
  playerPosition: number,
  phaseType: "night" | "day",
  phaseNumber: number,
  guessData: any,
  gameData: any,
): void {
  const rows = table.querySelectorAll<HTMLElement>(SITE.statsRow);
  rows.forEach((row) => {
    const phaseCell = row.querySelector(SITE.statsCellTitle);
    const phaseText = phaseCell?.textContent || "";

    const isTargetRow =
      phaseType === "night"
        ? phaseText.includes(`${phaseNumber} 🌙`)
        : phaseText.includes(`${phaseNumber} ☀️`);

    if (isTargetRow) {
      const playerCell = row.querySelector<HTMLElement>(
        `.cell[data-player="${playerPosition}"]`,
      );

      if (playerCell && !playerCell.querySelector(SITE.bestMoveDot)) {
        const dot = document.createElement("div");
        dot.className = "best-move-dot";

        const tooltip = document.createElement("div");
        tooltip.className = "best-move-tooltip";

        const content = document.createElement("div");
        content.className = "tooltip-content";

        if (guessData.mafs && guessData.mafs.length > 0) {
          const mafDiv = document.createElement("div");
          mafDiv.className = "tooltip-row mafs";
          mafDiv.innerHTML = `
            <span class="role-label">Черные</span>
            <span class="numbers">${guessData.mafs
              .map((pos: any) => `<span class="number">${escapeHtml(String(pos))}</span>`)
              .join("")}</span>
          `;
          content.appendChild(mafDiv);
        }

        if (guessData.civs && guessData.civs.length > 0) {
          const civDiv = document.createElement("div");
          civDiv.className = "tooltip-row civs";
          civDiv.innerHTML = `
            <span class="role-label">Мирные</span>
            <span class="numbers">${guessData.civs
              .map((pos: any) => `<span class="number">${escapeHtml(String(pos))}</span>`)
              .join("")}</span>
          `;
          content.appendChild(civDiv);
        }

        if (guessData.vice !== undefined) {
          // Роль угаданного берём из ДАННЫХ матча. Раньше она угадывалась по
          // CSS-классам голосовавших в первой попавшейся ячейке этого игрока —
          // «Руль» красился как мафия, если мафиозо голосовал ПРОТИВ него.
          const vicePlayer = (gameData.data?.players || []).find(
            (p: any) => p.position === guessData.vice,
          );
          let roleClass = "civs";
          if (vicePlayer?.role === 0 || vicePlayer?.role === 1) roleClass = "mafs";
          else if (vicePlayer?.role === 3) roleClass = "sheriff";

          const viceDiv = document.createElement("div");
          viceDiv.className = `tooltip-row ${roleClass}`;
          viceDiv.innerHTML = `
            <span class="role-label">Руль</span>
            <span class="numbers"><span class="number">${escapeHtml(
              String(guessData.vice),
            )}</span></span>
          `;
          content.appendChild(viceDiv);
        }

        tooltip.appendChild(content);
        playerCell.appendChild(dot);
        playerCell.appendChild(tooltip);
      }
    }
  });
}

function findShotNight(playerPosition: number, gameData: any): number | null {
  const shots = gameData.data?.shots || [];
  const mafiaPlayers =
    gameData.data?.players
      .filter((p: any) => p.role === 1 || p.role === 0)
      .map((p: any) => p.position) || [];

  const shotsByNight: Record<number, Set<number>> = {};
  shots.forEach((shot: any) => {
    if (shot.victim === playerPosition) {
      if (!shotsByNight[shot.night]) {
        shotsByNight[shot.night] = new Set();
      }
      shotsByNight[shot.night].add(shot.shooter);
    }
  });

  const nights = Object.keys(shotsByNight)
    .map(Number)
    .sort((a, b) => b - a);

  for (const night of nights) {
    const shooters = shotsByNight[night];
    if (shooters.size === mafiaPlayers.length) {
      return night;
    }
  }

  if (nights.length > 0) {
    return nights[0];
  }

  return null;
}

function findVotedDay(playerPosition: number, gameData: any): number | null {
  const votes = gameData.data?.votes || [];
  let maxDay: number | null = null;
  let maxVotes = 0;

  const dayVotes: Record<number, number> = {};
  votes.forEach((vote: any) => {
    // !num: основной тур — это num=0 (см. processGamePhases); здесь оставалась
    // старая семантика num===1, т.е. день искался по переголосовке.
    if (vote.candidate === playerPosition && !vote.num) {
      dayVotes[vote.day] = (dayVotes[vote.day] || 0) + 1;
    }
  });

  Object.entries(dayVotes).forEach(([day, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      maxDay = parseInt(day, 10);
    }
  });

  return maxDay;
}

function addBestMoveStyles(): void {
  appendStyle(
    `
    .best-move-dot {
      width: 8px;
      height: 8px;
      background-color: #3b82f6;
      border-radius: 50%;
      position: absolute;
      top: 5px;
      right: 5px;
      z-index: 10;
      transition: transform 0.2s ease;
    }
    .best-move-dot:hover { transform: scale(1.2); }
    .best-move-tooltip {
      display: none;
      position: absolute;
      background: linear-gradient(180deg, rgba(30, 31, 34, 0.98) 0%, rgba(22, 23, 26, 0.98) 100%);
      color: white;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-line;
      z-index: 1000;
      pointer-events: none;
      top: -10px;
      right: 25px;
      min-width: 160px;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      transform-origin: right center;
      animation: tooltipAppear 0.2s ease;
    }
    .best-move-tooltip::before {
      content: '';
      position: absolute;
      right: -6px;
      top: 12px;
      width: 10px;
      height: 10px;
      background: inherit;
      transform: rotate(45deg);
      border-right: 1px solid rgba(255, 255, 255, 0.1);
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      z-index: -1;
    }
    .best-move-tooltip::after {
      content: '';
      display: block;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      margin-bottom: 8px;
    }
    .tooltip-content { display: flex; flex-direction: column; gap: 6px; }
    .tooltip-content::before {
      content: 'Лучший ход';
      display: block;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.7);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .tooltip-row { display: flex; justify-content: space-between; align-items: center; }
    .role-label { color: rgba(255, 255, 255, 0.7); font-size: 12px; }
    .numbers { display: flex; gap: 4px; }
    .number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 4px;
      border-radius: 4px;
      font-weight: 500;
      font-size: 12px;
    }
    /* Единая палитра ролей (8.1.30): «Чёрные» больше не синие. */
    .mafs .number { background: rgba(209, 213, 219, 0.14); color: #d1d5db; }
    .civs .number { background: rgba(248, 113, 113, 0.14); color: #f87171; }
    .sheriff .number { background: rgba(250, 204, 21, 0.14); color: #facc15; }
    .vice .number { background: rgba(147, 51, 234, 0.2); color: #9333ea; }
    .best-move-dot:hover + .best-move-tooltip { display: block; }
    .cell { position: relative !important; }
  `,
    "pn-best-move-styles",
  );
}

// ───────────────────────── фазы / иконки ─────────────────────────

/** Пояснение к иконке ночного действия (показывается на hover). */
function actionTip(type: string, to: unknown): string {
  const n = `№${to}`;
  switch (type) {
    case "kill":
      return `Выстрел мафии → ${n}`;
    case "check":
      return `Проверка шерифа → ${n}`;
    case "don_check":
      return `Проверка дона → ${n}`;
    case "vote":
      return `Голос → ${n}`;
    default:
      return `Действие → ${n}`;
  }
}

/**
 * Эмодзи вместо картинок с трёх сторонних CDN: раньше каждая страница матча
 * сливала IP пользователя vexels/icons8/flaticon, а лупа «голоса» была
 * неотличима от лупы шерифа. Заодно закрыт пункт техдолга про хотлинк.
 */
function getActionIcon(type: string): string {
  const icon =
    type === "kill"
      ? "🎯"
      : type === "check"
        ? "🔍"
        : type === "don_check"
          ? "👑"
          : type === "vote"
            ? "🗳️"
            : "•";
  return `<span style="font-size: 13px; vertical-align: middle;">${icon}</span>`;
}

function processGamePhases(gameDetails: any): Array<{ day: any[]; night: any[] }> {
  const votes = gameDetails.votes || [];
  const shots = gameDetails.shots || [];
  const checks = gameDetails.checks || [];

  const donPlayer = gameDetails.players.find((p: any) => p.role === 0)?.position;
  const sheriffPlayer = gameDetails.players.find((p: any) => p.role === 3)?.position;

  const maxDay = Math.max(
    ...votes.map((v: any) => v.day || 0),
    ...shots.map((s: any) => s.night || 0),
    ...checks.map((c: any) => c.night || 0),
  );

  const phases: Array<{ day: any[]; night: any[] }> = Array.from(
    { length: maxDay },
    () => ({ day: [], night: [] }),
  );

  // Туры голосования. В данных сайта (сверено с реальным JSON матча):
  // num=0 — ОСНОВНОЕ голосование, num=1 — переголосовка, num=2 — «поднять всех».
  // Раньше обрабатывались только num===1 и num===2: основной тур вообще не
  // попадал в таблицу, переголосовка рисовалась как основной, а третий тур —
  // как переголосовка. (isLeading убран — его никто не рендерил.)
  votes.forEach((vote: any) => {
    if (!vote.day || vote.day <= 0 || vote.day > maxDay) return;
    phases[vote.day - 1].day.push({
      type: "vote",
      from: vote.voter,
      to: vote.candidate,
      num: vote.num || 0,
    });
  });

  // Выстрелы (убийства мафии).
  shots.forEach((shot: any) => {
    if (shot.night && shot.night > 0) {
      phases[shot.night - 1].night.push({
        type: "kill",
        from: shot.shooter,
        to: shot.victim,
      });
    }
  });

  // Проверки (шериф/дон).
  checks.forEach((check: any) => {
    if (check.night && check.night > 0) {
      phases[check.night - 1].night.push({
        type: check.role === 0 ? "don_check" : "check",
        from: check.role === 0 ? donPlayer : sheriffPlayer,
        to: check.player,
      });
    }
  });

  return phases;
}

// ───────────────────────── штрафы ─────────────────────────

function addPenaltyIndicators(table: HTMLElement, gameData: any): void {
  const players = gameData.data?.players || [];

  players.forEach((player: any) => {
    if (player.penalties?.length > 0) {
      player.penalties.forEach((penalty: any) => {
        const playerPosition = penalty.player;
        const stage = penalty.stage || {};
        // Ночной штраф раньше терялся молча: искалась строка «undefined ☀️».
        const phaseLabel = stage.day
          ? `${stage.day} ☀️`
          : stage.night
            ? `${stage.night} 🌙`
            : null;
        if (!phaseLabel) return;
        const type = penalty.type;

        const initiatorName = gameData.data.players.find(
          (p: any) => p.position === parseInt(penalty.initiator, 10),
        )?.username;

        let tooltipText = "";
        const initiator = `Инициатор: ${penalty.initiator} ${initiatorName}\n`;
        const votes = Object.entries(penalty.votes)
          .map(([voter, vote]) => {
            const voterName = gameData.data.players.find(
              (p: any) => p.position === parseInt(voter, 10),
            )?.username;
            return `${voter} ${voterName}: ${vote ? "✓" : "✗"}`;
          })
          .join("\n");

        switch (type) {
          case "disqual":
            tooltipText = `Дисквалификация · ${phaseLabel}\n${initiator}${votes}`;
            break;
          case "stop":
            tooltipText = `ППК · ${phaseLabel}\n${initiator}${votes}`;
            break;
          case "tech":
            tooltipText = `Тех. фол · ${phaseLabel}\n${initiator}${votes}`;
            break;
        }

        const color =
          type === "tech"
            ? "#FFD700"
            : type === "stop"
              ? "#ef4444"
              : "rgba(239, 68, 68, 0.45)";
        const votePairs = Object.entries(penalty.votes || {})
          .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
          .map(([voter, vote]) => `${voter}:${vote ? 1 : 0}`)
          .join(",");
        const penaltyKey = `${phaseLabel}|${type}|${penalty.initiator}|${playerPosition}|${votePairs}`;
        addPenaltyDot(table, playerPosition, phaseLabel, color, tooltipText, penaltyKey);
      });
    }
  });
}

function addPenaltyDot(
  table: HTMLElement,
  playerPosition: number,
  phaseLabel: string,
  color: string,
  tooltipText: string,
  penaltyKey: string,
): void {
  const rows = table.querySelectorAll<HTMLElement>(SITE.statsRow);

  rows.forEach((row) => {
    const phaseCell = row.querySelector(SITE.statsCellTitle);
    const phaseText = phaseCell?.textContent || "";

    if (phaseText.includes(phaseLabel)) {
      const playerCell = row.querySelector<HTMLElement>(
        `.cell[data-player="${playerPosition}"]`,
      );

      if (playerCell) {
        let dotContainer = playerCell.querySelector<HTMLElement>(SITE.penaltyDots);
        if (!dotContainer) {
          dotContainer = document.createElement("div");
          dotContainer.className = "penalty-dots";
          dotContainer.style.position = "absolute";
          dotContainer.style.top = "5px";
          dotContainer.style.left = "5px";
          dotContainer.style.zIndex = "10";
          dotContainer.style.display = "inline-flex";
          dotContainer.style.gap = "3px";
          if (!originalInlineStyles.has(playerCell)) {
            originalInlineStyles.set(playerCell, playerCell.getAttribute("style"));
          }
          playerCell.style.position = "relative";
          playerCell.appendChild(dotContainer);
        }

        if (
          penaltyKey &&
          dotContainer.querySelector(
            `.penalty-dot[data-penalty-key="${CSS.escape(penaltyKey)}"]`,
          )
        ) {
          return;
        }

        const dot = document.createElement("div");
        dot.className = "penalty-dot";
        if (penaltyKey) dot.setAttribute("data-penalty-key", penaltyKey);
        dot.title = tooltipText;
        dot.style.width = "8px";
        dot.style.height = "8px";
        dot.style.backgroundColor = color;
        dot.style.borderRadius = "50%";
        dot.style.cursor = "pointer";
        dot.style.display = "block";

        dotContainer.appendChild(dot);
      }
    }
  });
}

// ───────────────────────── авто-высота таблицы ─────────────────────────

function applyAutoHeight(): void {
  const gameStatsTable = document.querySelector<HTMLElement>(SITE.statsTableRoot);
  if (!gameStatsTable) return;

  // Ищем data-v-* атрибут и применяем height:auto к нему.
  const attributes = gameStatsTable.attributes;
  let dataVAttribute: string | null = null;
  for (let i = 0; i < attributes.length; i++) {
    if (attributes[i].name.startsWith("data-v-")) {
      dataVAttribute = attributes[i].name;
      break;
    }
  }
  if (dataVAttribute) {
    // Селектор заякорен на контейнер таблицы: голый [data-v-X] снимал height
    // у ВСЕХ элементов компонента по странице — она растягивалась целиком.
    appendStyle(
      `${SITE.statsTableRoot} [${dataVAttribute}], ${SITE.statsTableRoot}[${dataVAttribute}] { height: auto !important; }`,
      "pn-stats-auto-height",
    );
  }

  setStyleProp(gameStatsTable, "height", "auto");

  // Чиним прокручиваемых родителей — но не дальше трёх уровней вверх:
  // обход до корня документа разворачивал скролл-контейнеры всего лейаута.
  let parent = gameStatsTable.parentElement;
  let hops = 0;
  while (parent && parent !== document.body && hops < 3) {
    const computedStyle = window.getComputedStyle(parent);
    if (
      computedStyle.overflow.includes("scroll") ||
      computedStyle.overflowY === "scroll" ||
      parent.classList.contains("__vuescroll") ||
      parent.classList.contains("__panel") ||
      parent.classList.contains("__view")
    ) {
      setStyleProp(parent, "height", "auto");
      setStyleProp(parent, "maxHeight", "none");
    }
    parent = parent.parentElement;
    hops++;
  }

  // Строки итога и MMR.
  const tableRows = gameStatsTable.querySelectorAll<HTMLElement>(SITE.statsRow);
  if (tableRows.length >= 2) {
    const mmrRow = tableRows[tableRows.length - 1];
    const totalRow = tableRows[tableRows.length - 2];

    // Гонка «Итог/MMR ещё не отрендерены сайтом»: последними строками могут
    // оказаться НАШИ скрытые строки фаз — setStyleAttr переписал бы весь
    // style, включая display:none, и выдернул их из тоггла таймлайна.
    if (mmrRow?.hasAttribute("data-phase") || totalRow?.hasAttribute("data-phase")) return;

    if (mmrRow && totalRow) {
      setStyleAttr(mmrRow, "background: #1a1c29 !important; border-bottom: 2px solid #2c3347 !important;");
      setStyleAttr(totalRow, "background: #1a1c29 !important; border-top: 2px solid #2c3347 !important;");

      const mmrTitle = mmrRow.querySelector(SITE.statsCellTitle);
      const totalTitle = totalRow.querySelector(SITE.statsCellTitle);
      if (mmrTitle && totalTitle) {
        setStyleAttr(mmrTitle, "background: #151824 !important; font-weight: 700 !important; color: #d1d5db !important;");
        setStyleAttr(totalTitle, "background: #151824 !important; font-weight: 700 !important; color: #d1d5db !important;");
      }

      totalRow.querySelectorAll<HTMLElement>(".cell:not(.title)").forEach((cell) => {
        const value = parseFloat(cell.textContent?.trim() || "") || 0;
        if (value > 0) {
          setStyleAttr(cell, "color: #10b981 !important; font-weight: 600 !important; font-size: 16px !important;");
        } else if (value < 0) {
          setStyleAttr(cell, "color: #ef4444 !important; font-weight: 600 !important; font-size: 16px !important;");
        } else {
          setStyleAttr(cell, "color: #94a3b8 !important; font-weight: 600 !important; font-size: 16px !important;");
        }
      });

      mmrRow.querySelectorAll<HTMLElement>(".cell:not(.title)").forEach((cell) => {
        const value = parseInt(cell.textContent?.trim() || "", 10) || 0;
        if (value > 0) {
          setStyleAttr(cell, "color: #10b981 !important; font-weight: 700 !important; font-size: 17px !important;");
        } else if (value < 0) {
          setStyleAttr(cell, "color: #ef4444 !important; font-weight: 700 !important; font-size: 17px !important;");
        } else {
          setStyleAttr(cell, "color: #94a3b8 !important; font-weight: 700 !important; font-size: 17px !important;");
        }
      });
    }
  }
}

// ───────────────────────── базовые стили таблицы ─────────────────────────

function injectBaseStyles(): void {
  appendStyle(`
    .game-stats-header[data-v-33ae8458] {
      background: rgba(45, 48, 57, .03) !important;
    }
    .table .row .cell.username[data-v-1db9d42a],
    .table .row .cell.title[data-v-1db9d42a],
    .table .row .cell.position[data-v-1db9d42a] {
      background: rgba(45, 48, 57, .03) !important;
    }
    .table .row .cell.sum[data-v-1db9d42a],
    .table .row .cell.mmr_diff[data-v-1db9d42a] {
      background: rgba(45, 48, 57, .09) !important;
    }
    .cell.mmr_diff[data-v-1db9d42a] { font-weight: 500; }
    .cell.mmr_diff[data-v-1db9d42a] span { padding: 4px 8px; border-radius: 4px; }
    .cell.mmr_diff[data-v-1db9d42a] span[style*="color: rgb(239, 68, 68)"] { background: rgba(239, 68, 68, 0.1); }
    .cell.mmr_diff[data-v-1db9d42a] span[style*="color: rgb(34, 197, 94)"] { background: rgba(34, 197, 94, 0.1); }
    .cell.mmr_diff[data-v-1db9d42a] span[style*="color: rgb(255, 255, 255)"] { background: rgba(255, 255, 255, 0.1); }
    .cell.sum[data-v-1db9d42a] { font-weight: 500; }
    .cell.sum[data-v-1db9d42a] span { padding: 4px 8px; border-radius: 4px; }
    .cell.sum[data-v-1db9d42a] span:not([style]) { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
    .cell.sum[data-v-1db9d42a] span[style*="color: rgb(239, 68, 68)"] { background: rgba(239, 68, 68, 0.1); }
    .cell.sum[data-v-1db9d42a] span[style*="color: rgb(34, 197, 94)"] { background: rgba(34, 197, 94, 0.1); }
    .table .row .cell.mmr_diff[data-v-1db9d42a] > span,
    .table .row .cell.sum[data-v-1db9d42a] > span {
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      border: 1px solid;
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] > span[style*="color: rgb(239, 68, 68)"],
    .table .row .cell.sum[data-v-1db9d42a] > span[style*="color: rgb(239, 68, 68)"] {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] > span[style*="color: rgb(34, 197, 94)"],
    .table .row .cell.sum[data-v-1db9d42a] > span[style*="color: rgb(34, 197, 94)"] {
      background: rgba(34, 197, 94, 0.15);
      border-color: rgba(34, 197, 94, 0.3);
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] > span[style*="color: rgb(255, 255, 255)"],
    .table .row .cell.sum[data-v-1db9d42a] > span[style*="color: rgb(255, 255, 255)"],
    .table .row .cell.mmr_diff[data-v-1db9d42a] > span:not([style]),
    .table .row .cell.sum[data-v-1db9d42a] > span:not([style]) {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] span,
    .table .row .cell.sum[data-v-1db9d42a] span {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      min-width: 45px !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      font-weight: 500 !important;
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] span[style*="color: #ef4444"],
    .table .row .cell.sum[data-v-1db9d42a] span[style*="color: #ef4444"] {
      background: rgba(239, 68, 68, 0.15) !important;
      border: 1px solid rgba(239, 68, 68, 0.3) !important;
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] span[style*="color: #22c55e"],
    .table .row .cell.sum[data-v-1db9d42a] span[style*="color: #22c55e"] {
      background: rgba(34, 197, 94, 0.15) !important;
      border: 1px solid rgba(34, 197, 94, 0.3) !important;
    }
    .table .row .cell.mmr_diff[data-v-1db9d42a] span[style*="color: #ffffff"],
    .table .row .cell.sum[data-v-1db9d42a] span[style*="color: #ffffff"] {
      background: rgba(255, 255, 255, 0.1) !important;
      border: 1px solid rgba(255, 255, 255, 0.2) !important;
    }
    [style*="overflow: scroll hidden"] { overflow: hidden !important; }
    .game-stats-table[data-v-33ae8458], .game-stats-table [data-v-33ae8458], .game-stats-header[data-v-33ae8458] { height: auto !important; }
    .__vuescroll { height: auto !important; }
    .__panel, .__view { height: auto !important; }
    .game-stats-table {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-collapse: collapse;
      color: var(--primary-white);
      font-family: var(--font-family);
    }
    .table .row:nth-last-child(1),
    .table .row:nth-last-child(2) {
      background: rgba(22, 23, 35, 0.98) !important;
      border-top: 1px solid rgba(255, 255, 255, 0.15) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.15) !important;
    }
    .table .row:nth-last-child(2) .cell:not(.title) {
      font-weight: 600 !important;
      font-size: 15px !important;
      color: #ffffff !important;
      text-shadow: 0 0 5px rgba(255, 255, 255, 0.2);
    }
    .table .row:nth-last-child(1) .cell:not(.title) {
      font-weight: 700 !important;
      font-size: 16px !important;
    }
    .table .row:nth-last-child(1) .cell:not(.title):has(span[style*="color: rgb(34, 197, 94)"]),
    .table .row:nth-last-child(1) .cell:not(.title) span[style*="+"] {
      color: #22c55e !important;
      text-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
    }
    .table .row:nth-last-child(1) .cell:not(.title):has(span[style*="color: rgb(239, 68, 68)"]),
    .table .row:nth-last-child(1) .cell:not(.title) span[style*="-"] {
      color: #ef4444 !important;
      text-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
    }
    .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(34, 197, 94)"]) {
      border-bottom: 3px solid rgba(34, 197, 94, 0.7) !important;
    }
    .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(239, 68, 68)"]) {
      border-bottom: 3px solid rgba(239, 68, 68, 0.7) !important;
    }
    .table .row:nth-last-child(2) .cell:not(.title) { position: relative; }
    .table .row:nth-last-child(2) .cell:not(.title)::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 10%;
      width: 80%;
      height: 3px;
      background: linear-gradient(90deg,
        rgba(255, 255, 255, 0.05) 0%,
        rgba(255, 255, 255, 0.2) 50%,
        rgba(255, 255, 255, 0.05) 100%);
      border-radius: 2px;
    }
    .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(34, 197, 94)"])::after {
      background: linear-gradient(90deg,
        rgba(34, 197, 94, 0.3) 0%,
        rgba(34, 197, 94, 0.8) 50%,
        rgba(34, 197, 94, 0.3) 100%);
    }
    .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(239, 68, 68)"])::after {
      background: linear-gradient(90deg,
        rgba(239, 68, 68, 0.3) 0%,
        rgba(239, 68, 68, 0.8) 50%,
        rgba(239, 68, 68, 0.3) 100%);
    }
    div.cell.player::after,
    div.cell.player.sum.winner.has-calcs::after {
      display: none !important;
      content: none !important;
    }
    .table .row:nth-last-child(1) .cell.title,
    .table .row:nth-last-child(2) .cell.title {
      background: rgba(10, 10, 20, 0.8) !important;
      font-weight: 700 !important;
      color: #cbd5e1 !important;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .table .row[data-v-1db9d42a] {
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(20, 20, 35, 0.95);
    }
    .cell {
      padding: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      min-height: 60px;
      background: transparent;
      border-right: 1px solid rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }
    .cell:last-child { border-right: none; }
    .cell.title {
      background: rgba(0, 0, 0, 0.3);
      font-weight: 500;
      color: #94a3b8;
      width: 67px !important;
      min-width: 67px !important;
      flex: 0 0 67px !important;
    }
    .cell.player {
      text-align: center;
      width: 115px !important;
      min-width: 115px !important;
      flex: 0 0 115px !important;
    }
    .vote {
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      transition: all 0.2s;
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .vote.leading { color: #ff3b30; border-color: rgba(255, 59, 48, 0.3); }
    .action {
      font-size: 12px;
      margin: 2px 0;
      background: rgba(30, 30, 40, 0.5) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 8px !important;
      padding: 2px 6px !important;
      display: inline-flex !important;
      /* wrap + max-width: «подъём» с 7-8 голосами шире колонки — без переноса
         блок вылезал за границы ячейки (влево, под колонку №). */
      flex-wrap: wrap !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
      justify-content: center !important;
      align-items: center !important;
      gap: 2px !important;
      min-height: auto !important;
      height: auto !important;
      margin: 2px !important;
    }
    .action:hover { background: rgba(40, 40, 50, 0.7) !important; }
    .action.kill { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .action.check { background: rgba(250, 204, 21, 0.14); color: #facc15; }
    .action.don_check { background: rgba(192, 132, 252, 0.16); color: #c084fc; }
    .action.vote { background: rgba(30, 30, 40, 0.5) !important; color: #ffffff; }
    .action.vote.leading .voter { background: rgba(59, 130, 246, 0.2); }
    .action.kill img {
      width: 16px;
      height: 16px;
      vertical-align: middle;
      margin-right: 2px;
      filter: brightness(1.2);
    }
    /* Единая палитра (8.1.30): эти !important-правила перебивают инлайн из
       voterStyleFor — значения обязаны совпадать с ROLE_COLORS, иначе чипы
       таймлайна и детальных строк красятся по-разному. */
    .voter { color: #f87171 !important; }
    .voter.don-vote { color: #c084fc !important; }
    .voter.mafia-vote { color: #d1d5db !important; }
    .voter.sheriff-vote { color: #facc15 !important; }
    .action span.voter {
      display: inline-block;
      margin: 0;
      padding: 0;
      background: transparent;
      font-size: 14px;
      font-weight: 500;
    }
    .cell.player.role {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    .cell.player img { width: 26px; height: 26px; }
  `,
    "pn-stats-base-styles",
  );

  // Пояснения к иконкам действий на hover (выстрел/проверки/голосования).
  appendStyle(
    `
    .cell .action[data-tip] { cursor: help; position: relative; }
    .cell .action[data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 7px);
      left: 50%;
      transform: translateX(-50%);
      max-width: 200px;
      width: max-content;
      white-space: normal;
      text-align: center;
      background: #1e1f26;
      color: #fff;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.3;
      z-index: 1000;
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      pointer-events: none;
    }
    .cell .action[data-tip]:hover::before {
      content: '';
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: #1e1f26;
      z-index: 1000;
      pointer-events: none;
    }
  `,
    "pn-stats-action-tips",
  );
}

// ───────────────────────── жизненный цикл фичи ─────────────────────────

function stopMatchRoute(preserveSnapshot = true): void {
  const leavingMatchId = activeMatchId;
  const leavingTable = activeMatchId
    ? document.querySelector<HTMLElement>(SITE.statsTable)
    : null;
  if (gameDataListener) {
    document.removeEventListener("gameDataParsed", gameDataListener);
    gameDataListener = null;
  }
  if (routeDomUnsub) {
    routeDomUnsub();
    routeDomUnsub = null;
  }
  for (const id of intervals) clearInterval(id);
  intervals.clear();
  for (const id of timeouts) clearTimeout(id);
  timeouts.clear();
  for (const style of injectedStyles) style.remove();
  injectedStyles.length = 0;
  removeEnhancements();
  restoreHeader();
  restoreInlineStyles();
  pendingGameData = null;
  lastPendingRetryAt = 0;
  if (leavingMatchId && preserveSnapshot) {
    clearPreviousRouteSnapshot();
    previousRouteMatchId = leavingMatchId;
    previousRouteTable = leavingTable ? new WeakRef(leavingTable) : null;
    previousRouteTableHtml = leavingTable?.innerHTML || "";
  } else if (!preserveSnapshot) {
    clearPreviousRouteSnapshot();
  }
  routeReadyInterval = null;
  activeMatchId = null;
}

function startMatchRoute(matchId: string): void {
  if (activeMatchId === matchId) return;
  if (activeMatchId) stopMatchRoute();
  if (previousRouteMatchId === matchId) {
    clearPreviousRouteSnapshot();
  }
  activeMatchId = matchId;
  log.debug(SCOPE, "Match page detected, initializing enhancer", matchId);

  injectBaseStyles();

  routeDomUnsub = onDomChange(() => {
    if (routeReadyInterval !== null || !pendingGameData || activeMatchId !== matchId) return;
    // URL уже мог смениться, а роутер (поллинг 500мс) ещё не среконсилил роут:
    // без этого гейта enhance() выходил по несовпадению id, НЕ очищая pending,
    // и каждый DOM-флеш окна навешивал новый setInterval(applyAutoHeight).
    if ((location.pathname.split("/").pop() || "") !== matchId) return;
    const now = Date.now();
    if (now - lastPendingRetryAt < 500) return;
    lastPendingRetryAt = now;
    if (!isRouteDomReady()) return;
    clearPreviousRouteSnapshot();
    applyAutoHeight();
    trackInterval(setInterval(applyAutoHeight, 5000));
    enhance(pendingGameData);
  });

  const readyStarted = Date.now();
  routeReadyInterval = trackInterval(
    setInterval(() => {
      if (activeMatchId !== matchId) return;
      if (!isRouteDomReady()) {
        if (Date.now() - readyStarted < 10_000) return;
        clearTrackedInterval(routeReadyInterval!);
        routeReadyInterval = null;
        return;
      }
      clearTrackedInterval(routeReadyInterval!);
      routeReadyInterval = null;
      clearPreviousRouteSnapshot();
      applyAutoHeight();
      trackInterval(setInterval(applyAutoHeight, 5000));
      if (pendingGameData) enhance(pendingGameData);
    }, 100),
  );

  gameDataListener = (event: Event) => {
    if (!statsEnabled() || activeMatchId !== matchId) return;
    log.debug(SCOPE, "Received game data, enhancing page");
    enhance((event as CustomEvent).detail);
  };
  document.addEventListener("gameDataParsed", gameDataListener);

  const cached = getLastGameData();
  if (cached && statsEnabled()) enhance(cached);
}

/** Вызывается единым URL-роутером content/index.ts. */
export function syncMatchStatsRoute(matchId: string | null): void {
  if (!settings || !matchId) {
    if (activeMatchId) stopMatchRoute(false);
    return;
  }
  startMatchRoute(matchId);
}

export const matchStatsFeature: Feature = {
  id: "match-stats",
  settingKey: "match_page_stats_enabled",

  enable(ctx: FeatureContext): void {
    settings = ctx.settings;
    syncMatchStatsRoute(getMatchId());
  },

  update(ctx: FeatureContext): void {
    settings = ctx.settings;
    // Если статистика выключена настройкой — снимаем добавленные элементы
    // и возвращаем заголовок сайта (раньше он оставался нашим).
    if (!statsEnabled()) {
      removeEnhancements();
      restoreHeader();
    }
  },

  disable(): void {
    stopMatchRoute(false);
    settings = null;
  },
};
