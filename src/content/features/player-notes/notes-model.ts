/**
 * Данные заметок: карта записей, палитра меток, очередь записи и все правила
 * сохранения.
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026). Это владелец САМЫХ
 * дорогих для пользователя данных, и правил вокруг них накопилось больше
 * всего: очередь «одна запись за раз» (миграция и модалка иначе переплетались
 * и теряли чужую правку), блокировка записи при непрочитанном хранилище
 * («пишем непрочитанное» стирало заметки), координатор в фоне с честным
 * фолбэком, нормализация ТОЛЬКО затронутых записей (полная резала чужую
 * длинную заметку) и честный ответ «сохранено не полностью».
 *
 * DOM отсюда не виден: перерисовку заказывает вызывающий через четыре
 * сигнала порта.
 */
import { log } from "@core/log";
import { sendRuntime } from "@core/messaging";
import { showToast } from "@core/toast";
import {
  ID_KEY_PREFIX,
  idKey,
  isSafeTag,
  MAX_CUSTOM_TAGS,
  isIdKey,
  isSafeNoteKey,
  loadNotes as loadNotesFromStore,
  MAX_NICK_HISTORY,
  TAGS_KEY,
  NOTES_VERSION,
  saveCustomTags as saveCustomTagsToStore,
  saveNotes as saveNotesToStore,
  withNickHistory,
  type NoteRecord,
  type NotesMap,
} from "@core/notes-store";
import type { NoteOp, NotesResultMsg, NotesTagsResultMsg } from "@shared/types";
import { browser } from "@core/env";
import { normalizeTouched } from "./normalize-touched";
import { NoteKeys } from "./note-keys";

const VERSION = NOTES_VERSION;

export interface NotesModelContext {
  /** Фича жива: поздняя запись мёртвой фичи не должна красить DOM. */
  isActive(): boolean;
  /** Цвета ников изменились. */
  onColorsChanged(): void;
  /** Появилась/пропала заметка — точки на кнопках. */
  onIndicatorsChanged(): void;
  /** Изменилась палитра меток. */
  onTagsChanged(): void;
  /** Содержимое тултипов устарело. */
  onTooltipsChanged(): void;
  /** Тултипы КОНКРЕТНОГО игрока (после миграции ключа). */
  onPlayerTooltips(username: string): void;
  /** Сказать пользователю. */
  toast(message: string, warn?: boolean): void;
  /** id игрока по нику — для резолва ключей (статистика + профиль). */
  lookupId(lowerNick: string): number | string | undefined;
}

/**
 * Прочитать запись ТОЛЬКО как собственное свойство карты.
 *
 * `map[key]` уходит по цепочке прототипов: у ключей `__proto__`,
 * `constructor`, `prototype` он отдаёт объекты Object.prototype, и путь
 * записи считал, что «запись уже есть» — присваивал ей поля и отвечал
 * «сохранено», хотя на диск не уходило ничего (adversarial 28.08.2026,
 * найдено собственным тестом). Тот же приём, что в санитайзере настроек
 * панелей: доверять только Object.hasOwn.
 */
