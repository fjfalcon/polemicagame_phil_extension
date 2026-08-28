/**
 * Резолв ключа заметки: «ник за столом» → «запись в хранилище».
 *
 * Вынесено из player-notes.ts (арх-ревью 28.08.2026). Это самый опасный слой
 * фичи: ошибка здесь показывает игроку ЧУЖУЮ заметку — ровно так и случился
 * блокер 8.1.29, когда плейсхолдер «—» из недоступной статистики уводил
 * заметки всех непрочитанных игроков в общий ключ `u:—`. Пока слой жил
 * посреди четырёх тысяч строк, проверить его можно было только через DOM
 * целого стола; здесь он проверяется напрямую.
 *
 * Состояние — только кэш ник-индекса. Записи и резолв id приходят снаружи:
 * модуль не знает ни про настройки, ни про DOM, ни про сеть.
 */
import { idKey, isIdKey, type NoteRecord, type NotesMap } from "@core/notes-store";

export interface NoteKeyContext {
  /** Актуальная карта заметок (менеджер владеет ею и меняет её). */
  notes(): NotesMap;
  /** Известный id игрока по lowercase-нику: статистика или страница профиля. */
  lookupId(lowerNick: string): number | string | undefined;
}

/**
 * Кэш «lowercase-ник → id-ключ записи»: TTL, а не инвалидация по каждому из
 * десятка мест мутации карты заметок — секунда устаревания не видна глазу, а
 * пропущенная инвалидация была бы вечным багом.
 */
const NICK_INDEX_TTL_MS = 1000;

export class NoteKeys {
  private nickIndexCache: { at: number; map: Map<string, string> } | null = null;

  constructor(private readonly ctx: NoteKeyContext) {}

  /** Сбросить кэш ник-индекса (смена стола, импорт, тесты). */
  reset(): void {
    this.nickIndexCache = null;
  }

  /**
   * Числовой id игрока, если он известен и годен для ключа.
   *
   * БЕЛЫЙ список вместо чёрного: принимаем только положительное целое.
   * Чёрный список («???», "") пропустил бы плейсхолдеры заглушек — так «—»
   * из недоступной статистики чуть не отправил заметки ВСЕХ недоступных
   * игроков в один общий ключ `u:—` (чужая заметка в тултипе соседа +
   * взаимная перезапись). Блокер ревью 8.1.29.
   */
  userId(username: string): number | string | undefined {
    const id = this.ctx.lookupId(username.toLowerCase());
    if (typeof id === "number") return Number.isInteger(id) && id > 0 ? id : undefined;
    if (typeof id === "string" && /^\d+$/.test(id) && id !== "0") return id;
    return undefined;
  }

  /**
   * Ключ заметки игрока: `u:<id>`, если id известен, иначе ник (легаси).
   * Заметки по id переживают смену ника и не путают тёзок.
   */
  keyFor(username: string): string {
    const notes = this.ctx.notes();
    const id = this.userId(username);
    if (id !== undefined) {
      const key = idKey(id);
      // Для ЧТЕНИЯ id-ключ приоритетен, но если записи под ним ещё нет, а под
      // ником есть — читаем ник (миграция могла не успеть).
      if (Object.hasOwn(notes, key) || !Object.hasOwn(notes, username)) return key;
      return username;
    }
    if (Object.hasOwn(notes, username)) return username;
    // id не резолвлен (статистика ещё грузится или профиль скрыт), записи под
    // ником нет — ищем id-запись по её полю nick. Без этого игроки,
    // раскрашенные через менеджер (запись сразу на id-ключе), стояли белыми
    // до резолва id, а со скрытым профилем — вечно.
    // Компромисс: rec.nick — исторический; если ник освободили и занял другой
    // игрок, до резолва id совпадение отдаст чужую запись (та же слабая
    // идентичность, что у легаси-ник-ключей; резолв id её вытесняет).
    return this.idKeyByNick().get(username.toLowerCase()) ?? username;
  }

  get(username: string): NoteRecord | string | undefined {
    // Только СОБСТВЕННОЕ свойство: ник вида «constructor» иначе прочитал бы
    // объект с прототипа и притворился заметкой (adversarial 28.08.2026).
    const notes = this.ctx.notes();
    const key = this.keyFor(username);
    return Object.hasOwn(notes, key) ? notes[key] : undefined;
  }

  text(username: string): string {
    const note = this.get(username);
    if (!note) return "";
    return typeof note === "string" ? note : note.text || "";
  }

  /**
   * Прежние ники игрока. Есть только у записей с вечным ключом `u:<id>` — у
   * ник-ключа прошлого имени взяться неоткуда, ключ им и является.
   */
  formerNicks(username: string): string[] {
    const note = this.get(username);
    if (!note || typeof note === "string") return [];
    const current = username.toLowerCase();
    return (note.nicks ?? []).filter((n) => n.toLowerCase() !== current);
  }

  tag(username: string): string {
    const note = this.get(username);
    return note && typeof note !== "string" ? note.tag || "" : "";
  }

  /** Сохранённый цвет ника (без учёта настройки — для диалогов). */
  rawNickColor(username: string): string {
    const note = this.get(username);
    return note && typeof note !== "string" ? note.nickColor || "" : "";
  }

  /** Все легаси-ключи-ники этого игрока (точный + отличающиеся регистром). */
  nickKeys(username: string): string[] {
    const lower = username.toLowerCase();
    return Object.keys(this.ctx.notes()).filter((k) => !isIdKey(k) && k.toLowerCase() === lower);
  }

  private idKeyByNick(): Map<string, string> {
    const now = Date.now();
    if (this.nickIndexCache && now - this.nickIndexCache.at < NICK_INDEX_TTL_MS) {
      return this.nickIndexCache.map;
    }
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(this.ctx.notes())) {
      if (isIdKey(k) && v && typeof v !== "string" && v.nick) {
        map.set(v.nick.toLowerCase(), k);
      }
    }
    this.nickIndexCache = { at: now, map };
    return map;
  }
}
