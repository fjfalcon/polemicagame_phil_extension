/**
 * Статистика пересечений: «сколько мы с этим игроком сыграли вместе, в каких
 * цветах и чем это кончалось».
 *
 * Почему это возможно без разбора каждого матча: история игр профиля
 * (`/profile/default/get-games`) отдаёт по строке на игру, и в строке есть
 * НОМЕР МАТЧА, роль и результат. Значит достаточно взять свою историю и его,
 * пересечь по номеру — и обе роли в общей игре известны точно, без догадок.
 *
 * ПРО ПОТОЛОК. Одна страница отдаёт 200 игр, и первая версия этим и
 * ограничивалась. На живых данных 09.08.2026 это недосчитывало до полутора
 * раз: у владельца 374 игры, у соперника 3654 — последние 200 его игр
 * покрывают куда меньший срок, и всё, что раньше, выпадало. Поэтому история
 * тянется страницами, но не бесконечно:
 *  - у обоих есть общий предел страниц (иначе одно наведение мыши стоило бы
 *    двух десятков запросов);
 *  - чужую историю тянем только до САМОЙ СТАРОЙ своей игры: раньше неё
 *    пересекаться нечему по определению;
 *  - если упёрлись в предел, сводка честно это сообщает — «вместе 12» и
 *    «12 за доступный отрезок» разные утверждения.
 *
 * Сеть отделена от счёта намеренно: считать пересечение — чистая функция, и
 * именно в ней легче всего молча начать врать (спутать команды, посчитать
 * чужую победу за свою).
 */
import { log } from "./log";

const SCOPE = "crossover";

/** Одна игра из истории профиля — только те поля, на которые мы опираемся. */
export interface GameRow {
  /** Номер матча: по нему и происходит пересечение. */
  id: number;
  /** Роль сайта: civilian | sheriff | mafia | don. */
  role: string;
  /** Победа игрока в этой игре. */
  win: boolean;
  /** Дата начала — по ней ограничиваем глубину чужой истории. */
  date?: string;
}

export interface SharedGame {
  id: number;
  myRole: string;
  theirRole: string;
  myWin: boolean;
  sameTeam: boolean;
  date?: string;
}

/** Сыграно и выиграно (МНОЙ) — во всех разрезах считаем одинаково. */
export interface Bucket {
  games: number;
  wins: number;
}

export interface Crossover {
  /** Сколько игр сыграно вместе. */
  together: number;
  /** Одноцвет — были в одной команде. */
  sameTeam: Bucket;
  /** …из них оба красными и оба чёрными. */
  sameRed: Bucket;
  sameBlack: Bucket;
  /** Разноцвет — играли друг против друга. */
  versus: Bucket;
  /** …из них я красный (он чёрный) и я чёрный (он красный). */
  versusMyRed: Bucket;
  versusMyBlack: Bucket;
  /** Сколько раз ОН был чёрным — во всех общих играх. */
  theirBlack: number;
  /** Последние общие игры — свежие первыми. */
  recent: SharedGame[];
  /**
   * Историю пришлось оборвать пределом страниц: общих игр могло быть больше.
   * Показывать это обязательно — иначе число читается как полный итог.
   */
  capped: boolean;
}

/** Чёрные роли сайта. Дон приходит как `don`. */
const BLACK_ROLES = new Set(["mafia", "don", "godfather"]);

export function isBlackRole(role: string): boolean {
  return BLACK_ROLES.has(role);
}

/** Сколько общих игр показываем списком. */
export const RECENT_LIMIT = 5;

function bump(b: Bucket, win: boolean): void {
  b.games++;
  if (win) b.wins++;
}

const empty = (): Bucket => ({ games: 0, wins: 0 });

/**
 * Пересечь две истории. Победы ВЕЗДЕ считаются мои: в одноцвете это и наша
 * общая победа, в разноцвете — именно моя, а не «чья-нибудь».
 */
export function crossGames(mine: GameRow[], theirs: GameRow[], capped = false): Crossover {
  const byId = new Map<number, GameRow>();
  for (const row of theirs) byId.set(row.id, row);

  const out: Crossover = {
    together: 0,
    sameTeam: empty(),
    sameRed: empty(),
    sameBlack: empty(),
    versus: empty(),
    versusMyRed: empty(),
    versusMyBlack: empty(),
    theirBlack: 0,
    recent: [],
    capped,
  };

  for (const my of mine) {
    const their = byId.get(my.id);
    if (!their) continue;
    const myBlack = isBlackRole(my.role);
    const theirBlack = isBlackRole(their.role);
    const same = myBlack === theirBlack;
    if (theirBlack) out.theirBlack++;
    if (same) {
      bump(out.sameTeam, my.win);
      bump(myBlack ? out.sameBlack : out.sameRed, my.win);
    } else {
      bump(out.versus, my.win);
      bump(myBlack ? out.versusMyBlack : out.versusMyRed, my.win);
    }
    out.recent.push({
      id: my.id,
      myRole: my.role,
      theirRole: their.role,
      myWin: my.win,
      sameTeam: same,
      date: my.date ?? their.date,
    });
  }
  out.together = out.recent.length;
  // История приходит свежими вперёд, но полагаться на это нельзя: сортируем
  // по номеру матча — он растёт со временем.
  out.recent.sort((a, b) => b.id - a.id);
  out.recent = out.recent.slice(0, RECENT_LIMIT);
  return out;
}

