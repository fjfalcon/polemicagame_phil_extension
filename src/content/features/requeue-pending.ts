/**
 * Метка моста автовозврата (sessionStorage) — чистая логика выпуска,
 * освежения и проверки.
 *
 * Почему не «один timestamp»: TTL в 45 с сравнивался с моментом ПОСТАНОВКИ
 * метки, а серверные длительности (окно принятия, отсчёт роспуска) ничем
 * сверху не ограничены (аудит автовозврата 03.08.2026, RQ-4). Живое условие
 * (принятый блок, видимый отсчёт) обязано ОСВЕЖАТЬ метку, а свежесть —
 * считаться от последнего подтверждения. Абсолютный потолок от issuedAt
 * остаётся: sessionStorage принадлежит сайту и не является доверенным, метка
 * не имеет права жить вечно за счёт бесконечного освежения подделкой.
 */

export interface PendingMark {
  /** Когда эпизод начался (первая постановка). Не меняется при освежении. */
  issuedAt: number;
  /** Последнее подтверждение живого условия. */
  refreshedAt: number;
}

export type MarkFailure = "corrupt" | "future" | "expired" | "capped";

export type MarkVerdict = { ok: true; mark: PendingMark } | { ok: false; reason: MarkFailure };

/** Свежесть скользящая: от ПОСЛЕДНЕГО подтверждения условия, не от выпуска. */
export const PENDING_TTL_MS = 45_000;
/**
 * Абсолютный потолок эпизода от issuedAt. Больше любого разумного серверного
 * отсчёта (окна принятия и роспуска — десятки секунд или минуты), но конечный:
 * метка старше — мусор, даже если её кто-то прилежно «освежал».
 */
export const PENDING_HARD_CAP_MS = 10 * 60_000;

export function serializeMark(mark: PendingMark): string {
  return JSON.stringify({ issuedAt: mark.issuedAt, refreshedAt: mark.refreshedAt });
}

/**
 * Разбор без доверия: значение могло быть записано сайтом, другой версией
 * расширения или испорчено. Любое отклонение от формата — null.
 *
 * Голое число принимается как наследие формата 9.2.x (issuedAt = refreshedAt):
 * sessionStorage переживает перезагрузку страницы, и сразу после обновления
 * расширения в живой вкладке может лежать старая метка.
 */
export function parseMark(raw: string): PendingMark | null {
  const legacy = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(legacy)) {
    return { issuedAt: legacy, refreshedAt: legacy };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { issuedAt, refreshedAt } = value as Record<string, unknown>;
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) return null;
  if (typeof refreshedAt !== "number" || !Number.isFinite(refreshedAt)) return null;
  return { issuedAt, refreshedAt };
}

/**
 * Вердикт по сырому значению. null — метки нет (обычное состояние, НЕ эпизод
 * и не повод для лога: RQ-8 запрещает строку «missing» на каждый тик).
 */
export function validateMark(raw: string | null, now: number): MarkVerdict | null {
  if (raw === null || raw === "") return null;
  const mark = parseMark(raw);
  if (!mark) return { ok: false, reason: "corrupt" };
  // Перепутанные поля — тоже порча: освежение не может опережать выпуск.
  if (mark.refreshedAt < mark.issuedAt) return { ok: false, reason: "corrupt" };
  // Метка из будущего «вечно свежа» — известный трюк недоверенного хранилища
  // (аудит безопасности 01.08.2026, №15).
  if (mark.issuedAt > now || mark.refreshedAt > now) return { ok: false, reason: "future" };
  if (now - mark.issuedAt > PENDING_HARD_CAP_MS) return { ok: false, reason: "capped" };
  if (now - mark.refreshedAt > PENDING_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true, mark };
}

/** Освежение живым условием: эпизод тот же, подтверждение — сейчас. */
export function refreshMark(existing: PendingMark | null, now: number): PendingMark {
  // Испорченный или будущий issuedAt наследовать нельзя: он бы отравил
  // hard cap. Начинаем эпизод заново.
  if (!existing || !Number.isFinite(existing.issuedAt) || existing.issuedAt > now) {
    return { issuedAt: now, refreshedAt: now };
  }
  return { issuedAt: existing.issuedAt, refreshedAt: now };
}
