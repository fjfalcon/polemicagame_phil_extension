/**
 * Логгер с уровнями + кольцевой буфер, сбрасываемый в storage.local.
 *
 * Зачем буфер: консоль недоступна для диагностики у пользователя, а при «сумасшествии»
 * сайта Firefox перезапускают и консольные логи теряются. Буфер переживает перезапуск
 * (storage.local) и выгружается кнопкой в popup — так мы видим, что было перед сбоем.
 *
 * Уровни:
 *   - консоль: по умолчанию warn; поднять — localStorage.setItem('polemica:loglevel','debug')
 *   - буфер:   по умолчанию info; поднять — localStorage.setItem('polemica:buflevel','debug')
 */
import { browser } from "./env";

type Level = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function detectCtx(): string {
  try {
    if (typeof document === "undefined") return "bg"; // service worker (Chrome)
    const p = location.protocol;
    if (!p.startsWith("moz-extension") && !p.startsWith("chrome-extension")) return "content";
    // В Firefox фон — обычная скрытая страница с document, и раньше он писал
    // в тот же ключ, что и popup: логи затирали друг друга.
    const path = location.pathname;
    if (path.includes("background")) return "bg";
    if (path.includes("popup")) return "popup";
    return "ext";
  } catch {
    return "bg";
  }
}

/**
 * Уровень из localStorage — ТОЛЬКО для вывода в консоль.
 *
 * В content-скрипте localStorage принадлежит САЙТУ (AGENTS.md §5,
 * недоверенный источник). Раньше отсюда же брался уровень БУФЕРА, и сайт мог
 * выставить `polemica:buflevel=debug`, после чего в storage расширения (и
 * потом в файл для поддержки) писались, например, полные строки твич-чата
 * третьих лиц — тихое включение сбора чужих данных (аудит безопасности
 * 01.08.2026, находка 10). Буферный уровень теперь фиксирован.
 */
function resolveConsoleLevel(key: string, fallback: Level): Level {
  try {
    const v = (globalThis as any).localStorage?.getItem(key) as Level | null;
    if (v && v in ORDER) return v;
  } catch {
    /* localStorage недоступен в service worker */
  }
  return fallback;
}

const CTX = detectCtx();
const LOG_PREFIX = "polemica:logs:";
const LEGACY_CONTENT_LOG_KEY = `${LOG_PREFIX}content`;
const CONTENT_LOG_PREFIX = `${LOG_PREFIX}content-`;
const CONTENT_LOG_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_SESSION_ID =
  CTX === "content"
    ? `${Date.now().toString(36)}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
    : "";
const STORAGE_KEY =
  CTX === "content" ? `${CONTENT_LOG_PREFIX}${CONTENT_SESSION_ID}` : `${LOG_PREFIX}${CTX}`;
/**
 * Короткая метка документа в поле контекста: `content#a1b2`.
 *
 * Уникальный id сессии жил только в ИМЕНИ ключа хранилища и терялся при
 * склейке экспорта — строки двух одновременно открытых игр перемешивались под
 * одинаковым `content`, и разобрать «одна вкладка владеет сценой, вторая
 * получает отказ» было нельзя (аудит наблюдаемости 02.08.2026, LOG-2).
 */
const ENTRY_CTX =
  CTX === "content" ? `content#${CONTENT_SESSION_ID.slice(-4)}` : CTX;
const CAP = 600;
const MAX_MSG = 600;

interface Entry {
  t: number;
  c: string;
  l: string;
  s: string;
  m: string;
}

let buffer: Entry[] = [];
let persist = true;
let consoleLevel: Level = resolveConsoleLevel("polemica:loglevel", "warn");
/** Не из page-storage: см. resolveConsoleLevel. Меняется только кодом расширения. */
let bufferLevel: Level = "info";
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

/**
 * Вырезать из строки то, что похоже на секреты, и обрезать по длине.
 * Логи выгружаются в файл, который пользователь отправляет в поддержку —
 * ключи сессии, токены и пароли туда попадать не должны (аудит безопасности
 * 01.08.2026). Экспортируется, чтобы этим пользовались все, кто логирует
 * строки из сети/страницы.
 */
