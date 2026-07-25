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
let activeMatchId: string | null = null;
let activeRequest: AbortController | null = null;

export function getLastGameData(): unknown {
  return lastGameData;
}

export function getMatchId(pathname = location.pathname): string | null {
  return pathname.match(/^\/match\/([^/]+)\/?$/)?.[1] || null;
}

export async function parseMatchOnPage(matchId = getMatchId()): Promise<void> {
  if (matchId === activeMatchId && activeRequest) return;

  activeRequest?.abort();
  activeRequest = null;
  if (matchId !== activeMatchId) lastGameData = null;
  activeMatchId = matchId;
  if (!matchId) return;

  const request = new AbortController();
  activeRequest = request;
  try {
    const res = await fetch(`https://polemicagame.com/match/${matchId}`, {
      signal: request.signal,
    });
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
    if (request.signal.aborted || getMatchId() !== matchId || activeRequest !== request) return;
    lastGameData = detail;
    document.dispatchEvent(new CustomEvent("gameDataParsed", { detail }));
    log.info("match-data", "parsed match", matchId);
  } catch (e) {
    if (request.signal.aborted) return;
    log.error("match-data", "parse failed", e);
  } finally {
    if (activeRequest === request) activeRequest = null;
  }
}
