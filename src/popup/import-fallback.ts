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
import { MAX_OWN_NOTE_TEXT, mergeNotes, type NotesMap } from "@core/notes-store";
import type { NotesResultMsg } from "@shared/types";

export interface ImportFallbackDeps {
  loadNotes(): Promise<{ notes: NotesMap; loadFailed?: boolean }>;
  saveNotes(map: NotesMap): Promise<boolean>;
  /** Диалог «затираемых стало больше»: свежее число против одобренного. */
  confirmMore(freshReplaced: number, approvedReplaced: number): Promise<boolean>;
}

export type ImportFallbackResult =
  | { status: "saved"; added: number; replaced: number; truncated: number }
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
    // Тот же потолок, что у координатора (adversarial 27.08, HIGH-1): иначе
    // фолбэк резал СВОЮ заметку до 5000 и рапортовал успех — ровно та потеря
    // данных, которую волна и чинила.
    const fresh = mergeNotes(notes, incoming, { maxText: MAX_OWN_NOTE_TEXT });
    if (fresh.replaced > approved) {
      if (confirms >= MAX_CONFIRMS) return { status: "unstable" };
      confirms++;
      if (!(await deps.confirmMore(fresh.replaced, approved))) return { status: "cancelled" };
      approved = fresh.replaced;
      continue; // ПЕРЕЧИТАТЬ после диалога — за время вопроса карта могла уехать
    }
    if (!(await deps.saveNotes(fresh.merged))) return { status: "save_failed" };
    return {
      status: "saved",
      added: fresh.added,
      replaced: fresh.replaced,
      truncated: fresh.truncated,
    };
  }
}

// ─────────────── координаторный путь: петля согласия ───────────────

export interface CoordinatorImportDeps {
  /** Один вызов notes_merge с пределом согласия. undefined — фон не ответил. */
  merge(approvedReplaced: number): Promise<NotesResultMsg | undefined>;
  confirmMore(freshReplaced: number, approvedReplaced: number): Promise<boolean>;
}

export type CoordinatorImportResult =
  | { status: "done"; applied: NotesResultMsg | undefined; approved: number }
  | { status: "cancelled" }
  | { status: "unstable" };

/**
 * Петля согласия КООРДИНАТОРНОГО пути — та же дисциплина, что у фолбэка
 * (adversarial 26.08.2026, №1: инлайн-дубль в попапе жил без тестов, а
 * предел «2» был литералом, способным разъехаться с MAX_CONFIRMS).
 * consent_exceeded → новый вопрос со свежими числами; рост быстрее
 * MAX_CONFIRMS согласий → unstable. Любой другой ответ (включая undefined
 * и malformed) отдаётся вызывающему вместе с итоговым approved — фолбэк
 * стартует с него, а не с додиалогового baseline (№5).
 */
/**
 * Строгая классификация ответа координатора (fail-closed, шестая волна):
 *  • "success" — только ok===true с конечными неотрицательными added/replaced;
 *  • "dead" — undefined: фон не ответил, единственный случай для фолбэка;
 *  • "read_failed" — фолбэк запрещён (не пишем поверх непрочитанного);
 *  • "refused" — всё остальное: явный отказ И malformed ({}, ok:"false",
 *    ok:true без чисел). Malformed при, возможно, живом координаторе в
 *    прямую запись НЕ уходит — гонка с его очередью хуже несохранённого
 *    импорта, который можно повторить.
 */
export function classifyMergeResponse(
  applied: NotesResultMsg | undefined,
): "success" | "dead" | "read_failed" | "refused" {
  if (applied === undefined) return "dead";
  if (applied.reason === "read_failed") return "read_failed";
  if (
    applied.ok === true &&
    // Успех без счётчиков — неполный контракт: именно он прикрывал
    // молчаливую обрезку (ревью 27.08.2026).
    typeof applied.truncated === "number" &&
    typeof applied.skipped === "number" &&
    typeof applied.added === "number" &&
    Number.isFinite(applied.added) &&
    applied.added >= 0 &&
    typeof applied.replaced === "number" &&
    Number.isFinite(applied.replaced) &&
    applied.replaced >= 0
  ) {
    return "success";
  }
  return "refused";
}

export async function runCoordinatorImport(
  approvedReplaced: number,
  deps: CoordinatorImportDeps,
): Promise<CoordinatorImportResult> {
  let approved = approvedReplaced;
  let confirms = 0;
  for (;;) {
    const applied = await deps.merge(approved);
    if (applied?.ok === false && applied.reason === "consent_exceeded") {
      const fresh = applied.replaced;
      // Жёсткая проверка payload (fail-closed): consent_exceeded без
      // валидного replaced — malformed, наружу как есть (классификатор
      // отправит его в refused, не в новый диалог с мусорными числами).
      if (typeof fresh !== "number" || !Number.isFinite(fresh) || fresh < 0) {
        return { status: "done", applied, approved };
      }
      if (confirms >= MAX_CONFIRMS) return { status: "unstable" };
      confirms++;
      if (!(await deps.confirmMore(fresh, approved))) {
        return { status: "cancelled" };
      }
      approved = fresh;
      continue;
    }
    return { status: "done", applied, approved };
  }
}