/** Разбор ответа истории игр. Чужой формат — не повод падать. */
export function parseGameRows(payload: unknown): { rows: GameRow[]; total: number } | null {
  const data = payload as { rows?: unknown; totalCount?: unknown } | null;
  if (!data || !Array.isArray(data.rows)) return null;
  const rows: GameRow[] = [];
  for (const raw of data.rows) {
    const r = raw as {
      id?: unknown;
      role?: { type?: unknown };
      result?: { code?: unknown };
      date_start?: unknown;
    };
    const id = typeof r?.id === "number" ? r.id : Number(r?.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    rows.push({
      id,
      role: typeof r.role?.type === "string" ? r.role.type : "civilian",
      win: r.result?.code === "success",
      date: typeof r.date_start === "string" ? r.date_start : undefined,
    });
  }
  const total = typeof data.totalCount === "number" ? data.totalCount : rows.length;
  return { rows, total };
}

/** Игр за один запрос (потолок выдачи сайта, проверено живьём). */
export const PAGE_SIZE = 200;
/**
 * Сколько страниц готовы взять на одного игрока. Восемь — это 1600 игр:
 * полная история почти для всех, а для завсегдатаев с тремя тысячами партий
 * честная оговорка в сводке лучше двадцати запросов на одно наведение.
 */
export const MAX_PAGES = 8;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchPage(
  userId: number | string,
  page: number,
): Promise<{ rows: GameRow[]; total: number } | null> {
  try {
    const res = await fetch(
      `https://polemicagame.com/profile/default/get-games?userId=${encodeURIComponent(String(userId))}&page=${page}&limit=${PAGE_SIZE}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) {
      log.warn(SCOPE, `история игр: ответ ${res.status}`);
      return null;
    }
    const parsed = parseGameRows(await res.json());
    if (!parsed) log.warn(SCOPE, "история игр: неожиданный формат ответа");
    return parsed;
  } catch (e) {
    log.warn(SCOPE, "история игр не загрузилась", e);
    return null;
  }
}

export interface History {
  rows: GameRow[];
  total: number;
  /** Остались непрочитанные страницы — история оборвана пределом. */
  truncated: boolean;
}

/**
 * Скачать историю игр.
 *
 * `until` — дата самой старой игры второго участника: глубже лезть незачем,
 * пересекаться там не с чем. Возвращает null, если не удалось получить даже
 * первую страницу (это НЕ «игр нет»).
 */
export async function fetchHistory(
  userId: number | string,
  until?: string,
  maxPages = MAX_PAGES,
): Promise<History | null> {
  const first = await fetchPage(userId, 1);
  if (!first) return null;
  const rows = [...first.rows];
  let page = 1;
  const reachedDepth = (): boolean => {
    if (until === undefined) return false;
    const last = rows[rows.length - 1]?.date;
    // Строка БЕЗ даты не должна обрывать листание: пустая строка меньше
    // любой даты, и один такой ответ и останавливал загрузку, и помечал
    // историю полной — то есть недобор выдавался бы за точный итог.
    return last !== undefined && last < until;
  };

  while (rows.length < first.total && page < maxPages && !reachedDepth()) {
    page++;
    const next = await fetchPage(userId, page);
    // Обрыв посреди листания — не выдумываем: считаем историю неполной.
    if (!next || next.rows.length === 0) {
      return { rows, total: first.total, truncated: true };
    }
    rows.push(...next.rows);
  }
  return {
    rows,
    total: first.total,
    truncated: rows.length < first.total && !reachedDepth(),
  };
}

/** Самая старая дата в истории — граница, глубже которой искать нечего. */
export function oldestDate(rows: GameRow[]): string | undefined {
  let oldest: string | undefined;
  for (const r of rows) {
    if (!r.date) continue;
    if (oldest === undefined || r.date < oldest) oldest = r.date;
  }
  return oldest;
}

/**
 * Пересечение с игроком. null — не удалось получить хотя бы одну историю:
 * пустая сводка выглядела бы как «вы никогда не играли вместе», а это другое
 * утверждение.
 *
 * Свою историю загружает вызывающий и переиспользует для всех игроков — она
 * одна на сессию, и тянуть её заново на каждого соседа по столу незачем.
 */
export async function crossoverWith(
  myHistory: History,
  theirUserId: number | string,
): Promise<Crossover | null> {
  const theirs = await fetchHistory(theirUserId, oldestDate(myHistory.rows));
  if (!theirs) return null;
  return crossGames(myHistory.rows, theirs.rows, myHistory.truncated || theirs.truncated);
}