// \b вокруг коротких слов обязателен: без него «sid» съедал «considered».
// Схема (Bearer/Basic) пропускается ПЕРЕД значением, иначе вырезалось слово
// схемы, а сам токен оставался в логе.
// Разделителей между ключом и значением до восьми: у форматированного JSON
// (`"token" : "abcdef"`) их пять, и при лимите в четыре секрет оставался в
// логе целиком (тест-набор 01.08.2026, №6). Перенос строки в разделители НЕ
// входит: с ним слово на следующей строке лога вырезалось как «значение»
// ключа с прошлой — JSON.stringify всё равно держит ключ и значение вместе.
// Префикс `(?:[a-z0-9]+[_-])?` обязателен: `\b` перед словом не срабатывает
// после подчёркивания, и наш СОБСТВЕННЫЙ ключ `obs_password` уходил в лог
// нетронутым (ревью 02.08.2026). Слова вроде «considered» по-прежнему целы:
// их защищает `\b` в конце («sidered» — не граница слова).
const SECRET_RE =
  /(\b(?:[a-z0-9]+[_-])?(?:auth[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|session[_-]?id|sid|authorization)\b["' \t:=]{0,8}(?:(?:Bearer|Basic)\s+)?)([^\s,&"';]{4,})/gi;

export function redactSecrets(input: string, maxLen = 400): string {
  return input.replace(SECRET_RE, (_m, k: string) => `${k}…`).slice(0, maxLen);
}

/**
 * Что мы ОСОЗНАННО не вычищаем (решение владельца, 02.08.2026).
 *
 * Аудит наблюдаемости предлагал заменять имена сцен OBS и название твич-канала
 * на «задано/пусто». Оставили как есть: без имени сцены жалобу «переключилось
 * не туда» разобрать нечем, а риск невелик — это собственный лог пользователя,
 * который он сам решает отправить. Секреты (ключи, токены, пароли) чистятся
 * всегда и на стоке; адрес OBS — только схема+хост+порт, причина обрыва — наша
 * категория вместо текста от сервера.
 */

function fmtArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, MAX_MSG);
}

/**
 * Перед первой записью подтягиваем то, что уже лежит под нашим ключом.
 * Раньше буфер стартовал пустым и первый же flush затирал накопленное —
 * то есть логи НЕ переживали перезагрузку страницы (а в Chrome ключ `bg`
 * обнулялся при каждом рестарте service worker'а). Ровно тот сценарий,
 * ради которого буфер сделан, и не работал.
 */
let primed = false;
let priming: Promise<void> | null = null;

/** Индекс лог-ключей: чтобы уборка не читала ВЕСЬ storage.local.
 *  Имена НЕ под CONTENT_LOG_PREFIX — иначе сами попадали бы в кандидаты. */
const LOG_KEYS_INDEX = `${LOG_PREFIX}keys-index`;
const LOG_KEYS_SCAN_AT = `${LOG_PREFIX}keys-scanned-at`;
/** Раз в неделю — полный скан: страховка от ключей, осиротевших из-за гонки
 *  индекса между вкладками (последний писатель побеждает). */
const FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

async function cleanupStaleContentLogs(): Promise<void> {
  if (CTX !== "content") return;
  try {
    // Раньше здесь был storage.local.get(null): каждый запуск content-скрипта
    // десериализовывал ВСЁ хранилище, включая карту заметок на сотни записей
    // (аудит 01.08.2026, находка 11). Теперь ключи берутся из индекса; полный
    // скан — миграция при отсутствии индекса и еженедельная страховка.
    const idxRes = (await browser.storage.local.get([LOG_KEYS_INDEX, LOG_KEYS_SCAN_AT])) as Record<
      string,
      unknown
    >;
    const scannedAt = Number(idxRes[LOG_KEYS_SCAN_AT]) || 0;
    const fullScan =
      !Array.isArray(idxRes[LOG_KEYS_INDEX]) || Date.now() - scannedAt > FULL_SCAN_INTERVAL_MS;
    let candidates: string[];
    if (!fullScan) {
      candidates = (idxRes[LOG_KEYS_INDEX] as unknown[]).filter(
        (k): k is string =>
          typeof k === "string" &&
          (k === LEGACY_CONTENT_LOG_KEY || k.startsWith(CONTENT_LOG_PREFIX)),
      );
    } else {
      const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
      candidates = Object.keys(all).filter(
        (k) => k === LEGACY_CONTENT_LOG_KEY || k.startsWith(CONTENT_LOG_PREFIX),
      );
    }
    const foreign = candidates.filter((k) => k !== STORAGE_KEY);
    const logs = foreign.length
      ? ((await browser.storage.local.get(foreign)) as Record<string, unknown>)
      : {};

    const cutoff = Date.now() - CONTENT_LOG_TTL_MS;
    const stale = foreign.filter((key) => {
      const value = logs[key];
      if (!Array.isArray(value) || value.length === 0) return true;
      return (value as Entry[]).every((entry) => typeof entry.t !== "number" || entry.t < cutoff);
    });
    if (stale.length) await browser.storage.local.remove(stale);

    // Потолок на число сессионных ключей ВНУТРИ суток: марафонный день с
    // десятками перезагрузок не должен приближаться к квоте local (она общая
    // с заметками). Оставляем 8 самых свежих чужих ключей + свой.
    const survivors = foreign
      .filter((key) => key.startsWith(CONTENT_LOG_PREFIX) && !stale.includes(key))
      .map((key) => ({
        key,
        last: Math.max(
          0,
          ...((logs[key] as Entry[]) ?? []).map((e) => (typeof e.t === "number" ? e.t : 0)),
        ),
      }))
      .sort((a, b) => b.last - a.last);
    const overflow = survivors.slice(8).map((s) => s.key);
    if (overflow.length) await browser.storage.local.remove(overflow);

    // Свежий индекс: выжившие чужие ключи + наш. Перед записью пере-читаем
    // индекс и ОБЪЕДИНЯЕМ: вторая вкладка могла успеть дописать свой ключ, и
    // «последний писатель побеждает» осиротил бы его навсегда (уборка видит
    // только ключи из индекса). Гонку это сужает, а редкие потери добирает
    // еженедельный полный скан.
    const removed = new Set([...stale, ...overflow]);
    const kept = foreign.filter((k) => !removed.has(k));
    const freshIdx = (await browser.storage.local.get(LOG_KEYS_INDEX)) as Record<string, unknown>;
    const concurrent = Array.isArray(freshIdx[LOG_KEYS_INDEX])
      ? (freshIdx[LOG_KEYS_INDEX] as unknown[]).filter(
          (k): k is string =>
            typeof k === "string" &&
            !removed.has(k) &&
            (k === LEGACY_CONTENT_LOG_KEY || k.startsWith(CONTENT_LOG_PREFIX)),
        )
      : [];
    const union = [...new Set([...concurrent, ...kept, STORAGE_KEY])];
    await browser.storage.local.set({
      [LOG_KEYS_INDEX]: union,
      ...(fullScan ? { [LOG_KEYS_SCAN_AT]: Date.now() } : {}),
    });
  } catch {
    /* недоступно — следующая сессия попробует снова */
  }
}

// Флеш при уходе со страницы — для ЛЮБОГО контекста с документом (content,
// popup, фон Firefox). Раньше pagehide-флеш был только в content: popup
// систематически терял хвост логов при закрытии.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  window.addEventListener("pagehide", () => log.flushNow());
}

