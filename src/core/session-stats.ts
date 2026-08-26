/**
 * «Мой вечер»: логика игровой сессии для одноимённой панели (просьба
 * владельца 26.08.2026 — окошко в духе HS-трекера: последние игры, роль,
 * ±MMR, сумма за вечер).
 *
 * Сессия = игры после ЯКОРЯ. Якорь — большее из двух:
 *  • граница суток в 04:00 локального времени: вечер, перешедший за полночь,
 *    остаётся ОДНОЙ сессией (в 00:30 играют чаще, чем в 03:59 начинают);
 *  • ручной сброс «начать сессию заново» — пользовательское «всё с нуля».
 *
 * Все функции чистые и сторожатся мутационно: перепутать якорь или знак
 * дельты значит молча врать про итог вечера.
 */
import type { GameRow } from "./crossover";

/** Час локального времени, с которого начинаются «новые сутки» сессии. */
export const SESSION_DAY_START_HOUR = 4;

/**
 * Разбор даты сайта «YYYY-MM-DD HH:MM:SS» в epoch-миллисекунды.
 *
 * Метки сервера — UTC: замер 26.08.2026 по свежайшим date_ends тридцати
 * активных игроков (максимум «13:06:31» при текущем 13:31 UTC, ни одной
 * метки ПОЗЖЕ UTC-времени; для МСК свежие концы игр были бы «до 16:31»).
 * Разбор как локального времени уводил игры на смещение пояса в прошлое,
 * и «начать заново» терял свежие игры у любого пользователя восточнее
 * Гринвича (adversarial 26.08.2026, находка №1 по «Моему вечеру»).
 *
 * Руками, не new Date(строка): формат с пробелом Firefox исторически
 * парсит в Invalid Date. Диапазоны полей проверяются: Date молча
 * перекатывает «месяц 19» в следующий год, а битой метке место в null.
 */
export function parseGameDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Якорь сессии. `manualResetMs` — момент нажатия «начать заново» (null, если
 * не нажимали); действует, только если он ПОЗЖЕ суточной границы — вчерашний
 * сброс не должен тащить в сегодняшнюю сессию вчерашние игры.
 */
export function sessionAnchor(nowMs: number, manualResetMs: number | null): number {
  const now = new Date(nowMs);
  const boundary = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    SESSION_DAY_START_HOUR,
  ).getTime();
  // До 04:00 «сегодняшняя» граница ещё в будущем — сутки начались вчера.
  // «Вчера» — через календарь, не −24ч: в день перевода часов (DST) сутки
  // длиной не 24 часа, и вычитание сдвигало бы границу на час.
  const dayStart =
    nowMs >= boundary
      ? boundary
      : new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - 1,
          SESSION_DAY_START_HOUR,
        ).getTime();
  return manualResetMs !== null && manualResetMs > dayStart ? manualResetMs : dayStart;
}

/** Игры сессии, свежие первыми. Игры без даты в сессию не попадают:
 *  неизвестно когда — значит не «сегодня». */
export function pickSessionGames(rows: GameRow[], anchorMs: number): GameRow[] {
  return rows
    .filter((r) => {
      const t = parseGameDate(r.date);
      return t !== null && t >= anchorMs;
    })
    .sort((a, b) => b.id - a.id);
}

export interface SessionSummary {
  games: number;
  wins: number;
  /** Сумма mmr_diff по играм сессии, где сайт его отдал. */
  delta: number;
  /** MMR до первой игры сессии (mmrAfter − mmrDiff самой старой) либо null. */
  startMmr: number | null;
  /** MMR после самой свежей игры с известным MMR либо null. */
  currentMmr: number | null;
}

/** Сводка сессии. `rows` — свежие первыми (как из pickSessionGames). */
export function summarizeSession(rows: GameRow[]): SessionSummary {
  const out: SessionSummary = { games: rows.length, wins: 0, delta: 0, startMmr: null, currentMmr: null };
  for (const r of rows) {
    if (r.win) out.wins++;
    if (typeof r.mmrDiff === "number") out.delta += r.mmrDiff;
  }
  const newestRated = rows.find((r) => typeof r.mmrAfter === "number");
  if (newestRated) out.currentMmr = newestRated.mmrAfter as number;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (typeof r.mmrAfter === "number" && typeof r.mmrDiff === "number") {
      out.startMmr = r.mmrAfter - r.mmrDiff;
      break;
    }
  }
  return out;
}
