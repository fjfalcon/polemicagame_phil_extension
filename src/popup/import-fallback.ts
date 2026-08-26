/**
 * Оркестрация ФОЛБЭКА импорта заметок (координатор недоступен) — вынесена
 * из попапа в чистую функцию, чтобы управляющую логику можно было гонять
 * тестами (ревью 26.08.2026, №3: ветка усложнилась — согласия, перечитывания,
 * отмены — а поведенческих тестов на неё не было).
 *
 * Контракт петли: карта перечитывается ПЕРЕД КАЖДОЙ попыткой записи — в том
 * числе после каждого диалога согласия (пока пользователь читал вопрос,
 * игровая вкладка могла писать; ревью №2: прежний код после второго
 * согласия писал мерж, посчитанный ДО диалога). Если затираемых стало
 * больше одобренного — новый вопрос; если карта растёт быстрее, чем
 * пользователь успевает соглашаться (MAX_CONFIRMS исчерпан, а рост
 * продолжается) — ОТМЕНА, не запись «как получилось»: граница согласия
 * важнее удобства, а повторить импорт бесплатно (ревью 26.08.2026, №3).
 */
import { mergeNotes, type NotesMap } from "@core/notes-store";

export interface ImportFallbackDeps {
  loadNotes(): Promise<{ notes: NotesMap; loadFailed?: boolean }>;
  saveNotes(map: NotesMap): Promise<boolean>;
  /** Диалог «затираемых стало больше»: свежее число против одобренного. */
  confirmMore(freshReplaced: number, approvedReplaced: number): Promise<boolean>;
}

export type ImportFallbackResult =
  | { status: "saved"; added: number; replaced: number }
  | { status: "cancelled" }
  /** Карта меняется быстрее согласий — импорт отменён, повторить позже. */
  | { status: "unstable" }
  | { status: "read_failed" }
  | { status: "save_failed" };

export const MAX_CONFIRMS = 2;

export async function runImportFallback(
  incoming: NotesMap,
  approvedReplaced: number,
  deps: ImportFallbackDeps,
): Promise<ImportFallbackResult> {
  let approved = approvedReplaced;
  let confirms = 0;
  for (;;) {
    const { notes, loadFailed } = await deps.loadNotes();
    if (loadFailed) return { status: "read_failed" };
    const fresh = mergeNotes(notes, incoming);
    if (fresh.replaced > approved) {
      if (confirms >= MAX_CONFIRMS) return { status: "unstable" };
      confirms++;
      if (!(await deps.confirmMore(fresh.replaced, approved))) return { status: "cancelled" };
      approved = fresh.replaced;
      continue; // ПЕРЕЧИТАТЬ после диалога — за время вопроса карта могла уехать
    }
    if (!(await deps.saveNotes(fresh.merged))) return { status: "save_failed" };
    return { status: "saved", added: fresh.added, replaced: fresh.replaced };
  }
}
