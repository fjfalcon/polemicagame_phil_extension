/**
 * Отвечает popup-у на запрос длины ников игроков на странице.
 * Заменяет прежний chrome.scripting.executeScript из popup (главный блокер Firefox).
 */
import { onMessage } from "@core/messaging";

export interface NickInfo {
  number: number;
  name: string;
  length: number;
}
export interface NickLengths {
  players: NickInfo[];
  total: number;
}

export function collectNicknameLengths(): NickLengths {
  const nodes = Array.from(document.querySelectorAll(".player__info.info, .player__info"));
  const players: NickInfo[] = [];
  for (const node of nodes) {
    const nameEl = node.querySelector(".info__name");
    const name = (nameEl?.textContent || "").trim();
    if (!name) continue;
    const numberEl = node.querySelector(".player-number");
    const parsed = Number.parseInt((numberEl?.textContent || "").trim(), 10);
    const number = Number.isFinite(parsed) ? parsed : players.length + 1;
    players.push({ number, name, length: Array.from(name).length });
  }
  const byNumber = new Map<number, NickInfo>();
  for (const p of players) if (!byNumber.has(p.number)) byNumber.set(p.number, p);
  const unique = Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
  const total = unique.reduce((s, p) => s + p.length, 0);
  return { players: unique, total };
}

export function setupNicknameLengthsResponder(): void {
  onMessage((msg) => {
    if ("type" in msg && msg.type === "getNicknameLengths") {
      return Promise.resolve(collectNicknameLengths());
    }
    return undefined;
  });
}
