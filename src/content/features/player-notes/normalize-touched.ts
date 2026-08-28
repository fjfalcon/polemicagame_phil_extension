/**
 * Нормализация ТОЛЬКО затронутых записей — для аварийной прямой записи, когда
 * координатор в фоне недоступен.
 *
 * Почему не вся карта (ревью 27.08.2026): полная нормализация резала ЧУЖУЮ
 * давнюю длинную заметку при сохранении совсем другой — правка одного игрока
 * портила данные другого.
 */
import {
  MAX_OWN_NOTE_TEXT,
  normalizeNoteRecord,
  type NotesMap,
} from "@core/notes-store";

export function normalizeTouched(
  raw: NotesMap,
  keys: string[],
): { map: NotesMap; truncated: number; skipped: number } {
  const map: NotesMap = { ...raw };
  let truncated = 0;
  let skipped = 0;
  for (const key of new Set(keys)) {
    // Только СОБСТВЕННОЕ свойство: ключ вроде «toString» иначе отдаёт функцию
    // с прототипа, и счётчик пропусков врал (adversarial 28.08.2026).
    const note = Object.hasOwn(map, key) ? map[key] : undefined;
    if (note === undefined) continue;
    const safe = normalizeNoteRecord(note, MAX_OWN_NOTE_TEXT);
    if (!safe) {
      delete map[key];
      skipped++;
      continue;
    }
    const original = typeof note === "string" ? note : (note as { text?: unknown })?.text;
    if (typeof original === "string" && original.length > safe.text.length) truncated++;
    map[key] = safe;
  }
  return { map, truncated, skipped };
}

