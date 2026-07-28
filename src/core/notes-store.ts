/**
 * Хранилище заметок об игроках — единственная точка правды для content и popup.
 *
 * Раньше заметки лежали в storage.sync в ОДНОМ ключе `playerNotes`, а у sync
 * лимит 8 КБ на элемент. Примерно на 45-й заметке (или на 35-й, если пользоваться
 * цветными метками) запись начинала падать — молча и навсегда: catch писал в лог,
 * интерфейс продолжал показывать заметку из памяти, и она исчезала после F5.
 *
 * Теперь заметки живут в storage.local (10 МБ). Плата за это — нет облачной
 * синхронизации между устройствами; вместо неё экспорт/импорт файла в попапе.
 * Старые заметки из sync (включая ключ `notes` совсем древних версий)
 * переносятся один раз при первой загрузке и в sync больше не пишутся.
 */
import { browser } from "./env";
import { log } from "./log";

export type NoteRecord = {
  text: string;
  timestamp: number;
  version?: string;
  tag?: string;
  /** Цвет ника игрока на плитке (CSS-значение из палитры меток). */
  nickColor?: string;
  /** Последний известный ник — для экспорта/отображения записей с id-ключом. */
  nick?: string;
};
export type NotesMap = Record<string, NoteRecord | string>;

/**
 * Ключи заметок (8.1.29): предпочтительно `u:<userId>` сайта — id вечный,
 * ник меняется. Старые ключи-ники продолжают работать как фолбэк и лениво
 * мигрируют на id, когда статистика игрока резолвит его userId.
 */
export const ID_KEY_PREFIX = "u:";

export function idKey(userId: number | string): string {
  return `${ID_KEY_PREFIX}${userId}`;
}

export function isIdKey(key: string): boolean {
  return key.startsWith(ID_KEY_PREFIX);
}

export const NOTES_KEY = "playerNotes";
export const TAGS_KEY = "tagCustomColors";
export const NOTES_VERSION = "1.0";

/** Флаг «перенос из sync выполнен». Версионирован: следующий перенос — v2. */
const MIGRATED_KEY = "pn_notes_migrated_v1";
/** Ключ заметок в совсем старых версиях расширения. */
const LEGACY_KEY = "notes";

/**
 * Ник приходит из DOM сайта. `__proto__` в качестве ключа объектного литерала
 * подменяет прототип вместо создания свойства: заметка «есть» в интерфейсе,
 * но не попадает в JSON и молча теряется. Такие ники просто не берём.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeNoteKey(key: string): boolean {
  return key.length > 0 && !UNSAFE_KEYS.has(key);
}

/**
 * Метка подставляется в `style.cssText` как значение background. Из файла бэкапа,
 * присланного посторонним, туда могло приехать `red;position:fixed;inset:0` или
 * `url(https://…)` — то есть оверлей поверх игры или обращение к чужому хосту.
 * Пропускаем только то, из чего состоят настоящие цвета и градиенты.
 */
