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

export function isSafeTag(tag: unknown): tag is string {
  // typeof-гард ПЕРВЫМ: RegExp приводит аргумент к строке, поэтому число 123 и
  // массив ["red"] проходили проверку и сохранялись в карту как есть — потом
  // потребители падали на rec.nickColor.includes(...) (аудит безопасности
  // 01.08.2026, находка 4).
  if (typeof tag !== "string") return false;
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
/** Максимумы для записи из ЧУЖОГО файла (присланный «бэкап» — недоверенный ввод). */
export const MAX_NOTE_TEXT = 5000;
export const MAX_NOTE_KEY = 200;
export const MAX_IMPORT_ENTRIES = 20_000;

/**
 * Собрать чистый NoteRecord из произвольного значения. Берём ТОЛЬКО известные
 * поля известных типов — раньше запись из файла сохранялась сырым объектом
 * (`safe = note`), и `nick: 123` / `tag: ["red"]` доезжали до storage, а потом
 * ломали проходы заметок TypeError'ом (аудит безопасности 01.08.2026, №4/№12).
 * Возвращает null, если из значения не получается осмысленной заметки.
 */
export function normalizeNoteRecord(raw: unknown): NoteRecord | null {
  if (typeof raw === "string") {
    // Легаси-формат: заметка была просто строкой.
    return { text: raw.slice(0, MAX_NOTE_TEXT), timestamp: 0 };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string") return null;

  const rec: NoteRecord = {
    text: r.text.slice(0, MAX_NOTE_TEXT),
    // Время из чужого файла ограничиваем «сейчас»: timestamp вида
    // Number.MAX_SAFE_INTEGER делал присланную запись вечным победителем
    // слияния и затирал настоящие заметки (№5).
    timestamp:
      typeof r.timestamp === "number" && Number.isFinite(r.timestamp) && r.timestamp > 0
        ? Math.min(r.timestamp, Date.now())
        : 0,
  };
  if (typeof r.version === "string" && r.version.length <= 20) rec.version = r.version;
  if (isSafeTag(r.tag)) rec.tag = r.tag;
  if (isSafeTag(r.nickColor)) rec.nickColor = r.nickColor;
  if (typeof r.nick === "string" && r.nick) rec.nick = r.nick.slice(0, MAX_NOTE_KEY);
  return rec;
}

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
  const indexNick = (k: string, v: NoteRecord | string | undefined) => {
    if (isIdKey(k) && v && typeof v !== "string" && v.nick) {
      idKeyByNick.set(v.nick.toLowerCase(), k);
    }
  };
  for (const [k, v] of Object.entries(base)) indexNick(k, v);
  let added = 0;
  let replaced = 0;
  for (const [rawKey, note] of Object.entries(incoming)) {
    // Канонизация id-ключа: "u:0123" и "u:123" — один игрок, иначе присланный
    // файл плодил вторую невидимую запись (аудит безопасности, №12).
    const key = canonicalNoteKey(rawKey);
    if (!isSafeNoteKey(key) || key.length > MAX_NOTE_KEY) continue;
    // Запись пересобирается из разрешённых полей: сырой объект из чужого
    // файла в карту больше не попадает (№4).
    const safe = normalizeNoteRecord(note);
    if (!safe) continue;
    const targetKey = !isIdKey(key) ? (idKeyByNick.get(key.toLowerCase()) ?? key) : key;
    const existing = merged[targetKey];
    if (existing === undefined) {
      merged[targetKey] = safe;
      added++;
    } else if (noteTimestamp(safe) > noteTimestamp(existing)) {
      // Слив в id-ключ сохраняет nick-поле существующей записи. Цвет и метка
      // наследуются по правилу «непустое побеждает пустое»: более свежая
      // запись без цвета — это обычно заметка, сохранённая, пока цвет жил в
      // другой записи игрока, а не намеренное снятие цвета. Раньше замена
      // молча теряла nickColor/tag существующей записи.
      const keep: Partial<NoteRecord> = {};
      if (typeof existing !== "string") {
        if (existing.nick) keep.nick = existing.nick;
        if (!safe.tag && existing.tag) keep.tag = existing.tag;
        if (!safe.nickColor && existing.nickColor) keep.nickColor = existing.nickColor;
      }
      merged[targetKey] = { ...safe, ...keep };
      replaced++;
    }
    // Новая id-запись с ником должна попасть в индекс: иначе ник-ключ того же
    // игрока, идущий дальше по файлу, создавал бы дубль (№12).
    indexNick(targetKey, merged[targetKey]);
  }
  return { merged, added, replaced };
}

/** Канонический вид ключа: у id-ключей убираем ведущие нули. */
export function canonicalNoteKey(key: string): string {
  if (!isIdKey(key)) return key;
  const id = key.slice(ID_KEY_PREFIX.length);
  if (!/^\d+$/.test(id)) return key;
  const norm = id.replace(/^0+(?=\d)/, "");
  return `${ID_KEY_PREFIX}${norm}`;
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
    // Палитра: ОБЪЕДИНЯЕМ local и sync как упорядоченное множество. Раньше
    // любой local-цвет полностью подавлял sync-цвета, а при пустых заметках
    // ветка «переносить нечего» вообще не доходила до палитры — цвета из
    // облака терялись молча (аудит безопасности 01.08.2026, №3).
    const syncTags = Array.isArray(sync[TAGS_KEY])
      ? (sync[TAGS_KEY] as unknown[]).filter(isSafeTag)
      : [];
    const customTags = [...new Set([...localTags, ...syncTags])];
    const tagsChanged = customTags.length !== localTags.length;

    if (!Object.keys(fromSync).length && !Object.keys(fromLegacy).length) {
      // Заметок в sync нет, но палитра могла быть — пишем её вместе с флагом.
      await browser.storage.local.set({
        [MIGRATED_KEY]: true,
        ...(tagsChanged ? { [TAGS_KEY]: customTags } : {}),
      });
      return { notes: localNotes, customTags };
    }

    const merged = mergeNotes(mergeNotes(localNotes, fromLegacy).merged, fromSync).merged;

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
