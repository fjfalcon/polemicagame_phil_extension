/**
 * Фича: заменяет стандартные title-атрибуты на кастомные тултипы для
 * штрафных точек (.penalty-dot) и лучших ходов (.best-move-dot).
 * Данные игроков берутся из события `gameDataParsed` (см. match-data.ts).
 * Порт tooltip-enhancer.js.
 *
 * settingKey: null — фича работает всегда на странице матча, зависит только
 * от наличия данных матча (gameDataParsed).
 */
import { log } from "@core/log";
import { onDomChange } from "@core/dom";
import { SITE, SITE_CLASS } from "@core/selectors";
import { escapeHtml } from "@core/escape";
import { getLastGameData } from "../match-data";
import { ROLE_COLORS } from "./match-stats";
import type { Feature } from "@core/feature";

interface MatchPlayer {
  position: number;
  username: string;
  role?: number;
}

interface MatchData {
  players?: MatchPlayer[];
  data?: { players?: MatchPlayer[] };
}

const STYLE_ID = "polemica-tooltip-styles";

const STYLES = `
  .enhanced-tooltip {
    background: linear-gradient(180deg, rgba(45, 48, 57, 0.99), rgba(35, 38, 47, 0.99));
    border-radius: 8px;
    padding: 12px;
    min-width: 180px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    font-family: 'Inter', -apple-system, sans-serif;
    position: fixed;
    z-index: 99999;
    color: #fff;
    pointer-events: all;
  }

  .enhanced-tooltip-title {
    color: #FF4B55;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .enhanced-tooltip-content {
    color: #FFD700;
    font-size: 13px;
    padding: 4px 8px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
  }

  .enhanced-tooltip-initiator {
    color: #FFD700;
    font-size: 13px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .enhanced-tooltip-votes {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }

  .enhanced-tooltip-vote {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    transition: background 0.2s ease;
    gap: 8px;
  }

  .enhanced-tooltip-vote:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .enhanced-tooltip .vote-yes { color: #4CAF50; font-weight: bold; }
  .enhanced-tooltip .vote-no { color: #FF4B55; font-weight: bold; }

  .enhanced-tooltip .player-info {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 100px;
  }

  /*
   * Все правила ниже заскоуплены в .enhanced-tooltip намеренно: имена вроде
   * player-number / player-name / player-info совпадают с классами САЙТА.
   * Неотскоупленный .player-number красил номера игроков на плитке, в
   * роллере и в блоке состояний (цвет им сайт не задаёт, побеждали наши
   * 50% белого). Со свёрнутой плашкой номер остаётся один — выцветшая
   * цифра сразу бросается в глаза (ревью 08.08.2026).
   */
  .enhanced-tooltip .player-number {
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    min-width: 16px;
  }

  .enhanced-tooltip .player-name {
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    cursor: pointer;
    transition: color 0.2s ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .enhanced-tooltip .player-name:hover {
    color: #4CAF50;
  }

  .copy-notification {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 14px;
    animation: notificationAppear 0.3s ease;
    z-index: 100000;
  }

  @keyframes notificationAppear {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

// Точка, к которой мы прикрепили активный тултип (заменяет element.tooltip из старого кода).
interface DotState {
  tooltip: HTMLDivElement | null;
  cleanup: () => void;
}

let matchData: MatchData | null = null;
let unsubscribeDom: (() => void) | null = null;
let onGameData: ((e: Event) => void) | null = null;
let styleEl: HTMLStyleElement | null = null;

// Состояние по каждой обработанной точке, чтобы корректно снять всё в disable().
const dotStates = new WeakMap<Element, DotState>();
const processed = new WeakSet<Element>();
/** Активные body-тултипы → их владелец-точка (нужен для чистки при удалении владельца). */
const activeTooltips = new Map<HTMLDivElement, Element>();
let tooltipOwnerId = 0;

function getPlayers(): MatchPlayer[] | null {
  // data.players ПЕРВЫМ: у него есть position+username. Верхнеуровневый
  // players сайта несёт tablePosition (без position) — поиск по нему всегда
  // промахивался, и тултипы показывали «3 3» вместо «3 · Ник».
  return matchData?.data?.players ?? matchData?.players ?? null;
}

function getPlayerName(number: string): string {
  const players = getPlayers();
  if (!players) return `${number}`;
  const name = players.find((p) => p.position === parseInt(number, 10))?.username;
  return name || `${number}`;
}

function truncateName(name: string): string {
  return name && name.length > 6 ? name.substring(0, 6) + "..." : name;
}

function getRoleColor(number: string): string {
  const players = getPlayers();
  if (!players) {
    log.debug("tooltip", "No match data available");
    return "white";
  }
  const player = players.find((p) => p.position === parseInt(number, 10));
  if (!player) {
    log.debug("tooltip", `Player ${number} not found`);
    return "white";
  }
  log.debug("tooltip", `Player ${number} role:`, player.role);
  // Единая палитра ролей (8.1.30) — импорт канона, а не копия литералов:
  // дубликаты значений уже расходились четыре раза за историю проекта.
  return ROLE_COLORS[player.role ?? -1] ?? "#ffffff";
}

function showNotification(message: string): void {
  const notification = document.createElement("div");
  notification.className = "copy-notification";
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 2000);
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).then(() => {
    showNotification("Никнейм скопирован!");
  });
}

function createTooltip(content: string, isBestMove: boolean): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.className = "enhanced-tooltip";

  if (isBestMove) {
    // Многострочный формат из match-stats (8.1.30): «Лучший ход» +
    // строки «Черные: 1 6» / «Мирные: 3» / «Руль: 7». Номера красятся по
    // РЕАЛЬНОЙ роли игрока из данных матча (единая палитра).
    const lines = content.split("\n").filter(Boolean);
    const rows = lines
      .slice(1)
      .map((line) => {
        const m = line.match(/^([^:]+):\s*(.+)$/);
        if (!m) return "";
        const label = m[1];
        const nums = m[2].split(/[\s,]+/).filter(Boolean);
        const numHtml = nums
          .map(
            (num) =>
              `<span style="color: ${escapeHtml(getRoleColor(num))}; background: rgba(255,255,255,.06); border-radius: 5px; padding: 1px 7px; margin-left: 4px;">${escapeHtml(num)}</span>`,
          )
          .join("");
        return `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:3px 0;">
          <span style="color: rgba(255,255,255,.75); font-size: 13px;">${escapeHtml(label)}</span>
          <span>${numHtml}</span>
        </div>`;
      })
      .join("");
    tooltip.innerHTML = `
      <div class="enhanced-tooltip-title">${escapeHtml(lines[0] || "Лучший ход")}</div>
      ${rows || '<div class="enhanced-tooltip-content">—</div>'}
    `;
  } else {
    const lines = content.split("\n");
    log.debug("tooltip", "Tooltip content:", lines);

    const title = lines[0];
    const initiatorMatch = lines[1]?.match(/Инициатор: (\d+)/);
    const initiatorNumber = initiatorMatch ? initiatorMatch[1] : "";
    const initiatorName = getPlayerName(initiatorNumber);
    // Страховка от «3 3»: если ник не резолвился, getPlayerName вернул номер —
    // показываем номер один раз, а не дважды.
    const initiatorLabel =
      initiatorName === initiatorNumber
        ? `№${initiatorNumber}`
        : `${initiatorNumber} · ${truncateName(initiatorName)}`;

    tooltip.innerHTML = `
      <div class="enhanced-tooltip-title">${escapeHtml(title)}</div>
      <div class="enhanced-tooltip-initiator">
        Инициатор: ${escapeHtml(initiatorLabel)}
      </div>
      <div class="enhanced-tooltip-votes">
        ${lines
          .slice(2)
          .map((vote) => {
            const [playerPart, result] = vote.split(": ");
            const numMatch = playerPart.match(/\d+/);
            const playerNumber = numMatch ? numMatch[0] : "";
            const playerName = getPlayerName(playerNumber);
            const nameResolved = playerName !== playerNumber;
            const isYes = (result ?? "").includes("✓");

            return `
              <div class="enhanced-tooltip-vote">
                <div class="player-info">
                  <span class="player-number">${escapeHtml(playerNumber)}</span>
                  ${
                    nameResolved
                      ? `<span class="player-name" title="${escapeHtml(playerName)}" data-full-name="${escapeHtml(playerName)}">
                    ${escapeHtml(truncateName(playerName))}
                  </span>`
                      : ""
                  }
                </div>
                <span class="vote-icon ${isYes ? "vote-yes" : "vote-no"}">${isYes ? "✓" : "✗"}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    tooltip.querySelectorAll<HTMLElement>(".player-name").forEach((nameEl) => {
      nameEl.addEventListener("click", () => {
        const full = nameEl.dataset.fullName;
        if (full) copyToClipboard(full);
      });
    });
  }

  return tooltip;
}

function enhanceTooltip(element: HTMLElement): void {
  if (processed.has(element)) return;

  const originalTitle = element.getAttribute("title");
  if (!originalTitle) return;

  processed.add(element);
  element.removeAttribute("title");

  const state: DotState = { tooltip: null, cleanup: () => {} };
  dotStates.set(element, state);

  let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;
  const owner = `penalty-${++tooltipOwnerId}`;

  const removeTooltip = () => {
    if (state.tooltip) {
      activeTooltips.delete(state.tooltip);
      state.tooltip.remove();
      state.tooltip = null;
    }
  };

  const onMouseEnter = () => {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = undefined;
    removeTooltip();
    document
      .querySelectorAll<HTMLDivElement>(`${SITE.penaltyTooltip}[data-tooltip-owner="${owner}"]`)
      .forEach((orphan) => {
        activeTooltips.delete(orphan);
        orphan.remove();
      });
    const tooltip = createTooltip(
      originalTitle,
      element.classList.contains(SITE_CLASS.bestMoveDot),
    );
    tooltip.classList.add(SITE_CLASS.penaltyTooltip);
    tooltip.dataset.tooltipOwner = owner;
    document.body.appendChild(tooltip);
    activeTooltips.set(tooltip, element);

    const rect = element.getBoundingClientRect();
    tooltip.style.position = "fixed";
    tooltip.style.left = `${rect.left - 180}px`;
    tooltip.style.top = `${rect.top - tooltip.offsetHeight / 2 + rect.height / 2}px`;

    state.tooltip = tooltip;

    tooltip.addEventListener("mouseenter", () => {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = undefined;
    });

    tooltip.addEventListener("mouseleave", () => {
      tooltipTimeout = setTimeout(removeTooltip, 100);
    });
  };

  const onMouseLeave = () => {
    tooltipTimeout = setTimeout(() => {
      if (state.tooltip && !state.tooltip.matches(":hover")) {
        removeTooltip();
      }
    }, 100);
  };

  element.addEventListener("mouseenter", onMouseEnter);
  element.addEventListener("mouseleave", onMouseLeave);

  state.cleanup = () => {
    clearTimeout(tooltipTimeout);
    element.removeEventListener("mouseenter", onMouseEnter);
    element.removeEventListener("mouseleave", onMouseLeave);
    removeTooltip();
    processed.delete(element);
    dotStates.delete(element);
  };
}

const DOT_SELECTOR = `${SITE.penaltyDot}, ${SITE.bestMoveDot}, .pn-shot-icon`;

function scanRoot(root: ParentNode): void {
  // querySelectorAll ищет только ПОТОМКОВ. Точка ЛХ добавляется голым
  // appendChild в существующую ячейку — в мутации addedNodes лежит сама
  // точка, и без проверки корня она навсегда оставалась с нативным
  // title-тултипом (штрафные точки везло: они приходят контейнером).
  if (root instanceof Element) {
    if (root.matches(DOT_SELECTOR)) enhanceTooltip(root as HTMLElement);
    // QSA-обход — только когда в поддереве точно есть целевые узлы: дешёвая
    // проверка querySelector на корне отсекает подавляющее большинство
    // добавленных поддеревьев без аллокации NodeList (PERF-11).
    if (!root.firstElementChild || !root.querySelector(DOT_SELECTOR)) return;
  }
  root.querySelectorAll<HTMLElement>(DOT_SELECTOR).forEach((dot) => enhanceTooltip(dot));
}

/**
 * Владельца тултипа удалили из DOM (сайт перерисовал ячейку/таблицу) — «его»
 * тултип раньше висел в document.body до самого disable() (PERF-11: «Removed
 * owner не очищает body tooltip»). Активных тултипов практически всегда 0–1,
 * поэтому проверка связности владельцев дешевле любого обхода удалённых
 * поддеревьев селекторами.
 */
function pruneDetachedOwners(): void {
  if (activeTooltips.size === 0) return;
  for (const [tooltip, owner] of activeTooltips) {
    if (owner.isConnected) continue;
    activeTooltips.delete(tooltip);
    tooltip.remove();
    const state = dotStates.get(owner);
    if (state && state.tooltip === tooltip) state.tooltip = null;
  }
}

export const tooltipFeature: Feature = {
  id: "tooltip",
  settingKey: null,
  enable() {
    // Стили
    if (!document.getElementById(STYLE_ID)) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = STYLES;
      document.head.appendChild(styleEl);
    }

    // Данные матча
    onGameData = (event: Event) => {
      const detail = (event as CustomEvent<MatchData>).detail;
      log.debug("tooltip", "Game data received:", detail);
      matchData = detail;
    };
    document.addEventListener("gameDataParsed", onGameData);
    // Догон: событие могло уйти до подписки — забираем из кэша match-data.
    const cached = getLastGameData();
    if (cached) matchData = cached as MatchData;

    // Обработать уже присутствующие точки
    scanRoot(document);

    // Реагировать на новые точки через общий наблюдатель.
    //
    // Бюджет «Tooltip» (PERF-11): attribute-only записи точек не создают и не
    // удаляют — фильтр по типу стоит ПЕРВЫМ, до любого чтения addedNodes;
    // QSA достаются только поддеревьям, где корень подтвердил наличие целевых
    // узлов (см. scanRoot). Удаления обрабатываются один раз на батч —
    // связностью владельцев, без обхода удалённых поддеревьев.
    unsubscribeDom = onDomChange((mutations) => {
      let sawRemovals = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        if (mutation.removedNodes.length > 0) sawRemovals = true;
        const added = mutation.addedNodes;
        for (let i = 0; i < added.length; i++) {
          const node = added[i];
          if (node.nodeType === Node.ELEMENT_NODE) scanRoot(node as Element);
        }
      }
      if (sawRemovals) pruneDetachedOwners();
    });
  },
  disable() {
    // gameDataParsed listener
    if (onGameData) {
      document.removeEventListener("gameDataParsed", onGameData);
      onGameData = null;
    }

    // отписка от onDomChange
    if (unsubscribeDom) {
      unsubscribeDom();
      unsubscribeDom = null;
    }

    // снять обработчики/состояние со всех обработанных точек
    for (const dot of document.querySelectorAll(DOT_SELECTOR)) {
      dotStates.get(dot)?.cleanup();
    }

    // удалить любые оставшиеся tooltip-элементы
    for (const tooltip of activeTooltips.keys()) {
      tooltip.remove();
    }
    activeTooltips.clear();

    // убрать стили
    if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }

    matchData = null;
  },
};