function ownRecord(map: NotesMap, key: string): NoteRecord | string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export class NotesModel {
  /** Карта заметок этой вкладки. Владелец — этот класс. */
  private map: NotesMap = {};
  /**
   * Пользовательские цвета меток (палитра). Хранятся в storage.LOCAL рядом с
   * заметками; копия в sync осталась только мостом старых версий (комментарий
   * про sync врал с переезда 8.1.22 — внешний аудит 28.08.2026).
   */
  private tags: string[] = [];
  /**
   * Карта заметок прочиталась. Не прочиталась — запись заблокирована, чтобы
   * пустая память не стёрла данные.
   */
  private notesHydrated = true;
  /**
   * Палитра прочиталась. Флаг ИНФОРМАЦИОННЫЙ и запись НЕ блокирует.
   *
   * 28.08.2026 он ненадолго стал гейтом — и оказался чистой потерей функции:
   * оба писателя палитры (координатор и фолбэк) читают свежее состояние с
   * диска сами и снимок памяти не пишут никогда, а вот пользователь после
   * сбоя чтения не мог выбрать цвет до перезагрузки страницы. Блокировать
   * имеет смысл только карту заметок: её операции собираются ИЗ ПАМЯТИ.
   */
  private tagsHydrated = true;
  /** Резолв «ник → ключ записи»: владелец карты владеет и её индексом. */
  readonly keys: NoteKeys;

  /**
   * Все записи карты — строго по очереди. Миграция (автоматический писатель
   * с hover'а) и сохранение из модалки иначе могли переплестись: миграция
   * читала диск, модалка писала заметку другого игрока, миграция записывала
   * свою карту БЕЗ неё. Кросс-вкладочная гонка остаётся (§6 п.19),
   * внутривкладочная — устранена.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: NotesModelContext) {
    this.keys = new NoteKeys({ notes: () => this.map, lookupId: (l) => this.ctx.lookupId(l) });
  }

  /** Карта заметок для чтения. Менять — только методами этого класса. */
  get notes(): NotesMap {
    return this.map;
  }

  get customTags(): string[] {
    return this.tags;
  }

  /** Запись КАРТЫ ЗАМЕТОК заблокирована. */
  get isReadOnly(): boolean {
    return !this.notesHydrated;
  }

  /** Запись ПАЛИТРЫ заблокирована. */
  get isPaletteReadOnly(): boolean {
    return !this.tagsHydrated;
  }

  /**
   * Заметки пришли из другой вкладки (storage.onChanged). Валидная карта из
   * другого контекста — безопасная точка восстановления после сбоя чтения:
   * блок записей снимаем.
   */
  adoptExternalNotes(next: unknown): void {
    // Форма из чужого контекста не гарантирована — принимаем только объект.
    this.map = next && typeof next === "object" && !Array.isArray(next) ? (next as NotesMap) : {};
    // Валидная карта из другого контекста снимает блок ЗАМЕТОК. Палитру она
    // не доказывает — её флаг снимает только приход палитры.
    this.notesHydrated = true;
    this.keys.reset();
  }

  /** Палитра пришла из другой вкладки. */
  adoptExternalTags(next: unknown): void {
    // Просеиваем поэлементно: значение цвета уезжает в style.cssText, а
    // прийти оно может из чужого контекста или со старой версии.
    if (!Array.isArray(next)) return;
    this.tags = next.filter(isSafeTag);
    this.tagsHydrated = true;
    // Палитра соседней вкладки обязана доехать до экрана: раньше значение
    // принималось молча, и удалённый цвет жил в открытом окне до F5.
    this.ctx.onTagsChanged();
  }

  /**
   * Добавить свой цвет в палитру (выбор в модалке). Память обновляется сразу
   * — человек видит цвет мгновенно, — а диском занимается координатор.
   * Возвращает результат записи: молчаливый провал оставлял цвет только в
   * памяти, и после перезагрузки он исчезал.
   */
  addCustomTag(css: string): Promise<boolean> {
    return this.commitTagOps([css], []);
  }

  /** Сколько записей пользуются этим цветом — для честного вопроса об удалении. */
  countTagUsages(css: string): number {
    return Object.values(this.map).filter(
      (rec) => typeof rec !== "string" && (rec.nickColor === css || rec.tag === css),
    ).length;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async load(): Promise<void> {
    const { notes, customTags, loadFailed } = await loadNotesFromStore();
    this.map = notes;
    this.tags = customTags;
    this.notesHydrated = loadFailed !== true;
    this.tagsHydrated = loadFailed !== true;
    if (!this.notesHydrated) {
      log.warn("player-notes", "заметки не прочитались — запись заблокирована");
      // Сказать СРАЗУ, а не когда человек нажмёт «Сохранить» и получит отказ:
      // до этого момента он видит пустые заметки и думает, что они пропали
      // (аудит наблюдаемости 02.08.2026, раздел «Ответ пользователю»).
      showToast(
        "Заметки не загрузились — данные НЕ удалены, но сохранение временно заблокировано",
        { key: "notes-read-only", kind: "warn", durationMs: 8000 },
      );
    }
    log.debug("player-notes", "notes loaded", Object.keys(this.map).length);
  }

  /**
   * Правка палитры — ИНТЕНТОМ через координатор в background.
   *
   * Раньше здесь был read-modify-write: читаем свежий список, доливаем свои
   * цвета, пишем массив целиком. Окно гонки маленькое, но не нулевое — две
   * вкладки, добавившие разные цвета одновременно, читали один диск, и
   * вторая затирала первый (внешний аудит 28.08.2026). Заметки этот класс
   * прошли ещё 26.08; палитра жила рядом с ними на более слабой модели
   * согласованности.
   *
   * Fail-safe, как у заметок: если свежее состояние не прочиталось —
   * НЕ ПИШЕМ. Потерять одно действие пользователя неприятно, перетереть
   * чужие сохранённые цвета хуже.
   */
  private async commitTagOps(add: string[], remove: string[]): Promise<boolean> {
    if (add.length === 0 && remove.length === 0) return true;
    // Снимок памяти ДО оптимистичной правки: при отказе записи палитра
    // обязана вернуться к состоянию диска — ровно как карта заметок. Без
    // этого человек видел цвет весь вечер, а после F5 тот исчезал
    // (adversarial 28.08.2026).
    // Снимок берётся ДО оптимистичной правки — и правку делаем здесь же.
    // Раньше её делал вызывающий, и снимок уже содержал новый цвет: откат
    // возвращал ровно то, что откатывал (поймано собственным тестом).
    const before = [...this.tags];
    const removeSet = new Set(remove);
    this.tags = [...new Set([...this.tags.filter((t) => !removeSet.has(t)), ...add])];
    this.ctx.onTagsChanged();
    const rollback = (): false => {
      this.tags = before;
      this.ctx.onTagsChanged();
      return false;
    };
    try {
      const res = await sendRuntime<NotesTagsResultMsg>({ type: "notes_tag_ops", add, remove });
      if (res && typeof res.ok === "boolean") {
        if (!res.ok) {
          log.warn("player-notes", "палитра не сохранена:", res.reason ?? "отказ координатора");
          return rollback();
        }
        // Координатор вернул свежий список — принимаем целиком: в нём уже
        // есть и цвета соседних вкладок. Элементы всё равно просеиваем:
        // ответ приходит из другого контекста.
        if (Array.isArray(res.tags)) {
          this.tags = res.tags.filter(isSafeTag);
          this.ctx.onTagsChanged();
        } else {
          // Контракт требует свежий список при успехе. Его отсутствие значит
          // ответ чужой/старой версии: записать могли неполно, и молчать об
          // этом нельзя (та же доктрина, что у карты заметок).
          log.warn("player-notes", "палитра: успех без списка — полнота не подтверждена");
        }
        if (typeof res.dropped === "number" && res.dropped > 0) {
          this.ctx.toast(`Палитра переполнена: ${res.dropped} цвет(ов) не сохранено`, true);
        }
        return true;
      }
    } catch (e) {
      log.debug("player-notes", "tag coordinator unavailable", e);
    }
    // Фолбэк: фон не ответил (осиротевшая вкладка после обновления
    // расширения). Читаем свежий список сами — и, в отличие от прежнего
    // поведения, при НЕУДАЧЕ чтения не пишем ничего.
    try {
      const cur = (await browser.storage.local.get({ [TAGS_KEY]: [] })) as Record<string, unknown>;
      const disk = Array.isArray(cur[TAGS_KEY]) ? (cur[TAGS_KEY] as string[]) : [];
      const removeSet = new Set(remove);
      // Санитайзер и потолок — те же, что у координатора: фолбэк не имеет
      // права быть чёрным ходом мимо проверок.
      const safeAdd = add.filter(isSafeTag);
      if (safeAdd.length === 0 && remove.length === 0) return rollback();
      const keptDisk = disk.filter((t) => isSafeTag(t) && !removeSet.has(t));
      const merged = [...new Set([...keptDisk, ...safeAdd])];
      const next = merged.slice(0, MAX_CUSTOM_TAGS);
      const ok = await saveCustomTagsToStore(next);
      if (!ok) return rollback();
      this.tags = next;
      this.ctx.onTagsChanged();
      // Потери — вслух, ТОЙ ЖЕ арифметикой, что у координатора (SEAM-06 +
      // adversarial 29.08.2026, F3: формулы разошлись — одно действие
      // тостилось по-разному в штатном пути и в фолбэке). Координатор:
      // dropped = переполнение + вычищенные с диска небезопасные легаси;
      // небезопасные элементы из add в счёт не входят там и не входят здесь.
      const purged = disk.filter((t) => !removeSet.has(t) && !isSafeTag(t)).length;
      const dropped = merged.length - next.length + purged;
      if (dropped > 0) {
        this.ctx.toast(`Палитра переполнена: ${dropped} цвет(ов) не сохранено`, true);
      }
      return true;
    } catch (e) {
      log.warn("player-notes", "палитра: свежее состояние не прочиталось — запись отменена", e);
      return rollback();
    }
  }



  /**
   * Сохранить ЗАТРОНУТЫЕ ключи через координатор в background.
   *
   * Вызывающий уже мутировал this.notes (мгновенный UI) и передаёт список
   * ключей, которые он менял. Раньше сюда уходила ВСЯ карта, и вторая
   * вкладка, писавшая другого игрока в те же секунды, затирала правку
   * (аудит lifecycle 01.08.2026, находка 2 — КРИТИЧНО). Теперь запись
   * выполняет background: одна очередь на браузер, свежая карта читается
   * непосредственно перед применением.
   *
   * Возвращает false, если запись не удалась — интерфейс обязан это показать.
   */
  async saveNotes(touchedKeys: string[]): Promise<boolean> {
    if (!this.notesHydrated) return false;
    const ops: NoteOp[] = touchedKeys.map((key) => ({
      key,
      // ownRecord, а не map[key]: у игрока с ником вроде «toString» индекс
      // уходит по цепочке прототипов и отдаёт функцию — удаление переставало
      // быть удалением, запись «возвращалась», а пользователь получал разом
      // «Сохранено ✓» и «сохранена не полностью» (adversarial 28.08.2026).
      record: (ownRecord(this.map, key) as unknown) ?? null,
    }));
    return await this.commitOps(ops);
  }

  /**
   * Отправка операций координатору с честным фолбэком.
   *
   * fallbackMap обязателен там, где результат собран НЕ в this.map, а в
   * отдельной карте (ленивая миграция читает свежую карту с диска): без него
   * фолбэк записал бы устаревший снимок памяти — то есть ровно ту потерю
   * чужих правок, от которой защищались (ревью пакета B, находка 1).
   */
  async commitOps(ops: NoteOp[], fallbackMap?: NotesMap): Promise<boolean> {
    if (!ops.length) return true;
    try {
      const res = await sendRuntime<NotesResultMsg>({ type: "notes_apply_ops", ops });
      if (res && typeof res.ok === "boolean") {
        // Координатор возвращает свежую карту — подхватываем её целиком,
        // чтобы память вкладки сразу видела и чужие правки.
        if (res.ok && res.notes) this.map = res.notes as NotesMap;
        // «Записалось» и «записалось ЦЕЛИКОМ» — разные утверждения: галочка
        // «Сохранено ✓» поверх обрезанного текста и была молчаливой потерей
        // (ревью 27.08.2026).
        if (res.ok && (typeof res.truncated !== "number" || typeof res.skipped !== "number")) {
          // Контракт требует счётчики при успехе. Их отсутствие означает
          // ответ чужой/старой версии — записать могли неполно, и молчать
          // об этом нельзя (ревью 27.08.2026).
          log.warn("player-notes", "координатор ответил успехом без счётчиков — полнота не подтверждена");
        }
        // Только при УСПЕХЕ: при отказе записи «сохранена не полностью»
        // врало бы в другую сторону — будто часть текста уцелела
        // (adversarial 27.08.2026).
        if (res.ok) this.warnOnLossyWrite(res);
        return res.ok;
      }
    } catch (e) {
      log.debug("player-notes", "notes coordinator unavailable", e);
    }
    // Фолбэк: background не ответил (старая вкладка после обновления
    // расширения, воркер недоступен). Пишем как раньше — не хуже прежнего
    // поведения, зато правка пользователя не теряется молча.
    log.warn("player-notes", "координатор недоступен — пишем карту напрямую");
    // База для записи — СВЕЖИЙ диск, а не снимок памяти. Палитра этот класс
    // уже прошла, заметки оставались асимметрией: две вкладки в фолбэке
    // затирали правки друг друга снимками (внешний аудит 28.08.2026).
    // Если свежее состояние не читается — НЕ ПИШЕМ вовсе: перетереть чужое
    // хуже, чем потерять одно действие.
    let base = fallbackMap;
    if (!base) {
      const fresh = await loadNotesFromStore();
      if (fresh.loadFailed) {
        log.warn("player-notes", "фолбэк отменён: свежая карта не прочиталась");
        return false;
      }
      if (fresh.migrated === false) {
        // Перед нами ОБЪЕДИНЁННЫЙ ВИД (local + sync-мост), а не факт с диска.
        // Записать его отсюда — значит выполнить миграцию из вкладки, мимо
        // единственного писателя, и вдобавок без флага завершения: следующий
        // запуск мигрировал бы снова поверх (SEC26-5, внешний аудит
        // 28.08.2026). Пусть правка потеряется — она одна, а миграция
        // одноразовая и необратимая.
        log.warn("player-notes", "фолбэк отменён: хранилище ещё не мигрировано");
        return false;
      }
      // Форма с диска не гарантирована: под ключом может лежать что угодно.
      // Без проверки присваивание в примитив бросало TypeError МИМО отката —
      // заметка оставалась на экране и не попадала на диск.
      base =
        fresh.notes && typeof fresh.notes === "object" && !Array.isArray(fresh.notes)
          ? fresh.notes
          : {};
      // Свою правку доносим поверх свежей карты — иначе фолбэк запишет диск
      // без того, ради чего вызывался. Проверки ключа — ТЕ ЖЕ, что у
      // координатора: удаление по мягкому правилу, запись по строгому
      // (adversarial 28.08.2026: фолбэк не имел ни одной).
      for (const op of ops) {
        if (op.record === null) {
          if (op.key !== "__proto__") delete base[op.key];
          continue;
        }
        if (!isSafeNoteKey(op.key)) continue;
        base[op.key] = op.record as NoteRecord;
      }
    }
    const raw = base;
    // Нормализуем ТОЛЬКО затронутые записи (ревью 27.08.2026): полная
    // нормализация карты резала ЧУЖУЮ давнюю длинную заметку при сохранении
    // совсем другой — правка одного игрока портила данные другого.
    const { map, truncated, skipped } = normalizeTouched(
      raw,
      ops.map((o) => o.key),
    );
    const ok = await saveNotesToStore(map);
    if (ok) {
      this.map = map;
      this.warnOnLossyWrite({ truncated, skipped });
    }
    return ok;
  }

  /** Сказать вслух, если запись прошла НЕ целиком (обрезка/выброс). */
  private warnOnLossyWrite(res: { truncated?: number; skipped?: number }): void {
    const cut = res.truncated ?? 0;
    const lost = res.skipped ?? 0;
    if (cut === 0 && lost === 0) return;
    const parts = [
      cut > 0 ? `обрезано по длине: ${cut}` : "",
      lost > 0 ? `не сохранено записей: ${lost}` : "",
    ].filter(Boolean);
    log.warn("player-notes", "запись заметок прошла не целиком —", parts.join(", "));
    showToast(`Заметка сохранена не полностью (${parts.join(", ")})`);
  }

  /**
   * Ленивая миграция ник → id: вызывается, когда статистика резолвила userId.
   * «Vasya» и «vasya» сливаются в одну запись (побеждает более свежая),
   * ник сохраняется внутри записи для экспорта и отображения.
   */
  migrateToId(username: string, userId: number | string): Promise<void> {
    if (this.keys.nickKeys(username).length === 0) return Promise.resolve();
    return this.enqueue(() => this.doMigrateToId(username, userId));
  }

  private async doMigrateToId(username: string, userId: number | string): Promise<void> {
    const key = idKey(userId);

    // Миграция — АВТОМАТИЧЕСКИЙ писатель всей карты (срабатывает без действий
    // пользователя). Работаем со СВЕЖЕЙ картой с диска, а не со снапшотом
    // памяти: иначе вкладка со старой памятью затирала бы заметку, только что
    // сохранённую в другой вкладке (окно RMW сжимается с «минут» до мс).
    const { notes: fresh, loadFailed } = await loadNotesFromStore();
    if (loadFailed || !this.ctx.isActive()) return;

    const lower = username.toLowerCase();
    const freshNickKeys = Object.keys(fresh).filter(
      (k) => !isIdKey(k) && k.toLowerCase() === lower,
    );
    if (freshNickKeys.length === 0) return;

    const ts = (n: NoteRecord | string | undefined) =>
      n && typeof n !== "string" && typeof n.timestamp === "number" ? n.timestamp : 0;
    const toRecord = (n: NoteRecord | string): NoteRecord =>
      typeof n === "string" ? { text: n, timestamp: 0 } : n;

    // toRecord, а не typeof-проверка: строковая (легаси) запись под u:-ключом
    // игнорировалась, ник-запись побеждала «по умолчанию» и затирала её текст
    // без участия пользователя. Такие записи есть у реальных пользователей —
    // прежние версии миграции клали строку под id-ключ (аудит безопасности
    // 01.08.2026, находка 12; поймано ревью применения).
    let best: NoteRecord | undefined =
      fresh[key] !== undefined ? toRecord(fresh[key]) : undefined;
    // Текст легаси-СТРОКИ под id-ключом: у неё ts=0, поэтому любая ник-запись
    // с настоящим временем побеждает её по времени. Такой текст нельзя терять
    // молча — ниже он дописывается в победителя наравне с ничьёй.
    const idLegacyText = typeof fresh[key] === "string" ? (fresh[key] as string) : "";
    const losers: NoteRecord[] = [];
    for (const nk of freshNickKeys) {
      const record = toRecord(fresh[nk]);
      if (!best) {
        best = record;
      } else if (ts(record) > ts(best)) {
        losers.push(best);
        best = record;
      } else {
        losers.push(record);
      }
    }
    if (!best) return;

    // Ничья по времени (обе легаси, ts=0) с РАЗНЫМ текстом — не уничтожаем
    // проигравший текст молча, а дописываем его в запись.
    const winner: NoteRecord = { ...best };
    for (const loser of losers) {
      if (
        loser.text &&
        loser.text !== winner.text &&
        (ts(loser) === ts(winner) || loser.text === idLegacyText)
      ) {
        winner.text = winner.text ? `${winner.text}\n[слито: ${loser.text}]` : loser.text;
      }
      // Цвет и метка наследуются БЕЗУСЛОВНО (непустое побеждает пустое):
      // свежая запись без цвета почти всегда означает «заметку сохранили,
      // пока цвет жил в другой записи этого же игрока», а не «цвет сняли».
      // Раньше слияние молча теряло цвет навсегда (жалоба 31.07.2026:
      // «~50 из 200 раскрашенных ников стали белыми»).
      if (!winner.tag && loser.tag) winner.tag = loser.tag;
      if (!winner.nickColor && loser.nickColor) winner.nickColor = loser.nickColor;
    }

    fresh[key] = { ...winner, ...withNickHistory(winner, username) };
    for (const nk of freshNickKeys) delete fresh[nk];

    const migrationOps: NoteOp[] = [
      { key, record: fresh[key] as unknown },
      ...freshNickKeys.map((nk) => ({ key: nk, record: null })),
    ];
    // fresh как карта фолбэка: она собрана из СВЕЖЕГО чтения диска, в
    // отличие от this.notes. Память обновит сам commitNoteOps — картой от
    // координатора или fresh (при фолбэке).
    if (await this.commitOps(migrationOps, fresh)) {
      log.debug("player-notes", "note migrated to id key", username, key);
      this.ctx.onIndicatorsChanged();
      this.ctx.onTagsChanged();
      this.ctx.onPlayerTooltips(username);
    }
    // При неудаче записи память не трогаем вовсе — this.notes как была.
  }

  /**
   * Записать цвет ника в запись заметки (или снять его). Пустой цвет у записи
   * без текста и метки удаляет запись целиком — не копим пустышки.
   *
   * @param createNick передан — записи можно НЕ существовать: она создаётся
   *   пустой с этим ником (ручное добавление игрока в менеджере).
   */
  setNickColor(key: string, color: string, createNick?: string): Promise<boolean> {
    return this.enqueue(async (): Promise<boolean> => {
      const prev = ownRecord(this.map, key);
      if (prev === undefined) {
        // Без createNick несуществующий ключ — гонка с удалением в другой
        // вкладке: молча выходим, воскрешать запись нельзя.
        if (!color || createNick === undefined) return true;
        if (!isSafeNoteKey(key)) return false;
        this.map[key] = {
          text: "",
          timestamp: Date.now(),
          version: VERSION,
          nickColor: color,
          // Ник храним только у id-ключей (у ник-ключей он и есть ключ).
          ...(isIdKey(key) ? withNickHistory(this.map[key], createNick) : {}),
        };
      } else if (typeof prev === "string") {
        // Легаси-строка: повышаем до записи, текст сохраняем.
        if (!color) return true;
        this.map[key] = { text: prev, timestamp: Date.now(), version: VERSION, nickColor: color };
      } else {
        const next: NoteRecord = { ...prev, timestamp: Date.now(), nickColor: color || undefined };
        if (!color && !next.text && !next.tag) delete this.map[key];
        else this.map[key] = next;
      }
      if (!(await this.saveNotes([key]))) {
        // Откат памяти под состояние диска.
        if (prev === undefined) delete this.map[key];
        else this.map[key] = prev;
        return false;
      }
      this.ctx.onColorsChanged();
      this.ctx.onIndicatorsChanged();
      return true;
    });
  }

  /** Убрать свой цвет из палитры (сама палитра — это customTags). */
  removeCustomTag(css: string): void {
    void this.commitTagOps([], [css]).then((ok) => {
      if (!ok) this.ctx.toast("Не удалось сохранить палитру — цвет вернётся после перезагрузки", true);
    });
  }

  /**
   * Записать текст заметки по ключу (правка из менеджера). Пустой текст у
   * записи без цвета и метки удаляет её целиком — не копим пустышки.
   */
  setNoteText(key: string, text: string, createNick?: string): Promise<boolean> {
    return this.enqueue(async (): Promise<boolean> => {
      const prev = ownRecord(this.map, key);
      if (prev === undefined) {
        // Записи нет: создаём только при явном намерении (добавление игрока
        // через форму). Иначе это гонка с удалением в другой вкладке —
        // воскрешать запись нельзя.
        if (!text || createNick === undefined) return true;
        if (!isSafeNoteKey(key)) return false;
        this.map[key] = {
          text,
          timestamp: Date.now(),
          version: VERSION,
          ...(isIdKey(key) ? { nick: createNick } : {}),
        };
        if (!(await this.saveNotes([key]))) {
          delete this.map[key];
          return false;
        }
        this.ctx.onIndicatorsChanged();
        this.ctx.onTooltipsChanged();
        return true;
      }
      const base: NoteRecord =
        typeof prev === "string" ? { text: prev, timestamp: Date.now(), version: VERSION } : prev;
      const next: NoteRecord = { ...base, text, timestamp: Date.now(), version: VERSION };
      if (!text && !next.tag && !next.nickColor) delete this.map[key];
      else this.map[key] = next;

      if (!(await this.saveNotes([key]))) {
        this.map[key] = prev; // откат памяти под состояние диска
        return false;
      }
      this.ctx.onIndicatorsChanged();
      this.ctx.onTooltipsChanged();
      return true;
    });
  }

  /** Удалить запись игрока целиком (и заметку, и цвет, и метку). */
  deleteEntry(key: string): Promise<boolean> {
    return this.enqueue(async (): Promise<boolean> => {
      const prev = ownRecord(this.map, key);
      if (prev === undefined) return true;
      delete this.map[key];
      if (!(await this.saveNotes([key]))) {
        this.map[key] = prev;
        return false;
      }
      this.ctx.onColorsChanged();
      this.ctx.onIndicatorsChanged();
      this.ctx.onTagsChanged();
      this.ctx.onTooltipsChanged();
      return true;
    });
  }

  /**
   * Все известные игроки: и с цветом ника, и просто с заметкой.
   * Раньше список показывал ТОЛЬКО цветных — заметки правились лишь на
   * плитке в игре, то есть до нужного игрока надо было ещё дожить.
   */
  playerEntries(): Array<{
    key: string;
    nick: string;
    id: string;
    color: string;
    text: string;
  }> {
    return Object.entries(this.map)
      .filter(([, rec]) => (typeof rec === "string" ? !!rec : !!(rec.nickColor || rec.text)))
      .map(([key, rec]) => ({
        key,
        nick:
          (typeof rec !== "string" && rec.nick) ||
          (isIdKey(key) ? `игрок ${key.slice(ID_KEY_PREFIX.length)}` : key),
        id: isIdKey(key) ? key.slice(ID_KEY_PREFIX.length) : "",
        color: typeof rec === "string" ? "" : rec.nickColor || "",
        text: typeof rec === "string" ? rec : rec.text || "",
      }))
      .sort((a, b) => a.nick.localeCompare(b.nick, "ru"));
  }
}