const SAFE_TAG_RE = /^[#a-zA-Z0-9(),.%\s-]+$/;

export function isSafeTag(tag: string): boolean {
  if (!tag || tag.length > 200) return false;
  if (!SAFE_TAG_RE.test(tag)) return false;
  return !/url\s*\(|expression|@import/i.test(tag);
}

/**
 * Индекс «кто какого цвета» для мест, где игроки приходят списком с id
 * (панель «Кто в очереди», сайтовый список «Участники»). byId — ключ
 * String(userId); byNick — lowercase-ник (и легаси-ключи, и rec.nick).
 */
export interface NickColorIndex {
  byId: Map<string, string>;
  byNick: Map<string, string>;
}

export function buildNickColorIndex(notes: NotesMap): NickColorIndex {
  const byId = new Map<string, string>();
  const byNick = new Map<string, string>();
  for (const [key, rec] of Object.entries(notes)) {
    if (!rec || typeof rec === "string" || !rec.nickColor) continue;
    // Записи со старых версий могли не проходить санитизацию — цвет уходит
    // в style-атрибут, поэтому фильтр обязателен и на чтении.
    if (!isSafeTag(rec.nickColor)) continue;
    if (isIdKey(key)) {
      byId.set(key.slice(ID_KEY_PREFIX.length), rec.nickColor);
      if (rec.nick) byNick.set(rec.nick.toLowerCase(), rec.nickColor);
    } else {
      byNick.set(key.toLowerCase(), rec.nickColor);
    }
  }
  return { byId, byNick };
}

/** Цвет игрока по id (приоритет) или нику; пустая строка — цвета нет. */
export function nickColorFrom(
  index: NickColorIndex,
  id?: number | string | null,
  nick?: string | null,
): string {
  if (id !== undefined && id !== null && id !== "") {
    const c = index.byId.get(String(id));
    if (c) return c;
  }
  if (nick) {
    const c = index.byNick.get(nick.toLowerCase());
    if (c) return c;
  }
  return "";
}

export function noteText(note: NoteRecord | string | undefined): string {
  if (!note) return "";
  return typeof note === "string" ? note : note.text || "";
}

function noteTimestamp(note: NoteRecord | string | undefined): number {
  if (!note || typeof note === "string") return 0;
  return typeof note.timestamp === "number" ? note.timestamp : 0;
}

/**
 * Слить две карты заметок. Побеждает более свежая запись.
 * `added` считает только те ключи, которых не было или которые реально обновились.
 */
export function mergeNotes(
  base: NotesMap,
  incoming: NotesMap,
): { merged: NotesMap; added: number; replaced: number } {
  const merged: NotesMap = { ...base };
  // Ник → существующий id-ключ: старый бэкап с ник-ключами не должен
  // создавать ДУБЛЬ рядом с уже мигрированной u:-записью того же игрока
  // (дубль был бы невидим при чтении id-first и «воскресал» бы после
  // удаления). Сливаем в id-ключ по обычному правилу timestamp.
  const idKeyByNick = new Map<string, string>();
  for (const [k, v] of Object.entries(base)) {
    if (isIdKey(k) && v && typeof v !== "string" && v.nick) {
      idKeyByNick.set(v.nick.toLowerCase(), k);
    }
  }
  let added = 0;
  let replaced = 0;
  for (const [key, note] of Object.entries(incoming)) {
    if (!isSafeNoteKey(key)) continue;
    if (!note || (typeof note !== "string" && typeof note.text !== "string")) continue;
    // Метка/цвет ника из чужого файла могут нести произвольный CSS —
    // вычищаем их, саму заметку при этом сохраняем.
    let safe = note;
    if (typeof safe !== "string" && safe.tag && !isSafeTag(safe.tag)) {
      log.warn("notes", "dropped unsafe tag on import", key);
      safe = { ...safe, tag: undefined };
    }
    if (typeof safe !== "string" && safe.nickColor && !isSafeTag(safe.nickColor)) {
      log.warn("notes", "dropped unsafe nickColor on import", key);
      safe = { ...safe, nickColor: undefined };
    }
    const targetKey = !isIdKey(key) ? (idKeyByNick.get(key.toLowerCase()) ?? key) : key;
    const existing = merged[targetKey];
    if (existing === undefined) {
      merged[targetKey] = safe;
      added++;
    } else if (noteTimestamp(safe) > noteTimestamp(existing)) {
      // Слив в id-ключ сохраняет nick-поле существующей записи.
      const nick =
        typeof existing !== "string" && existing.nick ? { nick: existing.nick } : {};
      merged[targetKey] = typeof safe === "string" ? safe : { ...safe, ...nick };
      replaced++;
    }
  }
  return { merged, added, replaced };
}

/** Разовый перенос заметок из storage.sync. Ошибка не выставляет флаг — повторим позже. */
async function migrateFromSync(
  localNotes: NotesMap,
  localTags: string[],
): Promise<{ notes: NotesMap; customTags: string[] }> {
  try {
    const sync = (await browser.storage.sync.get({
      [NOTES_KEY]: {},
      [LEGACY_KEY]: {},
      [TAGS_KEY]: [],
    })) as Record<string, unknown>;

    const fromSync = (sync[NOTES_KEY] as NotesMap) || {};
    const fromLegacy = (sync[LEGACY_KEY] as NotesMap) || {};
    if (!Object.keys(fromSync).length && !Object.keys(fromLegacy).length) {
      // Переносить нечего, но флаг ставим — чтобы не читать sync на каждой загрузке.
      await browser.storage.local.set({ [MIGRATED_KEY]: true });
      return { notes: localNotes, customTags: localTags };
    }

    const merged = mergeNotes(mergeNotes(localNotes, fromLegacy).merged, fromSync).merged;
    const syncTags = Array.isArray(sync[TAGS_KEY]) ? (sync[TAGS_KEY] as string[]) : [];
    const customTags = localTags.length ? localTags : syncTags;

    await browser.storage.local.set({
      [NOTES_KEY]: merged,
      [TAGS_KEY]: customTags,
      [MIGRATED_KEY]: true,
    });
    log.info("notes", "migrated from sync", {
      sync: Object.keys(fromSync).length,
      legacy: Object.keys(fromLegacy).length,
      total: Object.keys(merged).length,
    });
    // Копию в sync намеренно НЕ удаляем: она остаётся страховкой и позволит
    // перенести заметки на другом устройстве, где расширение ещё не обновилось.
    return { notes: merged, customTags };
  } catch (e) {
    log.error("notes", "migration failed", e);
    return { notes: localNotes, customTags: localTags };
  }
}

/** Прочитать заметки и палитру меток (с разовым переносом из sync). */
export async function loadNotes(): Promise<{
  notes: NotesMap;
  customTags: string[];
  /** true = чтение упало и notes ПУСТАЯ НЕ ПОТОМУ, что заметок нет. Писать поверх НЕЛЬЗЯ. */
  loadFailed?: boolean;
}> {
  try {
    const local = (await browser.storage.local.get({
      [NOTES_KEY]: {},
      [TAGS_KEY]: [],
      [MIGRATED_KEY]: false,
    })) as Record<string, unknown>;

    const notes = (local[NOTES_KEY] as NotesMap) || {};
    const customTags = Array.isArray(local[TAGS_KEY]) ? (local[TAGS_KEY] as string[]) : [];

    if (!local[MIGRATED_KEY]) return await migrateFromSync(notes, customTags);
    return { notes, customTags };
  } catch (e) {
    log.error("notes", "load failed", e);
    // loadFailed — обязательный гейт для писателей: запись «пустой» карты
    // поверх непрочитанного диска = потеря всех заметок.
    return { notes: {}, customTags: [], loadFailed: true };
  }
}

/** Записать заметки. Возвращает false при ошибке — вызывающий обязан сказать об этом пользователю. */
export async function saveNotes(notes: NotesMap): Promise<boolean> {
  try {
    await browser.storage.local.set({ [NOTES_KEY]: notes, version: NOTES_VERSION });
    return true;
  } catch (e) {
    log.error("notes", "save failed", e);
    return false;
  }
}

/** Записать пользовательскую палитру меток. */
export async function saveCustomTags(tags: string[]): Promise<boolean> {
  try {
    await browser.storage.local.set({ [TAGS_KEY]: tags });
    return true;
  } catch (e) {
    log.error("notes", "saveCustomTags failed", e);
    return false;
  }
}