/**
 * Здоровье журнала: удалось ли вообще сохранить/прочитать записи.
 *
 * Если storage.local отказал (квота, временный сбой), пользователь выгружал
 * старый или почти пустой файл и принимал его за полный — а поддержка делала
 * выводы по журналу, которого нет (аудит наблюдаемости 02.08.2026, LOG-1,
 * КРИТИЧНО). Сообщать об этом через сам log.* нельзя: строка о том, что
 * запись не работает, ушла бы в ту же неработающую запись.
 */
const health = { failed: false, lost: false, operation: "", lastReportAt: 0, failStreak: 0 };
const HEALTH_REPORT_THROTTLE_MS = 60_000;
/**
 * Потолок самостоятельных повторов записи. Квота — состояние стойкое, и ничто
 * в цикле её не освобождает: без потолка воркер долбился бы в хранилище вечно
 * (24 обращения в минуту при полном бездействии) и, что хуже, НЕ ЗАСЫПАЛ бы —
 * вызовы extension API сбрасывают таймер простоя (ревью 02.08.2026).
 * После потолка ждём следующей записи в лог — она запланирует флеш сама.
 */
const MAX_FLUSH_RETRIES = 4;
const FLUSH_RETRY_BASE_MS = 5000;
const FLUSH_RETRY_CAP_MS = 60_000;
/**
 * Общая на все контексты отметка «журнал повреждён».
 *
 * Флага в памяти мало: файл собирает ПОПАП, а отказ записи случается прежде
 * всего в игровой вкладке — там объём. Попап о чужой беде не знал и печатал
 * `complete: yes` ровно в том случае, ради которого пометка и заводилась
 * (ревью 02.08.2026). Запись крошечная: при исчерпании квоты она обычно
 * проходит там, где падает запись шестисот строк.
 */
const HEALTH_KEY = `${LOG_PREFIX}health`;

