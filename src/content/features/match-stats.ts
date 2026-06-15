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
import { escapeHtml } from "@core/escape";
import { log } from "@core/log";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const SCOPE = "match-stats";

// ───────────────────────── состояние для очистки ─────────────────────────

let settings: Settings | null = null;
let gameDataListener: ((event: Event) => void) | null = null;
const intervals = new Set<ReturnType<typeof setInterval>>();
const timeouts = new Set<ReturnType<typeof setTimeout>>();
const injectedStyles: HTMLStyleElement[] = [];
let loadListener: (() => void) | null = null;

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
  const style = document.createElement("style");
  if (id) style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  injectedStyles.push(style);
  return style;
}

function statsEnabled(): boolean {
  return !(
    settings?.statistics_enabled === false || settings?.match_page_stats_enabled === false
  );
}

// ───────────────────────── построение таблицы ─────────────────────────

function enhance(gameData: any): void {
  const header = document.querySelector<HTMLElement>(SITE.statsHeader);
  if (header) {
    const gameId = gameData.id || "";
    const isMafiaWin = gameData.winnerCode !== 0;

    const winnerColor = isMafiaWin ? "#ef4444" : "#22c55e";
    const winnerText = isMafiaWin ? "Победа мафии" : "Победа мирных";

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
    .querySelectorAll(".row[data-phase], .best-move-dot, .best-move-tooltip")
    .forEach((element) => element.remove());
}

function voterStyleFor(role: number): string {
  if (role === 0) return "color: #9333ea;"; // дон
  if (role === 1) return "color: white;"; // мафия
  if (role === 3) return "color: #eab308;"; // шериф
  return "color: #ef4444;"; // обычный игрок
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
  return `<div class="action"${extraStyle ? ` style="${extraStyle}"` : ""}${tipAttr}>${spans}</div>`;
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
      const firstVotes = votes.filter((v: any) => !v.num || v.num === 1);
      const secondVotes = votes.filter((v: any) => v.num === 2);

      let html = "";
      if (firstVotes.length > 0) {
        html += renderVotesBlock(
          firstVotes,
          players,
          "",
          `Голосование за выставление №${player.position}`,
        );
      }
      if (secondVotes.length > 0) {
        html += renderVotesBlock(
          secondVotes,
          players,
          "margin-top: 4px;",
          `Переголосование за №${player.position}`,
        );
      }

      cell.style.cssText = `
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 4px;
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

  trackTimeout(() => {
    addBestMoveIndicators(table, gameData);
    log.debug(SCOPE, "Best move indicators added");
  }, 100);
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
          addDotToCell(table, playerPosition, "night", shotNight, player.guess);
        } else if (votedDay !== null) {
          addDotToCell(table, playerPosition, "day", votedDay, player.guess);
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
          const vicePlayer = document.querySelector(
            `.cell[data-player="${guessData.vice}"]`,
          );
          let roleClass = "";
          if (vicePlayer) {
            if (vicePlayer.querySelector(".mafia-vote")) {
              roleClass = "mafs";
            } else if (vicePlayer.querySelector(".sheriff-vote")) {
              roleClass = "sheriff";
            } else {
              roleClass = "civs";
            }
          }

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
    if (vote.candidate === playerPosition && vote.num === 1) {
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
  appendStyle(`
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
    .mafs .number { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .civs .number { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
    .sheriff .number { background: rgba(234, 179, 8, 0.2); color: #eab308; }
    .vice .number { background: rgba(147, 51, 234, 0.2); color: #9333ea; }
    .best-move-dot:hover + .best-move-tooltip { display: block; }
    .cell { position: relative !important; }
  `);
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

function getActionIcon(type: string): string {
  switch (type) {
    case "kill":
      return '<img src="https://images.vexels.com/media/users/3/136961/isolated/lists/939659c2bb1b5e619a537af30d3a5849-target-icon.png" alt="Target" style="width: 16px; height: 16px; vertical-align: middle;">';
    case "check":
      return '<img src="https://img.icons8.com/ios7/200/FFFFFF/search.png" alt="Magnifying Glass" style="width: 16px; height: 16px; vertical-align: middle;">';
    case "don_check":
      return '<img src="https://cdn-icons-png.flaticon.com/512/3296/3296104.png" alt="Eye" style="width: 16px; height: 16px; vertical-align: middle;">';
    case "vote":
      return '<img src="https://img.icons8.com/ios_filled/512/FFFFFF/search.png" alt="Thumbs Up" style="width: 16px; height: 16px; vertical-align: middle;">';
    default:
      return '<img src="https://cdn-icons-png.flaticon.com/512/271/271228.png" alt="Arrow" style="width: 16px; height: 16px; vertical-align: middle;">';
  }
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

  // Голосования num === 1.
  votes.forEach((vote: any) => {
    if (vote.day && vote.day > 0 && vote.num === 1) {
      const dayVotes = votes.filter((v: any) => v.day === vote.day && v.num === 1);
      const voteCount: Record<number, number> = {};
      dayVotes.forEach((v: any) => {
        voteCount[v.candidate] = (voteCount[v.candidate] || 0) + 1;
      });
      const maxVotes = Math.max(...Object.values(voteCount));

      phases[vote.day - 1].day.push({
        type: "vote",
        from: vote.voter,
        to: vote.candidate,
        isLeading: voteCount[vote.candidate] === maxVotes,
        num: 1,
      });
    }
  });

  // Голосования num === 2.
  votes.forEach((vote: any) => {
    if (vote.day && vote.day > 0 && vote.num === 2) {
      const dayVotes = votes.filter((v: any) => v.day === vote.day && v.num === 2);
      const voteCount: Record<number, number> = {};
      dayVotes.forEach((v: any) => {
        voteCount[v.candidate] = (voteCount[v.candidate] || 0) + 1;
      });
      const maxVotes = Math.max(...Object.values(voteCount));

      phases[vote.day - 1].day.push({
        type: "vote",
        from: vote.voter,
        to: vote.candidate,
        isLeading: voteCount[vote.candidate] === maxVotes,
        num: 2,
      });
    }
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
        const day = penalty.stage.day;
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
            tooltipText = `Дисквалификация\n${initiator}${votes}`;
            break;
          case "stop":
            tooltipText = `ППК\n${initiator}${votes}`;
            break;
          case "tech":
            tooltipText = `ТЕХ.ФОЛ\n${initiator}${votes}`;
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
        const penaltyKey = `${day}|${type}|${penalty.initiator}|${playerPosition}|${votePairs}`;
        addPenaltyDot(table, playerPosition, day, color, tooltipText, penaltyKey);
      });
    }
  });
}

function addPenaltyDot(
  table: HTMLElement,
  playerPosition: number,
  day: number,
  color: string,
  tooltipText: string,
  penaltyKey: string,
): void {
  const rows = table.querySelectorAll<HTMLElement>(SITE.statsRow);

  rows.forEach((row) => {
    const phaseCell = row.querySelector(SITE.statsCellTitle);
    const phaseText = phaseCell?.textContent || "";

    if (phaseText.includes(`${day} ☀️`)) {
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
    appendStyle(`[${dataVAttribute}] { height: auto !important; }`);
  }

  gameStatsTable.style.height = "auto";

  // Чиним прокручиваемых родителей.
  let parent = gameStatsTable.parentElement;
  while (parent) {
    const computedStyle = window.getComputedStyle(parent);
    if (
      computedStyle.overflow.includes("scroll") ||
      computedStyle.overflowY === "scroll" ||
      parent.classList.contains("__vuescroll") ||
      parent.classList.contains("__panel") ||
      parent.classList.contains("__view")
    ) {
      parent.style.height = "auto";
      parent.style.maxHeight = "none";
    }
    parent = parent.parentElement;
  }

  // Строки итога и MMR.
  const tableRows = gameStatsTable.querySelectorAll<HTMLElement>(SITE.statsRow);
  if (tableRows.length >= 2) {
    const mmrRow = tableRows[tableRows.length - 1];
    const totalRow = tableRows[tableRows.length - 2];

    if (mmrRow && totalRow) {
      mmrRow.setAttribute(
        "style",
        "background: #1a1c29 !important; border-bottom: 2px solid #2c3347 !important;",
      );
      totalRow.setAttribute(
        "style",
        "background: #1a1c29 !important; border-top: 2px solid #2c3347 !important;",
      );

      const mmrTitle = mmrRow.querySelector(SITE.statsCellTitle);
      const totalTitle = totalRow.querySelector(SITE.statsCellTitle);
      if (mmrTitle && totalTitle) {
        mmrTitle.setAttribute(
          "style",
          "background: #151824 !important; font-weight: 700 !important; color: #d1d5db !important;",
        );
        totalTitle.setAttribute(
          "style",
          "background: #151824 !important; font-weight: 700 !important; color: #d1d5db !important;",
        );
      }

      totalRow.querySelectorAll<HTMLElement>(".cell:not(.title)").forEach((cell) => {
        const value = parseFloat(cell.textContent?.trim() || "") || 0;
        if (value > 0) {
          cell.setAttribute(
            "style",
            "color: #10b981 !important; font-weight: 600 !important; font-size: 16px !important;",
          );
        } else if (value < 0) {
          cell.setAttribute(
            "style",
            "color: #ef4444 !important; font-weight: 600 !important; font-size: 16px !important;",
          );
        } else {
          cell.setAttribute(
            "style",
            "color: #94a3b8 !important; font-weight: 600 !important; font-size: 16px !important;",
          );
        }
      });

      mmrRow.querySelectorAll<HTMLElement>(".cell:not(.title)").forEach((cell) => {
        const value = parseInt(cell.textContent?.trim() || "", 10) || 0;
        if (value > 0) {
          cell.setAttribute(
            "style",
            "color: #10b981 !important; font-weight: 700 !important; font-size: 17px !important;",
          );
        } else if (value < 0) {
          cell.setAttribute(
            "style",
            "color: #ef4444 !important; font-weight: 700 !important; font-size: 17px !important;",
          );
        } else {
          cell.setAttribute(
            "style",
            "color: #94a3b8 !important; font-weight: 700 !important; font-size: 17px !important;",
          );
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
    [data-v-33ae8458] { height: auto !important; }
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
      flex-wrap: nowrap !important;
      justify-content: center !important;
      align-items: center !important;
      gap: 2px !important;
      min-height: auto !important;
      height: auto !important;
      margin: 2px !important;
    }
    .action:hover { background: rgba(40, 40, 50, 0.7) !important; }
    .action.kill { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .action.check { background: rgba(234, 179, 8, 0.2); color: #eab308; }
    .action.don_check { background: rgba(147, 51, 234, 0.2); color: #9333ea; }
    .action.vote { background: rgba(30, 30, 40, 0.5) !important; color: #ffffff; }
    .action.vote.leading .voter { background: rgba(59, 130, 246, 0.2); }
    .action.kill img {
      width: 16px;
      height: 16px;
      vertical-align: middle;
      margin-right: 2px;
      filter: brightness(1.2);
    }
    .voter { color: #ef4444 !important; }
    .voter.don-vote { color: #9333ea !important; }
    .voter.mafia-vote { color: white !important; }
    .voter.sheriff-vote { color: #eab308 !important; }
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
  `);

  // Пояснения к иконкам действий на hover (выстрел/проверки/голосования).
  appendStyle(`
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
  `);
}

// ───────────────────────── жизненный цикл фичи ─────────────────────────

export const matchStatsFeature: Feature = {
  id: "match-stats",
  settingKey: "match_page_stats_enabled",

  enable(ctx: FeatureContext): void {
    settings = ctx.settings;

    // Работаем только на странице матча.
    if (!window.location.pathname.includes("/match/")) {
      log.debug(SCOPE, "not a match page, skip");
      return;
    }

    log.debug(SCOPE, "Match page detected, initializing enhancer");

    injectBaseStyles();

    // Авто-высота: один прогон при готовности + периодическое обновление.
    const startAutoHeight = () => {
      applyAutoHeight();
      const id = trackInterval(setInterval(applyAutoHeight, 5000));
      // (clearInterval предыдущего не требуется — храним все в наборе intervals)
      void id;
    };
    if (document.readyState === "complete") {
      startAutoHeight();
    } else {
      loadListener = () => startAutoHeight();
      window.addEventListener("load", loadListener);
    }

    gameDataListener = (event: Event) => {
      if (!statsEnabled()) return;
      log.debug(SCOPE, "Received game data, enhancing page");
      enhance((event as CustomEvent).detail);
    };
    document.addEventListener("gameDataParsed", gameDataListener);
  },

  update(ctx: FeatureContext): void {
    settings = ctx.settings;
    // Если статистика выключена настройкой — снимаем добавленные элементы.
    if (!statsEnabled()) {
      removeEnhancements();
    }
  },

  disable(): void {
    // Снять слушатель события игры.
    if (gameDataListener) {
      document.removeEventListener("gameDataParsed", gameDataListener);
      gameDataListener = null;
    }
    // Снять load-слушатель.
    if (loadListener) {
      window.removeEventListener("load", loadListener);
      loadListener = null;
    }
    // Очистить все интервалы и таймауты.
    for (const id of intervals) clearInterval(id);
    intervals.clear();
    for (const id of timeouts) clearTimeout(id);
    timeouts.clear();
    // Удалить инжектированные стили.
    for (const style of injectedStyles) style.remove();
    injectedStyles.length = 0;
    // Удалить построенные элементы.
    removeEnhancements();
    settings = null;
  },
};
