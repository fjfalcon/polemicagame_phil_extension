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
  isSafeNoteKey,
  isSafeTag,
  MAX_CUSTOM_TAGS,
  loadNotes,
  saveCustomTags,
  MIGRATED_KEY,
  saveNotes,
  mergeNotes,
  normalizeNoteRecord,
  MAX_OWN_NOTE_TEXT,
} from "@core/notes-store";
import { browser } from "@core/env";
import type { NotesMap, NoteRecord } from "@core/notes-store";
import { log } from "@core/log";
import type { NoteOp, NotesResultMsg, NotesTagsResultMsg } from "@shared/types";

let queue: Promise<unknown> = Promise.resolve();

/**
 * Предел ожидания одной задачи очереди.
 *
 * Очередь одна на весь браузер, и зависшая задача (MV3 усыпил воркер посреди
 * storage-вызова) вешала бы ВСЕХ — и фон, и очередь вкладки, которая ждёт
 * ответа: без тоста, без фолбэка, до перезагрузки страницы (внешний аудит
 * 28.08.2026). Лучше честный отказ: вызывающий покажет ошибку и не потеряет
 * данные молча.
 */
const TASK_TIMEOUT_MS = 10_000;

/** Задача с пределом ожидания: очередь не имеет права зависнуть навсегда. */
function withTimeout<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      log.warn("notes-coordinator", `задача не уложилась в ${TASK_TIMEOUT_MS} мс — отказ`);
      reject(new Error("notes coordinator timeout"));
    }, TASK_TIMEOUT_MS);
    task().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  // Хвост очереди не ждёт зависшую задачу дольше предела: иначе одна
  // повисшая операция останавливает запись заметок во всех вкладках.
  const guarded = () => withTimeout(task);
  const run = queue.then(guarded, guarded);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Применить точечные правки. Возвращает свежую карту для синхронизации UI. */
export function applyNoteOps(ops: NoteOp[]): Promise<NotesResultMsg> {
  return enqueue(async () => {
    if (!Array.isArray(ops) || ops.length === 0) return { ok: true, truncated: 0, skipped: 0 };
    const { notes, loadFailed } = await loadNotes({ persistMigration: true }); // координатор — единственный писатель миграции
    if (loadFailed) {
      // Пустая карта после сбоя чтения — не «заметок нет»: писать нельзя.
      // reason отличает ОСОЗНАННЫЙ отказ от «координатор не ответил»:
      // вызывающий не должен в этом случае писать напрямую в обход защиты.
      log.warn("notes-coordinator", "read failed, write refused");
      return { ok: false, reason: "read_failed" };
    }
    const next: NotesMap = { ...notes };
    let truncated = 0;
    let skipped = 0;
    for (const op of ops) {
      if (!op || typeof op.key !== "string" || !op.key) {
        if (op) skipped++;
        continue;
      }
      // УДАЛЕНИЕ проходит по мягкому правилу (adversarial 27.08.2026):
      // ключ вроде «constructor» мог доехать до диска со старых версий, и
      // строгий фильтр делал такую запись НЕУДАЛЯЕМОЙ — «удалил, а она
      // вернулась» плюс ложный счётчик потерь. Симметрия с isPlainKey.
      if (op.record === null) {
        if (op.key !== "__proto__") delete next[op.key];
        continue;
      }
      // Для ЗАПИСИ фильтр строгий: новый опасный ключ создавать нельзя.
      if (!isSafeNoteKey(op.key)) {
        skipped++;
        continue;
      }
      // Запись пересобирается нормализатором: сюда приходит структура из
      // другого контекста, доверять ей как есть нельзя.
      // Локальная правка — потолок текста «свой», а не импортный: обрезать
      // набранную руками заметку на 5000 символах пользователь не просил.
      const rec = normalizeNoteRecord(op.record, MAX_OWN_NOTE_TEXT);
      // Считаем факты записи: молчаливая обрезка/выброс с ok:true — та же
      // молчаливая потеря, что чинили в импорте (ревью 27.08.2026).
      if (!rec) skipped++;
      else if (
        typeof (op.record as { text?: unknown })?.text === "string" &&
        ((op.record as { text: string }).text.length > rec.text.length)
      ) {
        truncated++;
      }
      if (rec) next[op.key] = rec;
    }
    const ok = await saveNotes(next);
    // truncated/skipped едут наверх ВСЕГДА: вызывающий обязан иметь
    // возможность сказать пользователю правду (ревью 27.08.2026).
    return ok
      ? { ok, notes: next as Record<string, unknown>, truncated, skipped }
      : { ok, truncated, skipped };
  });
}

/**
 * Правки палитры — ИНТЕНТОМ, в той же единственной очереди.
 *
 * Палитра, как и карта заметок, хранится одним элементом storage: запись —
 * это замена целиком. Вкладка, посылающая снимок массива, неизбежно
 * затирает цвет, добавленный соседней вкладкой между её чтением и записью
 * (внешний аудит 28.08.2026). Поэтому наружу выставлен не «сохрани список»,
 * а «добавь эти, убери эти»: свежее чтение и запись не покидают background.
 *
 * Отказ при нечитаемом состоянии — ОСОЗНАННО fail-safe, как у заметок:
 * потерять одно действие пользователя неприятно, перетереть чужие
 * сохранённые цвета — хуже.
 */