function reportStorageFailure(operation: string, e: unknown): void {
  const first = !health.failed;
  health.failed = true;
  health.operation = operation;
  // Отметку пишем ТОЛЬКО на входе в состояние: на повторах она уже стоит, а
  // лишняя запись — это ещё одно обращение к сломанному хранилищу.
  if (first) {
    void browser.storage.local
      .set({ [HEALTH_KEY]: { ctx: ENTRY_CTX, at: Date.now(), operation } })
      .catch(() => undefined);
  }
  const now = Date.now();
  if (now - health.lastReportAt < HEALTH_REPORT_THROTTLE_MS) return;
  health.lastReportAt = now;
  // Только консоль: рекурсия через log.* тут запрещена — строка о том, что
  // запись не работает, ушла бы в ту же неработающую запись и закольцевалась.
  // eslint-disable-next-line no-console
  console.error("[polemica:log] журнал не сохранён", ENTRY_CTX, operation, e);
}

async function primeFromStorage(): Promise<void> {
  await cleanupStaleContentLogs();
  try {
    const res = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const prev = res[STORAGE_KEY];
    if (Array.isArray(prev) && prev.length) {
      buffer = [...(prev as Entry[]), ...buffer].slice(-CAP);
    }
  } catch (e) {
    reportStorageFailure("prime", e);
  }
  primed = true;
}

async function doFlush(): Promise<void> {
  flushTimer = null;
  if (!dirty) return;
  // Гейт по persist и ЗДЕСЬ: ранний log.info("booted") успевал запланировать
  // флеш до того, как асинхронный setPersist(false) долетал из настроек, — и
  // каждая загрузка страницы оставляла новый ключ content-<id> даже у
  // пользователей с выключенным логированием. Ключи копились сутками и
  // выедали квоту storage.local, общую с заметками.
  if (!persist) {
    dirty = false;
    return;
  }
  if (!primed) {
    priming ??= primeFromStorage();
    await priming;
  }
  dirty = false;
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: buffer });
    // Транзиентный сбой самоизлечим: dirty снят, но записи остались в буфере,
    // и этот успешный flush записал их целиком. Поэтому флаг снимаем — но
    // только если кольцо не проворачивалось (health.lost), иначе часть строк
    // потеряна безвозвратно и журнал полным уже не станет.
    if (!health.lost) health.failed = false;
    health.failStreak = 0;
  } catch (e) {
    reportStorageFailure("flush", e);
    // Следующей строки может не быть (тихий контекст) — планируем повтор сами,
    // иначе хвост не доедет вообще. Но с откатом и потолком: см. MAX_FLUSH_RETRIES.
    health.failStreak++;
    if (health.failStreak <= MAX_FLUSH_RETRIES) {
      const delay = Math.min(
        FLUSH_RETRY_BASE_MS * 2 ** (health.failStreak - 1),
        FLUSH_RETRY_CAP_MS,
      );
      scheduleFlush(delay);
    }
  }
}

function scheduleFlush(minDelay: number, urgent = false): void {
  dirty = true;
  if (flushTimer) {
    if (!urgent) return; // флеш уже запланирован — покроет и нас
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => void doFlush(), minDelay);
}

function record(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[bufferLevel]) return;
  // Чистка секретов НА СТОКЕ, а не на каждом вызывающем: helper существовал,
  // но применять его нужно было руками, и безопасность строки зависела от
  // того, вспомнил ли о нём автор. В файл поддержки уходит только то, что
  // прошло здесь (аудит наблюдаемости 02.08.2026, LOG-3). Консоль оставлена
  // сырой намеренно: это инструмент разработчика, он никуда не уезжает.
  buffer.push({
    t: Date.now(),
    c: ENTRY_CTX,
    l: level,
    s: scope,
    m: redactSecrets(fmtArgs(args), MAX_MSG),
  });
  if (buffer.length > CAP) {
    // Кольцо провернулось, пока запись не работала: вытесненные строки не
    // доедут уже никогда, и «починившийся» flush не делает журнал полным
    // (ревью 02.08.2026). Липкая отметка — до очистки логов.
    if (health.failed) health.lost = true;
    buffer.splice(0, buffer.length - CAP);
  }
  if (persist) scheduleFlush(level === "error" ? 400 : 3000, level === "error");
}

function emit(level: Exclude<Level, "silent">, scope: string, args: unknown[]): void {
  record(level, scope, args);
  if (ORDER[level] < ORDER[consoleLevel]) return;
  // eslint-disable-next-line no-console
  (console[level] ?? console.log)(`[polemica:${scope}]`, ...args);
}

/** Приписать в конец файла честную пометку о неполноте (одну, не больше). */
function withCompletenessNote(entries: Entry[]): Entry[] {
  if (!health.failed) return entries;
  return [
    ...entries,
    {
      t: Date.now(),
      c: ENTRY_CTX,
      l: "error",
      s: "log",
      m:
        `Журнал собран НЕ ПОЛНОСТЬЮ: storage.local отказал (${health.operation}). ` +
        "Часть записей потеряна — судить по этому файлу как по полному нельзя.",
    },
  ];
}

