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
import { sendRuntime } from "./messaging";

export type NoteRecord = {
  text: string;
  timestamp: number;
  version?: string;
  tag?: string;
  /** Цвет ника игрока на плитке (CSS-значение из палитры меток). */
  nickColor?: string;
  /** Последний известный ник — для экспорта/отображения записей с id-ключом. */
  nick?: string;
  /**
   * Прежние ники этого игрока, свежие первыми.
   *
   * Люди переименовываются, и узнать человека становится нечем — при том что
   * заметка на него уже написана (ключ-то вечный, `u:<id>`). Копим короткий
   * хвост, чтобы можно было сказать «раньше играл как …».
   */
  nicks?: string[];
};

/** Сколько прежних ников помним. Хвост нужен для узнавания, а не для архива. */
export const MAX_NICK_HISTORY = 5;
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

/**
 * Потолок числа своих цветов в палитре. Живёт здесь, а не в координаторе:
 * его обязаны соблюдать ВСЕ писатели — фон, фолбэк вкладки и импорт бэкапа.
 * Раньше он был только у импорта, и бэкап собственной палитры молча терял
 * всё сверх сотни (adversarial 28.08.2026).
 */
export const MAX_CUSTOM_TAGS = 100;
export const NOTES_VERSION = "1.0";

/** Флаг «перенос из sync выполнен». Версионирован: следующий перенос — v2. */
export const MIGRATED_KEY = "pn_notes_migrated_v1";
/** Ключ заметок в совсем старых версиях расширения. */
const LEGACY_KEY = "notes";

/**
 * Ник приходит из DOM сайта. `__proto__` в качестве ключа объектного литерала
 * подменяет прототип вместо создания свойства: заметка «есть» в интерфейсе,
 * но не попадает в JSON и молча теряется. Такие ники просто не берём.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Ключ пригоден для ЗАПИСИ: строка, непустая, не прототипная, в пределах лимита
 * хранилища. Проверки runtime, а не только типа: ключ приезжает из DOM сайта и
 * из чужого файла бэкапа, где на месте строки бывает массив или null, — на
 * такое helper раньше отвечал «безопасно» или падал на `.length`
 * (тест-набор 01.08.2026, №1).
 */
export function isSafeNoteKey(key: unknown): key is string {
  if (typeof key !== "string" || !key) return false;
  if (key.length > MAX_NOTE_KEY) return false;
  return !UNSAFE_KEYS.has(key);
}

/**
 * Ключ пригоден для ПЕРЕНОСА из уже существующей карты. Здесь запрещён только
 * `__proto__` — единственный ключ, присваивание по которому подменяет
 * прототип. Ни лимит длины, ни `constructor`/`prototype` не применяем: такой
 * ключ мог когда-то доехать до диска, и молча выбросить его при слиянии
 * значит потерять заметку пользователя (создать новый всё равно не даст
 * `isSafeNoteKey`).
 */
function isPlainKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__";
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
  for (const [rawKey, rec] of Object.entries(notes)) {
    if (!rec || typeof rec === "string") continue;
    // Записи со старых версий могли не проходить санитизацию — цвет уходит
    // в style-атрибут, поэтому фильтр обязателен и на чтении.
    if (!isSafeTag(rec.nickColor)) continue;
    // Канонизация обязательна и здесь: под ключом "u:007" цвет не находился по
    // id 7, хотя слияние такие ключи уже сводит к одному (тест-набор, №5).
    const key = canonicalNoteKey(rawKey);
    if (isIdKey(key)) {
      byId.set(key.slice(ID_KEY_PREFIX.length), rec.nickColor);
      // nick из старого хранилища мог быть чем угодно (числом, объектом):
      // .toLowerCase() на нём ронял ПОСТРОЕНИЕ ВСЕГО индекса — то есть цвета
      // пропадали разом у всех игроков из-за одной битой записи.
      if (typeof rec.nick === "string" && rec.nick) {
        byNick.set(rec.nick.toLowerCase(), rec.nickColor);
      }
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
/**
 * Потолок для СВОЕЙ заметки, набранной руками. Отдельный и заметно выше:
 * тот же нормализатор теперь проходит и локальные правки, а молча обрезать
 * то, что пользователь сам написал, нельзя (ревью пакета B, находка 2).
 */
export const MAX_OWN_NOTE_TEXT = 20_000;
export const MAX_NOTE_KEY = 200;
export const MAX_IMPORT_ENTRIES = 20_000;

/**
 * Собрать чистый NoteRecord из произвольного значения. Берём ТОЛЬКО известные
 * поля известных типов — раньше запись из файла сохранялась сырым объектом
 * (`safe = note`), и `nick: 123` / `tag: ["red"]` доезжали до storage, а потом
 * ломали проходы заметок TypeError'ом (аудит безопасности 01.08.2026, №4/№12).
 * Возвращает null, если из значения не получается осмысленной заметки.
 */
export function normalizeNoteRecord(raw: unknown, maxText = MAX_NOTE_TEXT): NoteRecord | null {
  if (typeof raw === "string") {
    // Легаси-формат: заметка была просто строкой.
    return { text: raw.slice(0, maxText), timestamp: 0 };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string") return null;

  const rec: NoteRecord = {
    text: r.text.slice(0, maxText),
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
  if (Array.isArray(r.nicks)) {
    const nicks = r.nicks
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .map((n) => n.slice(0, MAX_NOTE_KEY))
      .slice(0, MAX_NICK_HISTORY);
    if (nicks.length > 0) rec.nicks = nicks;
  }
  return rec;
}

/**
 * Поля записи для сравнения: легаси-строка — это запись без времени.
 * На диске под ключом может лежать `null` или число (повреждённое хранилище,
 * чужой файл): читать с них поля нельзя — раньше слияние на таком падало.
 */
function fieldsOf(note: NoteRecord | string | null | undefined): NoteRecord {
  if (typeof note === "string") return { text: note, timestamp: 0 };
  if (!note || typeof note !== "object") return { text: "", timestamp: 0 };
  return note;
}

/**
 * Свести две записи одного игрока в одну.
 *
 * Побеждает более свежая, но КАЖДОЕ пустое поле победителя добирается из
 * проигравшей. Иначе слияние теряет данные, которых нет больше нигде: на
 * втором устройстве игроку поставили только цвет (запись с пустым текстом и
 * свежим временем) — и импорт такого бэкапа стирал написанную заметку.
 * Правило симметрично: неважно, в каком аргументе приехала непустая запись
 * (тест-набор 01.08.2026, №4).
 */
/**
 * Слить списки прежних ников: свежие первыми, без повторов и без текущего.
 * Сравнение регистронезависимое — сайт различает «Vasya» и «vasya», а
 * человек нет.
 */
export function mergeNickLists(
  a: string[] | undefined,
  b: string[] | undefined,
  current?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (current) seen.add(current.toLowerCase());
  for (const nick of [...(a ?? []), ...(b ?? [])]) {
    const k = nick.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(nick);
    if (out.length >= MAX_NICK_HISTORY) break;
  }
  return out;
}

/**
 * Поля записи при появлении НОВОГО ника игрока: сам ник и хвост прежних.
 * Вызывается всюду, где мы пишем `nick` у id-записи, — иначе переименование
 * просто затирало бы прошлое имя, и узнавать человека было бы не по чему.
 */
export function withNickHistory(
  prev: NoteRecord | string | null | undefined,
  nick: string,
): { nick: string; nicks?: string[] } {
  const rec = fieldsOf(prev);
  const previous = typeof rec.nick === "string" ? rec.nick : "";
  // Отсев «того же ника в другом регистре» делает mergeNickLists — второй
  // проверки здесь быть не должно: одно правило в двух местах расходится.
  const carried = previous ? [previous, ...(rec.nicks ?? [])] : (rec.nicks ?? []);
  const nicks = mergeNickLists(carried, undefined, nick);
  return nicks.length > 0 ? { nick, nicks } : { nick };
}

function combineNotes(a: NoteRecord | string, b: NoteRecord | string): NoteRecord {
  const [winner, loser] = noteTimestamp(b) > noteTimestamp(a) ? [b, a] : [a, b];
  const w = fieldsOf(winner);
  const l = fieldsOf(loser);
  const out: NoteRecord = { ...w };
  if (!out.text && l.text) out.text = l.text;
  if (!out.tag && l.tag) out.tag = l.tag;
  if (!out.nickColor && l.nickColor) out.nickColor = l.nickColor;
  if (!out.nick && l.nick) out.nick = l.nick;
  // Историю ников СЛИВАЕМ, а не выбираем: на двух устройствах игрок мог
  // застать разные переименования, и «победа свежего» теряла бы половину.
  const nicks = mergeNickLists(out.nicks, l.nicks, out.nick);
  if (nicks.length > 0) out.nicks = nicks;
  if (!out.version && l.version) out.version = l.version;
  return out;
}

/**
 * Изменилось ли СОДЕРЖИМОЕ записи — чтобы счётчик «обновлено» не врал.
 * Сравниваем по полям, а не по форме: легаси-строка и равнозначная ей запись
 * — это не «обновление заметки», а просто другое представление.
 */
function sameNote(a: NoteRecord | string, b: NoteRecord | string): boolean {
  const x = fieldsOf(a);
  const y = fieldsOf(b);
  // Object.is, а не ===: с NaN в поле запись «отличалась бы от самой себя» и
  // счётчик обновлений рос бы при каждом импорте одного и того же файла.
  return (
    Object.is(x.text, y.text) &&
    Object.is(x.timestamp, y.timestamp) &&
    Object.is(x.tag, y.tag) &&
    Object.is(x.nickColor, y.nickColor) &&
    Object.is(x.nick, y.nick) &&
    (x.nicks ?? []).join("\u0000") === (y.nicks ?? []).join("\u0000") &&
    Object.is(x.version, y.version)
  );
}

export function mergeNotes(
  base: NotesMap,
  incoming: NotesMap,
  /**
   * `onlyNew` — брать из incoming ТОЛЬКО отсутствующие ключи, не трогая
   * существующие записи. Режим для замороженного моста storage.sync: тот
   * снимок старше любой локальной заметки по построению (в sync не пишем с
   * 8.1.29), а правило «непустое побеждает пустое» иначе возвращало бы из
   * него снятые метки и стёртые тексты — молча, при первом запуске на каждом
   * новом устройстве (ревью 02.08.2026).
   */
  {
    onlyNew = false,
    maxText = MAX_NOTE_TEXT,
  }: {
    onlyNew?: boolean;
    /**
     * Потолок текста присланной заметки. По умолчанию — недоверенный ввод
     * (5000). Импорт СВОЕГО бэкапа поднимает его до MAX_OWN_NOTE_TEXT:
     * иначе round-trip собственной длинной заметки молча резал хвост и
     * рапортовал успех (ревью 27.08.2026, п.1 — потеря данных).
     */
    maxText?: number;
  } = {},
): { merged: NotesMap; added: number; replaced: number; truncated: number; skipped: number } {
  const merged: NotesMap = {};
  for (const [rawKey, note] of Object.entries(base)) {
    // Ключи базы канонизируем ТОЖЕ: "u:007" из старого хранилища и "u:7" из
    // файла — один игрок. Раньше канонизировалась только входящая сторона, и
    // пара ключей жила вечно (тест-набор 01.08.2026, №3).
    const key = canonicalNoteKey(rawKey);
    if (!isPlainKey(key)) continue;
    // hasOwn, а не `=== undefined`: ник «toString» вернул бы унаследованный
    // метод Object.prototype, и он поехал бы в слияние как запись.
    merged[key] = Object.hasOwn(merged, key) ? combineNotes(merged[key], note) : note;
  }

  // Ник → существующий id-ключ: старый бэкап с ник-ключами не должен
  // создавать ДУБЛЬ рядом с уже мигрированной u:-записью того же игрока
  // (дубль был бы невидим при чтении id-first и «воскресал» бы после
  // удаления). Сливаем в id-ключ по обычному правилу timestamp.
  const idKeyByNick = new Map<string, string>();
  const indexNick = (k: string, v: NoteRecord | string | undefined) => {
    // typeof-гард на nick обязателен и здесь: со старого хранилища там могло
    // оказаться число или массив, и слияние падало ЦЕЛИКОМ — импорт умирал, а
    // миграция из sync ловила исключение, не выставляла флаг и повторялась при
    // каждой загрузке навсегда (ревью 02.08.2026).
    const nick = fieldsOf(v ?? "").nick;
    if (isIdKey(k) && typeof nick === "string" && nick) idKeyByNick.set(nick.toLowerCase(), k);
  };
  for (const [k, v] of Object.entries(merged)) indexNick(k, v);

  // Входящие записи нормализуем ДО слияния, чтобы id-ключи попали в индекс
  // ников раньше, чем встретится ник-ключ того же игрока. Иначе порядок ключей
  // в файле решал, получится один игрок или два (тест-набор, №2).
  const items: Array<[string, NoteRecord, boolean]> = [];
  let truncated = 0;
  let skipped = 0;
  for (const [rawKey, note] of Object.entries(incoming)) {
    // Канонизация id-ключа: "u:0123" и "u:123" — один игрок, иначе присланный
    // файл плодил вторую невидимую запись (аудит безопасности, №12).
    const key = canonicalNoteKey(rawKey);
    if (!isSafeNoteKey(key)) {
      // Опасный/слишком длинный ключ — тоже потерянная запись (ревью
      // 27.08.2026): раньше он уходил в continue ДО счётчика, и тост молчал.
      skipped++;
      continue;
    }
    // Запись пересобирается из разрешённых полей: сырой объект из чужого
    // файла в карту больше не попадает (№4).
    const safe = normalizeNoteRecord(note, maxText);
    if (!safe) {
      // Запись выброшена целиком (битый text, чужой тип, опасный ключ) —
      // это ХУЖЕ обрезки, и молчать о ней нельзя (adversarial 27.08, №11).
      skipped++;
      continue;
    }
    const original = typeof note === "string" ? note : (note as { text?: unknown })?.text;
    // Обрезку помечаем НА ЗАПИСИ, а считаем ниже — только для тех, что
    // реально применились (adversarial №10: onlyNew, проигрыш по времени и
    // дубли ключей давали ложные числа).
    const wasCut = typeof original === "string" && original.length > safe.text.length;
    items.push([key, safe, wasCut]);
  }
  for (const [key, safe] of items) indexNick(key, safe);

  let added = 0;
  let replaced = 0;
  for (const [key, safe, wasCut] of items) {
    // Ник-ключ уводим в id-запись того же игрока ТОЛЬКО если такого ник-ключа
    // ещё нет в карте. Иначе мы бы вливали заметку в чужую запись: ник на
    // сайте освобождается и достаётся другому человеку, а id вечен — и у нас
    // не было бы способа отличить «тот же игрок» от «тёзка». Пока запись под
    // ником существует, она остаётся собой; новый дубль при этом не рождается
    // (ради чего редирект и делался).
    const targetKey =
      isIdKey(key) || Object.hasOwn(merged, key)
        ? key
        : (idKeyByNick.get(key.toLowerCase()) ?? key);
    if (!Object.hasOwn(merged, targetKey)) {
      merged[targetKey] = safe;
      added++;
      if (wasCut) truncated++;
    } else if (!onlyNew) {
      const existing = merged[targetKey];
      // `nick` — не пользовательский текст, а СВЯЗКА ИДЕНТИЧНОСТИ: по нему
      // ищется id-запись игрока (noteKeyFor), по нему же строится индекс
      // цветов и дедуп ник-ключей. Файл его переписывать не может: имея
      // устаревший ник, он рвал связку — при следующем импорте того же файла
      // ник-ключ создавался заново, цвет переставал находиться по нику, а
      // модалка открывалась пустой (ревью 02.08.2026, блокер).
      // typeof: битый нестроковый ник со старого хранилища цементировать не
      // надо — пусть его вылечит запись из файла.
      const existingNick = fieldsOf(existing).nick;
      const next = combineNotes(existing, safe);
      if (typeof existingNick === "string" && existingNick) next.nick = existingNick;
      if (!sameNote(existing, next)) {
        merged[targetKey] = next;
        replaced++;
        // Обрезанный текст реально попал в карту только если победил он.
        if (wasCut && next.text === safe.text) truncated++;
      }
    }
    // Новая id-запись с ником должна попасть в индекс: иначе ник-ключ того же
    // игрока, идущий дальше по файлу, создавал бы дубль (№12).
    indexNick(targetKey, merged[targetKey]);
  }
  return { merged, added, replaced, truncated, skipped };
}

/** Канонический вид ключа: у id-ключей убираем ведущие нули. */
export function canonicalNoteKey(key: string): string {
  if (!isIdKey(key)) return key;
  const id = key.slice(ID_KEY_PREFIX.length);
  if (!/^\d+$/.test(id)) return key;
  const norm = id.replace(/^0+(?=\d)/, "");
  return `${ID_KEY_PREFIX}${norm}`;
}

/**
 * Разовый перенос заметок из storage.sync. Ошибка не выставляет флаг — повторим позже.
 *
 * ЗАПИСЬ МИГРАЦИИ — ТОЛЬКО ИЗ КООРДИНАТОРА (SEC26-5): раньше её мог начать
 * любой контекст из loadNotes(), и снапшот L0, взятый до ожидания sync.get,
 * затирал целую карту поверх параллельной правки координатора. Контенты и
 * попап получают ОБЪЕДИНЁННЫЙ ВИД В ПАМЯТИ (без записи) и просят фон
 * выполнить перенос сериализованно.
 */
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

    // Два снимка из sync сводим между собой ОБЫЧНЫМИ правилами: `notes` —
    // формат совсем старых версий, `playerNotes` заведомо новее, и с onlyNew
    // на обоих слияниях древняя запись побеждала бы более новую (ревью
    // 02.08.2026). А уже готовый мост вносим в local только новыми ключами:
    // он старше любой локальной заметки и переписывать её не должен.
    // СВОИ заметки из sync-моста — своим потолком (adversarial 27.08.2026):
    // чужой потолок 5000 резал собственную длинную заметку молча и навсегда.
    const bridgeMerge = mergeNotes(fromLegacy, fromSync, { maxText: MAX_OWN_NOTE_TEXT });
    const bridge = bridgeMerge.merged;
    const mergeResult = mergeNotes(localNotes, bridge, {
      onlyNew: true,
      maxText: MAX_OWN_NOTE_TEXT,
    });
    const merged = mergeResult.merged;
    // Миграция одноразовая: молча потерянное здесь не вернуть никогда —
    // значит потери обязаны быть хотя бы в журнале (adversarial 27.08.2026).
    const lost = bridgeMerge.truncated + bridgeMerge.skipped + mergeResult.truncated + mergeResult.skipped;
    if (lost > 0) {
      log.warn(
        "notes",
        `перенос из облака прошёл не целиком: обрезано ${bridgeMerge.truncated + mergeResult.truncated}, пропущено ${bridgeMerge.skipped + mergeResult.skipped}`,
      );
    }

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
export async function loadNotes(opts?: {
  /** Разрешить ЗАПИСЬ миграции sync→local. Только координатор (SEC26-5). */
  persistMigration?: boolean;
}): Promise<{
  notes: NotesMap;
  customTags: string[];
  /** true = чтение упало и notes ПУСТАЯ НЕ ПОТОМУ, что заметок нет. Писать поверх НЕЛЬЗЯ. */
  loadFailed?: boolean;
  /**
   * Хранилище УЖЕ мигрировано (sync-мост слит в local).
   *
   * Нужно вызывающему, чтобы не записать объединённый ВИД как факт: вид
   * собирается в памяти для не-координаторов, и его запись из вкладки — это
   * миграция мимо единственного писателя (SEC26-5, внешний аудит 28.08.2026).
   */
  migrated?: boolean;
}> {
  try {
    const local = (await browser.storage.local.get({
      [NOTES_KEY]: {},
      [TAGS_KEY]: [],
      [MIGRATED_KEY]: false,
    })) as Record<string, unknown>;

    const notes = (local[NOTES_KEY] as NotesMap) || {};
    const customTags = Array.isArray(local[TAGS_KEY]) ? (local[TAGS_KEY] as string[]) : [];

    if (!local[MIGRATED_KEY]) {
      if (opts?.persistMigration) return { ...(await migrateFromSync(notes, customTags)), migrated: true };
      // Вид в памяти + просьба фону мигрировать (SEC26-5). Отказ доставки
      // не страшен: следующий loadNotes попросит снова.
      requestMigration();
      // migrated: false — вызывающий обязан знать, что перед ним ВИД, а не
      // факт с диска, и не имеет права записать его как факт.
      return { ...(await migratedView(notes, customTags)), migrated: false };
    }
    return { notes, customTags, migrated: true };
  } catch (e) {
    log.error("notes", "load failed", e);
    // loadFailed — обязательный гейт для писателей: запись «пустой» карты
    // поверх непрочитанного диска = потеря всех заметок.
    return { notes: {}, customTags: [], loadFailed: true };
  }
}

/** Объединённый ВИД (local + sync-мост) без единой записи — для не-координаторов. */
async function migratedView(
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
    const syncTags = Array.isArray(sync[TAGS_KEY])
      ? (sync[TAGS_KEY] as unknown[]).filter(isSafeTag)
      : [];
    if (!Object.keys(fromSync).length && !Object.keys(fromLegacy).length) {
      return { notes: localNotes, customTags: [...new Set([...localTags, ...syncTags])] };
    }
    // СВОИ заметки из sync-моста — своим потолком (adversarial 27.08.2026):
    // чужой потолок 5000 резал собственную длинную заметку молча и навсегда.
    const bridgeMerge = mergeNotes(fromLegacy, fromSync, { maxText: MAX_OWN_NOTE_TEXT });
    const bridge = bridgeMerge.merged;
    const mergeResult = mergeNotes(localNotes, bridge, {
      onlyNew: true,
      maxText: MAX_OWN_NOTE_TEXT,
    });
    const merged = mergeResult.merged;
    // Миграция одноразовая: молча потерянное здесь не вернуть никогда —
    // значит потери обязаны быть хотя бы в журнале (adversarial 27.08.2026).
    const lost = bridgeMerge.truncated + bridgeMerge.skipped + mergeResult.truncated + mergeResult.skipped;
    if (lost > 0) {
      log.warn(
        "notes",
        `перенос из облака прошёл не целиком: обрезано ${bridgeMerge.truncated + mergeResult.truncated}, пропущено ${bridgeMerge.skipped + mergeResult.skipped}`,
      );
    }
    return { notes: merged, customTags: [...new Set([...localTags, ...syncTags])] };
  } catch {
    return { notes: localNotes, customTags: localTags };
  }
}

let migrationRequested = false;
function requestMigration(): void {
  if (migrationRequested) return;
  migrationRequested = true;
  // sendRuntime глотает ошибки и резолвится undefined — catch был мёртв
  // (adversarial 27.08, №6). Смотрим на ОТВЕТ: не ok — попросим снова при
  // следующем load (фон спал или миграция внутри упала).
  void sendRuntime<{ ok?: boolean }>({ type: "notes_migrate" }).then((r) => {
    if (r?.ok !== true) migrationRequested = false;
  });
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