export function applyTagOps(add: unknown, remove: unknown): Promise<NotesTagsResultMsg> {
  return enqueue(async () => {
    const asked = Array.isArray(add) ? add : [];
    const toAdd = asked.filter(isSafeTag);
    const toRemove = (Array.isArray(remove) ? remove : []).filter(
      (t): t is string => typeof t === "string" && t !== "",
    );
    // Отбраковали ВСЁ, что просили добавить — это не успех. Иначе вкладка
    // рисует цвет, рапортует «сохранено», а на диске его нет никогда
    // (adversarial 28.08.2026).
    if (toAdd.length === 0 && toRemove.length === 0) {
      return asked.length > 0 ? { ok: false, reason: "unsafe_tag" } : { ok: true };
    }
    const { customTags, loadFailed } = await loadNotes({ persistMigration: true });
    if (loadFailed) {
      log.warn("notes-coordinator", "read failed, tag write refused");
      return { ok: false, reason: "read_failed" };
    }
    const removeSet = new Set(toRemove);
    // Санация ВСЕГО списка, а не только добавляемого: на диск он уезжает
    // целиком, а значение цвета попадает в style.cssText. Элемент, доехавший
    // со старой версии или из чужой ветки записи, — единственный шанс его
    // отфильтровать (adversarial 28.08.2026).
    const kept = customTags.filter((t) => isSafeTag(t) && !removeSet.has(t));
    const merged = [...new Set([...kept, ...toAdd])];
    // Потолок: у импорта он есть (100), у ручного добавления не было —
    // бэкап собственной палитры молча терял бы всё сверх сотни.
    const next = merged.slice(0, MAX_CUSTOM_TAGS);
    const dropped = merged.length - next.length;
    if (dropped > 0) {
      log.warn("notes-coordinator", `палитра упёрлась в потолок ${MAX_CUSTOM_TAGS}: не влезло ${dropped}`);
    }
    const ok = await saveCustomTags(next);
    return ok ? { ok, tags: next, dropped } : { ok };
  });
}

/** Слить карту (импорт бэкапа) — тот же контракт очереди. */
/** Разовая миграция sync→local — сериализованно, единственный писатель (SEC26-5). */
export function migrateViaCoordinator(): Promise<{ ok: boolean }> {
  return enqueue(async () => {
    await loadNotes({ persistMigration: true });
    // Честный ответ: флаг реально выставлен? Иначе контекст-проситель
    // считал бы миграцию сделанной и никогда бы не переспросил.
    const bag = (await browser.storage.local.get({ [MIGRATED_KEY]: false })) as Record<
      string,
      unknown
    >;
    return { ok: bag[MIGRATED_KEY] === true };
  });
}

export function mergeNotesViaCoordinator(
  incoming: Record<string, unknown>,
  approvedReplaced?: number,
): Promise<NotesResultMsg> {
  return enqueue(async () => {
    const { notes, loadFailed } = await loadNotes({ persistMigration: true }); // координатор — единственный писатель миграции
    if (loadFailed) return { ok: false, reason: "read_failed" };
    const { merged, added, replaced, truncated, skipped } = mergeNotes(notes, incoming as NotesMap, {
      // Импорт бэкапа: потолок СВОЕЙ заметки, иначе round-trip собственного
      // файла молча резал хвост (ревью 27.08.2026, п.1).
      maxText: MAX_OWN_NOTE_TEXT,
    });
    // Граница согласия и на координаторном пути (ревью 26.08.2026): цифры
    // диалога считались по снимку попапа, а карта здесь свежая — замен
    // больше одобренного не пишем, возвращаем свежие числа для нового вопроса.
    // FAIL-CLOSED (ревью 26.08.2026, шестая волна): предел согласия
    // ОБЯЗАТЕЛЕН. Отсутствующий/NaN/отрицательный раньше молча выключал
    // границу согласия — теперь это отказ, а не мерж без предела.
    // Единственный штатный отправитель notes_merge — попап этой же версии
    // (MV3 обновляется атомарно), он предел шлёт всегда.
    if (
      typeof approvedReplaced !== "number" ||
      !Number.isFinite(approvedReplaced) ||
      approvedReplaced < 0
    ) {
      return { ok: false, reason: "bad_request" };
    }
    if (replaced > approvedReplaced) {
      return { ok: false, reason: "consent_exceeded", added, replaced };
    }
    if (!added && !replaced) return { ok: true, added: 0, replaced: 0, truncated, skipped };
    const ok = await saveNotes(merged);
    // Счётчики едут ВСЕГДА: UI обязан говорить правду с авторитетного
    // пути, а не с предварительного расчёта (ревью 27.08.2026).
    return ok
      ? { ok, notes: merged as Record<string, unknown>, added, replaced, truncated, skipped }
      : { ok: false, added, replaced, truncated, skipped };
  });
}

export type { NoteRecord };
