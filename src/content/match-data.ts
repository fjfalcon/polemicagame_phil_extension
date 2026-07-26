/**
 * Парсинг данных матча на странице /match/:id и диспатч события `gameDataParsed`,
 * которое слушают match-stats и tooltip фичи. Порт match-parser.js.
 *
 * 26.07.2026 сайт ПЕРЕИМЕНОВАЛ атрибут с данными: раньше `data-game='...'`,
 * теперь `<Gamestats :game-data='...'>`. Старые регэкспы перестали матчить —
 * разбор матча молча ломался у всех. Значение — чистый JSON (без HTML-энтити,
 * проверено живым fetch'ем), но на случай появления энтити есть decode-фолбэк.
 * Отдельного JSON-API у страницы нет: данные только в этом атрибуте.
 * Заголовок X-Requested-With — страховка: с ним данные запрашивает сам сайт
 * (jQuery); в момент миграции наблюдалась выдача без данных, стабильно не
 * воспроизводится, заголовок безвреден (same-origin, без префлайта).
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

/**
 * Значение атрибута приходит с HTML-энтити (`&quot;` внутри одинарных кавычек
 * атрибута `:game-data='...'`). Декод через textarea — стандартный безопасный
 * способ: textarea не исполняет разметку.
 */
function decodeHtmlEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  const textarea = document.createElement("textarea");
  textarea.innerHTML = raw;
  return textarea.value;
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
      // Страховка, не необходимость — см. шапку файла.
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (res.status !== 200) return;
    const text = await res.text();
    // Порядок важен: сейчас сайт отдаёт `<Gamestats :game-data='...'>`;
    // `game-data='` матчит и его (это суффикс `:game-data='`). Старые формы
    // оставлены на случай отката сайта.
    const m =
      text.match(/game-data='([^']+)'/) ||
      text.match(/data-game='([^']+)'/) ||
      text.match(/:game='([^']+)'/);
    if (!m) {
      log.debug("match-data", "game data not found");
      return;
    }
    // Parse-first: сегодня payload — чистый JSON. Слепой декод ЛОМАЛ бы его:
    // textarea декодирует legacy-энтити без «;» (`&quota=` → `"a=`,
    // `&times=` → `×=`), а в payload'е есть URL с query-параметрами.
    let gameData: any;
    try {
      gameData = JSON.parse(m[1]);
    } catch {
      gameData = JSON.parse(decodeHtmlEntities(m[1]));
    }
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
