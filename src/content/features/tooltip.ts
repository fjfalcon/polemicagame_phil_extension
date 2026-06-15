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
import { SITE } from "@core/selectors";
import { escapeHtml } from "@core/escape";
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

  .vote-yes { color: #4CAF50; font-weight: bold; }
  .vote-no { color: #FF4B55; font-weight: bold; }

  .player-info {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 100px;
  }

  .player-number {
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    min-width: 16px;
  }

  .player-name {
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    cursor: pointer;
    transition: color 0.2s ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .player-name:hover {
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
const activeTooltips = new Set<HTMLDivElement>();

function getPlayers(): MatchPlayer[] | null {
  return matchData?.players ?? matchData?.data?.players ?? null;
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
  switch (player.role) {
    case 3:
      return "#fbbf24"; // Шериф — жёлтый
    case 2:
      return "#ffffff"; // Мирный — белый
    case 1:
      return "#0ea5e9"; // Мафия — синий
    case 0:
      return "#ff3b30"; // Дон — красный
    default:
      return "#ffffff";
  }
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
    const match = content.match(/Лучший ход: (.+)/);
    if (!match) return tooltip;

    const numbers = match[1].split(/,\s*/).map((n) => n.trim());

    tooltip.innerHTML = `
      <div class="enhanced-tooltip-title">Лучший ход</div>
      <div class="enhanced-tooltip-content">
        ${numbers
          .map((num, idx) => {
            const color = getRoleColor(num);
            return `<span style="color: ${escapeHtml(color)}">${escapeHtml(num)}</span>${idx < numbers.length - 1 ? ", " : ""}`;
          })
          .join("")}
      </div>
    `;
  } else {
    const lines = content.split("\n");
    log.debug("tooltip", "Tooltip content:", lines);

    const title = lines[0];
    const initiatorMatch = lines[1]?.match(/Инициатор: (\d+)/);
    const initiatorNumber = initiatorMatch ? initiatorMatch[1] : "";
    const initiatorName = getPlayerName(initiatorNumber);

    tooltip.innerHTML = `
      <div class="enhanced-tooltip-title">${escapeHtml(title)}</div>
      <div class="enhanced-tooltip-initiator">
        Инициатор: ${escapeHtml(initiatorNumber)} ${escapeHtml(truncateName(initiatorName))}
      </div>
      <div class="enhanced-tooltip-votes">
        ${lines
          .slice(2)
          .map((vote) => {
            const [playerPart, result] = vote.split(": ");
            const numMatch = playerPart.match(/\d+/);
            const playerNumber = numMatch ? numMatch[0] : "";
            const playerName = getPlayerName(playerNumber);
            const isYes = (result ?? "").includes("✓");

            return `
              <div class="enhanced-tooltip-vote">
                <div class="player-info">
                  <span class="player-number">${escapeHtml(playerNumber)}</span>
                  <span class="player-name" title="${escapeHtml(playerName)}" data-full-name="${escapeHtml(playerName)}">
                    ${escapeHtml(truncateName(playerName))}
                  </span>
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

  const removeTooltip = () => {
    if (state.tooltip) {
      activeTooltips.delete(state.tooltip);
      state.tooltip.remove();
      state.tooltip = null;
    }
  };

  const onMouseEnter = () => {
    const tooltip = createTooltip(
      originalTitle,
      element.classList.contains("best-move-dot"),
    );
    document.body.appendChild(tooltip);
    activeTooltips.add(tooltip);

    const rect = element.getBoundingClientRect();
    tooltip.style.position = "fixed";
    tooltip.style.left = `${rect.left - 180}px`;
    tooltip.style.top = `${rect.top - tooltip.offsetHeight / 2 + rect.height / 2}px`;

    state.tooltip = tooltip;

    tooltip.addEventListener("mouseenter", () => {
      clearTimeout(tooltipTimeout);
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

const DOT_SELECTOR = `${SITE.penaltyDot}, ${SITE.bestMoveDot}`;

function scanRoot(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(DOT_SELECTOR).forEach((dot) => enhanceTooltip(dot));
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

    // Обработать уже присутствующие точки
    scanRoot(document);

    // Реагировать на новые точки через общий наблюдатель
    unsubscribeDom = onDomChange((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            scanRoot(node as Element);
          }
        });
      }
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
    for (const tooltip of activeTooltips) {
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
