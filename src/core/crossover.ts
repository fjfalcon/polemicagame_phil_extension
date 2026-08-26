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
  /** MMR ПОСЛЕ игры — если сайт его отдал (панель «Мой вечер»). */
  mmrAfter?: number;
  /** Изменение MMR за игру — если сайт его отдал. */
  mmrDiff?: number;
  /** Режим игры (league/…) — подпись в «Моём вечере». */
  mode?: string;
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
      mmr?: { mmr?: unknown; mmr_diff?: unknown };
      game_mode?: { value?: unknown };
    };
    const id = typeof r?.id === "number" ? r.id : Number(r?.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const mmrAfter = r.mmr?.mmr;
    const mmrDiff = r.mmr?.mmr_diff;
    rows.push({
      id,
      role: typeof r.role?.type === "string" ? r.role.type : "civilian",
      win: r.result?.code === "success",
      date: typeof r.date_start === "string" ? r.date_start : undefined,
      mmrAfter: typeof mmrAfter === "number" && Number.isFinite(mmrAfter) ? mmrAfter : undefined,
      mmrDiff: typeof mmrDiff === "number" && Number.isFinite(mmrDiff) ? mmrDiff : undefined,
      mode: typeof r.game_mode?.value === "string" ? r.game_mode.value : undefined,
    });
  }
  const total = typeof data.totalCount === "number" ? data.totalCount : rows.length;
  return { rows, total };
}

/**
 * Игр за один запрос.
 *
 * Двести стояло здесь как «потолок выдачи сайта» — и это была ОШИБКА
 * измерения: сайт сам просит по 200, но сервер отдаёт столько, сколько
 * попросишь. Замер 13.08.2026 (аккаунт на 6196 игр):
 *   limit=200  → 1.98 с, 65 КБ
 *   limit=2000 → 2.17 с, 660 КБ
 *   limit=6000 → 2.38 с, 2 МБ
 * То есть время ответа почти целиком серверное и от размера страницы не
 * зависит. Платили мы не за объём, а за КОЛИЧЕСТВО запросов: восемь страниц
 * подряд — это восемь таких ожиданий, шестнадцать секунд на одну историю и
 * до полуминуты на первую сводку (жалоба владельца 13.08.2026).
 */
export const PAGE_SIZE = 2000;
/**
 * Сколько страниц готовы взять на одного игрока. Четыре по две тысячи — это
 * 8000 игр: больше, чем у самого играющего аккаунта сайта (6196 на 13.08.2026),
 * так что оговорка про «доступный отрезок» теперь почти никому не достанется.
 */
