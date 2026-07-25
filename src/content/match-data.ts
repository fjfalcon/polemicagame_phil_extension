/**
 * Парсинг данных матча на странице /match/:id и диспатч события `gameDataParsed`,
 * которое слушают match-stats и tooltip фичи. Порт match-parser.js.
 */
import { log } from "@core/log";

/**
 * Последние распарсенные данные. Событие gameDataParsed не буферизуется:
 * если fetch завершался раньше, чем match-stats/tooltip успевали повесить
 * слушатель (их enable ждёт чтения настроек), страница молча оставалась без
 * статистики. Опоздавшие подписчики забирают данные отсюда.
 */
let lastGameData: unknown = null;

export function getLastGameData(): unknown {
  return lastGameData;
}

export async function parseMatchOnPage(): Promise<void> {
  if (!location.pathname.includes("/match/")) return;
  const matchId = location.pathname.split("/").pop();
  try {
    const res = await fetch(`https://polemicagame.com/match/${matchId}`);
    if (res.status !== 200) return;
    const text = await res.text();
    const m =
      text.match(/data-game='([^']+)'/) ||
      text.match(/:game='([^']+)'/) ||
      text.match(/game-data='([^']+)'/);
    if (!m) {
      log.debug("match-data", "game data not found");
      return;
    }
    const gameData = JSON.parse(m[1]);
    const detail = {
      ...gameData,
      players: gameData.players || [],
      history: gameData.history || gameData.events || [],
    };
    lastGameData = detail;
    document.dispatchEvent(new CustomEvent("gameDataParsed", { detail }));
    log.info("match-data", "parsed match", matchId);
  } catch (e) {
    log.error("match-data", "parse failed", e);
  }
}
