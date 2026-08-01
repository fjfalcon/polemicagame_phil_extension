/**
 * Координатор записи заметок — ЕДИНСТВЕННАЯ очередь записи на весь браузер.
 *
 * Зачем. Карта заметок хранится одним элементом storage (`playerNotes`), а
 * запись элемента — это замена целиком. Пока каждая вкладка писала сама,
 * две вкладки, правившие РАЗНЫХ игроков, затирали правки друг друга:
 * обе читали карту N, строили N+Алиса и N+Боб, и побеждала последняя
 * запись. Обе при этом показывали успех, а потеря обнаруживалась только
 * после перезагрузки (аудит lifecycle 01.08.2026, находка 2 — КРИТИЧНО;
 * тот же класс гонки independently нашёл аудит безопасности, находки 1-2).
 *
 * Как. Content и popup больше не пишут карту сами: они шлют сюда ТОЧЕЧНЫЕ
 * операции («поставь такой-то ключ», «удали такой-то»). Здесь операции
 * выстраиваются в одну очередь, и каждая читает СВЕЖУЮ карту с диска перед
 * применением — окно между чтением и записью не покидает background.
 *
 * Инварианты: заметки остаются в storage.local (AGENTS.md §4.3), sync-мост
 * не трогаем; loadFailed по-прежнему запрещает писать поверх непрочитанного.
 */
import {
  loadNotes,
  saveNotes,
  mergeNotes,
  normalizeNoteRecord,
  MAX_OWN_NOTE_TEXT,
} from "@core/notes-store";
import type { NotesMap, NoteRecord } from "@core/notes-store";
import { log } from "@core/log";
import type { NoteOp, NotesResultMsg } from "@shared/types";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Применить точечные правки. Возвращает свежую карту для синхронизации UI. */
export function applyNoteOps(ops: NoteOp[]): Promise<NotesResultMsg> {
  return enqueue(async () => {
    if (!Array.isArray(ops) || ops.length === 0) return { ok: true };
    const { notes, loadFailed } = await loadNotes();
    if (loadFailed) {
      // Пустая карта после сбоя чтения — не «заметок нет»: писать нельзя.
      // reason отличает ОСОЗНАННЫЙ отказ от «координатор не ответил»:
      // вызывающий не должен в этом случае писать напрямую в обход защиты.
      log.warn("notes-coordinator", "read failed, write refused");
      return { ok: false, reason: "read_failed" };
    }
    const next: NotesMap = { ...notes };
    for (const op of ops) {
      if (!op || typeof op.key !== "string" || !op.key) continue;
      if (op.record === null) {
        delete next[op.key];
        continue;
      }
      // Запись пересобирается нормализатором: сюда приходит структура из
      // другого контекста, доверять ей как есть нельзя.
      // Локальная правка — потолок текста «свой», а не импортный: обрезать
      // набранную руками заметку на 5000 символах пользователь не просил.
      const rec = normalizeNoteRecord(op.record, MAX_OWN_NOTE_TEXT);
      if (rec) next[op.key] = rec;
    }
    const ok = await saveNotes(next);
    return ok ? { ok, notes: next as Record<string, unknown> } : { ok };
  });
}

/** Слить карту (импорт бэкапа) — тот же контракт очереди. */
export function mergeNotesViaCoordinator(
  incoming: Record<string, unknown>,
): Promise<NotesResultMsg> {
  return enqueue(async () => {
    const { notes, loadFailed } = await loadNotes();
    if (loadFailed) return { ok: false, reason: "read_failed" };
    const { merged, added, replaced } = mergeNotes(notes, incoming as NotesMap);
    if (!added && !replaced) return { ok: true, added: 0, replaced: 0 };
    const ok = await saveNotes(merged);
    return ok
      ? { ok, notes: merged as Record<string, unknown>, added, replaced }
      : { ok: false, added, replaced };
  });
}

export type { NoteRecord };