export const log = {
  setLevel(l: Level) {
    consoleLevel = l;
  },
  setBufferLevel(l: Level) {
    bufferLevel = l;
  },
  setPersist(on: boolean) {
    persist = on;
  },
  /** Немедленно сбросить буфер в storage (например, перед закрытием вкладки). */
  flushNow(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Не форсируем dirty: при persist=false record() ничего не планировал,
    // и pagehide не должен создавать ключ «в обход» выключенного логирования.
    void doFlush();
  },
  /** Записи текущего контекста (в памяти). */
  getBuffer(): Entry[] {
    return buffer.slice();
  },
  /**
   * Полон ли журнал. false — часть записей не сохранилась или не прочиталась,
   * и выгруженный файл НЕЛЬЗЯ считать полной картиной (LOG-1).
   */
  isComplete(): boolean {
    return !health.failed && !health.lost;
  },
  /** Собрать логи всех контекстов из storage.local, отсортировать по времени. */
  async collectAll(): Promise<Entry[]> {
    try {
      const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
      const merged: Entry[] = [];
      // Отметку о сбое мог оставить ДРУГОЙ контекст (обычно игровая вкладка —
      // там объём). Без её чтения попап печатал бы «complete: yes» ровно в том
      // случае, ради которого пометка и заводилась (ревью 02.08.2026).
      const marker = all[HEALTH_KEY] as
        | { ctx?: string; at?: number; operation?: string }
        | undefined;
      // TTL обязателен: один случайный сбой в три часа ночи иначе НАВСЕГДА
      // клеймил бы каждый будущий экспорт как неполный — и признак перестали
      // бы читать ровно тогда, когда он настоящий (ревью 02.08.2026). Логи
      // content живут сутки, поэтому и отметка старше суток о сегодняшнем
      // файле не говорит ничего.
      const fresh =
        !!marker &&
        typeof marker === "object" &&
        typeof marker.at === "number" &&
        Date.now() - marker.at < CONTENT_LOG_TTL_MS;
      if (fresh) {
        health.failed = true;
        health.operation = `${marker.operation ?? "?"} в ${marker.ctx ?? "?"}`;
      }
      for (const [k, v] of Object.entries(all)) {
        // Служебный индекс ключей — тоже массив под LOG_PREFIX, но строк, а
        // не Entry: без исключения его содержимое попадало в экспорт мусором
        // с «Invalid Date».
        if (k === LOG_KEYS_INDEX || k === HEALTH_KEY) continue;
        if (k.startsWith(LOG_PREFIX) && Array.isArray(v)) merged.push(...(v as Entry[]));
      }
      // Плюс несброшенные записи текущего контекста. Дедуп по содержимому:
      // сравнение по ссылке (includes) не отсеивало десериализованные копии,
      // и свои уже слитые записи попадали в экспорт дважды.
      const seen = new Set(merged.map((e) => `${e.t}|${e.c}|${e.s}|${e.m}`));
      for (const e of buffer) {
        if (!seen.has(`${e.t}|${e.c}|${e.s}|${e.m}`)) merged.push(e);
      }
      return withCompletenessNote(merged.sort((a, b) => a.t - b.t));
    } catch (e) {
      // Сюда попадаем, когда прочитать чужие контексты не удалось: в файл
      // уходит ТОЛЬКО буфер текущего попапа, и без пометки это выглядит как
      // «у пользователя почти пустой лог» (LOG-1).
      reportStorageFailure("collect", e);
      return withCompletenessNote(buffer.slice());
    }
  },
  /** Очистить логи всех контекстов. */
  async clearAll(): Promise<void> {
    buffer = [];
    // Чистая история — чистое здоровье: отметка сбоя удаляется вместе с
    // логами (ключ под тем же префиксом), снимаем и локальные флаги.
    health.failed = false;
    health.lost = false;
    health.operation = "";
    health.failStreak = 0;
    try {
      const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
      const keys = Object.keys(all).filter((k) => k.startsWith(LOG_PREFIX));
      if (keys.length) await browser.storage.local.remove(keys);
    } catch {
      /* no-op */
    }
  },
  debug: (scope: string, ...a: unknown[]) => emit("debug", scope, a),
  info: (scope: string, ...a: unknown[]) => emit("info", scope, a),
  warn: (scope: string, ...a: unknown[]) => emit("warn", scope, a),
  error: (scope: string, ...a: unknown[]) => emit("error", scope, a),
};
