/**
 * Статистика пересечений: «сколько мы с этим игроком сыграли вместе и кем
 * он в этих играх был».
 *
 * Почему это вообще возможно без разбора каждого матча: история игр профиля
 * (`/profile/default/get-games`) отдаёт по строке на игру, и в строке есть
 * НОМЕР МАТЧА, роль и результат. Значит достаточно взять свою историю и его,
 * пересечь по номеру — и обе роли в общей игре известны точно, без догадок.
 * Проверено живьём 09.08.2026: один запрос отдаёт до 200 игр и сообщает
 * `totalCount`, по которому видно, упёрлись ли мы в потолок.
 *
 * Сеть отделена от счёта намеренно: считать пересечение — чистая функция,
 * и именно в ней легче всего молча начать врать (спутать команды, посчитать
 * ничью за победу). Её и покрываем тестами.
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
  /** Дата начала (для показа последних общих игр). */
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

export interface Crossover {
  /** Сколько игр сыграно вместе. */
  together: number;
  /** Сколько раз ОН был чёрным. */
  theirBlack: number;
  /** Сколько раз мы были в одной команде. */
  sameTeam: number;
  /** Мои победы в общих играх. */
  myWins: number;
  /** Последние общие игры — свежие первыми. */
  recent: SharedGame[];
  /**
   * История хотя бы одного из двоих обрезана потолком выдачи, то есть общих
   * игр могло быть больше. Показать это обязательно: «вместе 3 игры» звучит
   * как факт, а на деле может значить «3 за последние 200 его игр».
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

/**
 * Пересечь две истории. Строки старше потолка выдачи сюда просто не
 * доезжают — за это отвечает `capped`.
 */
export function crossGames(mine: GameRow[], theirs: GameRow[], capped = false): Crossover {
  const byId = new Map<number, GameRow>();
  for (const row of theirs) byId.set(row.id, row);

  const recent: SharedGame[] = [];
  let theirBlack = 0;
  let sameTeam = 0;
  let myWins = 0;

  for (const my of mine) {
    const their = byId.get(my.id);
    if (!their) continue;
    const same = isBlackRole(my.role) === isBlackRole(their.role);
    if (isBlackRole(their.role)) theirBlack++;
    if (same) sameTeam++;
    if (my.win) myWins++;
    recent.push({
      id: my.id,
      myRole: my.role,
      theirRole: their.role,
      myWin: my.win,
      sameTeam: same,
      date: my.date ?? their.date,
    });
  }
  // История приходит свежими вперёд, но полагаться на это нельзя: сортируем
  // по номеру матча — он растёт со временем.
  recent.sort((a, b) => b.id - a.id);
  return {
    together: recent.length,
    theirBlack,
    sameTeam,
    myWins,
    recent: recent.slice(0, RECENT_LIMIT),
    capped,
  };
}

/** Разбор ответа истории игр. Чужой формат — не повод падать. */
export function parseGameRows(payload: unknown): { rows: GameRow[]; total: number } | null {
  const data = payload as { rows?: unknown; totalCount?: unknown } | null;
  if (!data || !Array.isArray(data.rows)) return null;
  const rows: GameRow[] = [];
  for (const raw of data.rows) {
    const r = raw as { id?: unknown; role?: { type?: unknown }; result?: { code?: unknown }; date_start?: unknown };
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

/** Потолок выдачи за один запрос (проверено живьём: 200 отдаёт, больше не нужно). */
export const PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 15_000;

/** Скачать историю игр профиля. null — не удалось (это НЕ «игр нет»). */
export async function fetchGameHistory(
  userId: number | string,
): Promise<{ rows: GameRow[]; total: number } | null> {
  try {
    const res = await fetch(
      `https://polemicagame.com/profile/default/get-games?userId=${encodeURIComponent(String(userId))}&page=1&limit=${PAGE_LIMIT}`,
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

/**
 * Пересечение с игроком. null — не удалось получить хотя бы одну историю:
 * пустая сводка выглядела бы как «вы никогда не играли вместе», а это
 * другое утверждение.
 */
export async function crossoverWith(
  myUserId: number | string,
  theirUserId: number | string,
): Promise<Crossover | null> {
  const [mine, theirs] = await Promise.all([
    fetchGameHistory(myUserId),
    fetchGameHistory(theirUserId),
  ]);
  if (!mine || !theirs) return null;
  const capped = mine.total > mine.rows.length || theirs.total > theirs.rows.length;
  return crossGames(mine.rows, theirs.rows, capped);
}