export const MAX_PAGES = 4;
/** Страница теперь тяжелее (сотни КБ), и на медленной связи нужен запас. */
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchPage(
  userId: number | string,
  page: number,
  limit: number = PAGE_SIZE,
): Promise<{ rows: GameRow[]; total: number } | null> {
  try {
    const res = await fetch(
      `https://polemicagame.com/profile/default/get-games?userId=${encodeURIComponent(String(userId))}&page=${page}&limit=${limit}`,
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
 * Докуда хватит: последняя строка старше границы — глубже пересекаться не с
 * чем. Строка БЕЗ даты не обрывает листание: пустая строка меньше любой даты,
 * и один такой ответ и останавливал загрузку, и помечал историю полной — то
 * есть недобор выдавался бы за точный итог.
 */
function reachedDepth(rows: GameRow[], until?: string): boolean {
  if (until === undefined) return false;
  const last = rows[rows.length - 1]?.date;
  return last !== undefined && last < until;
}

/** Первая страница истории. null — не удалось (это НЕ «игр нет»). */
export function fetchFirstPage(
  userId: number | string,
  /** Свой limit — для потребителей, которым не нужны тысячи строк:
   *  «Мой вечер» берёт 200 (~65 КБ) вместо 2000 (~660 КБ) каждые 3 минуты. */
  limit: number = PAGE_SIZE,
): Promise<{ rows: GameRow[]; total: number } | null> {
  return fetchPage(userId, 1, limit);
}

/**
 * Дотянуть историю до конца, если первой страницы не хватило.
 *
 * Остальные страницы берутся ОДНОВРЕМЕННО, а не одна за другой: их число
 * известно из totalCount с первой же страницы, а ждать по два секунды за
 * страницу — ровно то, из-за чего первая сводка загружалась полминуты.
 *
 * Плата за это — возможная лишняя страница: последовательное листание могло
 * бы упереться в `until` на второй, а мы к тому моменту уже запросили третью.
 * Обмен осознанный: лишняя страница едет ПАРАЛЛЕЛЬНО и ожидания не удлиняет,
 * а страниц всего до четырёх.
 */
export async function completeHistory(
  userId: number | string,
  first: { rows: GameRow[]; total: number },
  until?: string,
  maxPages = MAX_PAGES,
): Promise<History> {
  const rows = [...first.rows];
  const done = (truncated: boolean): History => ({ rows, total: first.total, truncated });
  // Пустая первая страница при ненулевом счётчике — сервер темнит; листать
  // такое бессмысленно, но и полнотой называть нельзя.
  if (rows.length === 0 || rows.length >= first.total) return done(rows.length < first.total);
  if (reachedDepth(rows, until)) return done(false);

  const pages = Math.min(maxPages, Math.ceil(first.total / PAGE_SIZE));
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => fetchPage(userId, i + 2)),
  );
  for (const page of rest) {
    // Обрыв посреди листания — не выдумываем. Останавливаемся на ПЕРВОМ же:
    // дыра в середине сделала бы «самую старую игру» ложной границей для
    // второй истории, а число общих игр — молчаливым недобором.
    if (!page || page.rows.length === 0) return done(true);
    rows.push(...page.rows);
    if (reachedDepth(rows, until)) return done(false);
  }
  return done(rows.length < first.total);
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
  const first = await fetchFirstPage(userId);
  if (!first) return null;
  return completeHistory(userId, first, until, maxPages);
}

/** Самая старая дата в истории — граница, глубже которой искать нечего. */
// ─────────────── общий кэш СВОЕЙ истории (PERF26-3) ───────────────
//
// До 26.08.2026 своя история жила в трёх независимых кэшах (ховер
// player-notes, карточка профиля, график) и скачивалась до трёх раз за
// десять минут — по 4 страницы × 2000 строк каждая. Кэш один, потребители
// делят и данные, и in-flight.

export const OWN_HISTORY_TTL_MS = 10 * 60_000;

let ownHistory: { id: string; at: number; data: History } | null = null;
let ownHistoryInFlight: { id: string; p: Promise<History | null> } | null = null;

export function getOwnHistory(myId: number | string): Promise<History | null> {
  const id = String(myId);
  if (ownHistory && ownHistory.id === id && Date.now() - ownHistory.at < OWN_HISTORY_TTL_MS) {
    return Promise.resolve(ownHistory.data);
  }
  if (ownHistoryInFlight && ownHistoryInFlight.id === id) return ownHistoryInFlight.p;
  const p = fetchHistory(myId)
    .then((h) => {
      // Гард поздней развязки: сменился аккаунт и уже летит НОВЫЙ запрос —
      // старый не затирает кэш чужими данными (adversarial №11).
      if (h && (!ownHistoryInFlight || ownHistoryInFlight.p === p)) {
        ownHistory = { id, at: Date.now(), data: h };
      }
      return h;
    })
    .finally(() => {
      if (ownHistoryInFlight && ownHistoryInFlight.p === p) ownHistoryInFlight = null;
    });
  ownHistoryInFlight = { id, p };
  return p;
}

/**
 * Отпустить строки истории (у завсегдатая — мегабайты). Продакшен-вызовов
 * НЕТ осознанно (adversarial 26.08.2026, №4/№5: release одного потребителя
 * выбивал кэш из-под другого) — память отпускает TTL. Экспорт — тестовый шов.
 */
export function releaseOwnHistory(): void {
  if (!ownHistoryInFlight) ownHistory = null;
}

export function oldestDate(rows: GameRow[]): string | undefined {
  let oldest: string | undefined;
  for (const r of rows) {
    if (!r.date) continue;
    if (oldest === undefined || r.date < oldest) oldest = r.date;
  }
  return oldest;
}

// Готовой «пересеки меня с ним» здесь больше нет намеренно: свою историю и
// первую страницу чужой надо запускать ОДНОВРЕМЕННО, а знает об обеих только
// вызывающий (свой id, ник соседа и кэш — всё у него). Порядок сборки:
//   fetchFirstPage(их) ‖ своя история → completeHistory(их, ..., oldestDate)
//     → crossGames.
