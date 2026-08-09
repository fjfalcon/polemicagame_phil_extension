/**
 * Ранний инжектор зонда комнаты (content-скрипт, document_start).
 *
 * Зачем отдельный скрипт: основной content.js грузится на document_end, а
 * комната создаёт сокет при выполнении своего бандла — гонка, в которой мы
 * регулярно опаздывали бы и не видели ни одного входящего кадра.
 *
 * ГЕЙТ ПО НАСТРОЙКЕ обязателен: подмена WebSocket у всех подряд — ровно то
 * решение, которое проект уже отвергал (находка 16 аудита устойчивости,
 * блокер ревью пакета C; см. комментарий в connection-diag.ts). Но
 * `storage` асинхронный, а ждать его значит снова опоздать к сокету —
 * поэтому основной content-скрипт держит СИНХРОННО читаемое зеркало
 * настройки в localStorage страницы, а здесь оно читается без await.
 * Отсутствие ключа (первый заход) трактуется как дефолт настройки.
 *
 * Никаких импортов из core/*: полифилл браузерных API тянул бы ~10 КБ,
 * которые парсились бы на document_start ПЕРЕД бандлом сайта — то есть
 * работали бы против той самой гонки, ради которой файл и существует.
 */

/** Зеркало настройки `pause_initiator_enabled` (пишет content.js). */
export const PROBE_FLAG_KEY = "pn_room_probe";
/** Зеркало настройки `ws_full_log_enabled` — по умолчанию ВЫКЛЮЧЕНА. */
export const WS_LOG_FLAG_KEY = "pn_ws_log";

/**
 * Читать флаги без падений: приватный режим запрещает localStorage целиком.
 *
 * Зонд нужен двум потребителям сразу, и у них разные дефолты: подпись
 * инициатора включена по умолчанию, полный лог кадров — нет. Поэтому «или»,
 * а не общий выключатель: выключив подпись, человек не должен незаметно
 * лишиться полного лога, который сам же только что включил.
 */
export function probeAllowed(store: Pick<Storage, "getItem"> | null): boolean {
  try {
    // Ключа нет — первый заход на этой машине: дефолт настройки (включено).
    if (store?.getItem(PROBE_FLAG_KEY) !== "0") return true;
    return store?.getItem(WS_LOG_FLAG_KEY) === "1";
  } catch {
    return true;
  }
}

const MARK = "data-pn-room-probe";

/** Экспорт — тестовый шов: гейт обязан быть покрыт мутационно. */
export function injectProbe(): void {
  if (!probeAllowed(localStorage)) return;
  if (document.querySelector(`script[${MARK}]`)) return;
  const runtime = (globalThis as { browser?: typeof chrome; chrome?: typeof chrome }).browser
    ?.runtime ?? (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (!runtime?.getURL) return;
  const s = document.createElement("script");
  s.setAttribute(MARK, "");
  // async=false: динамический скрипт по умолчанию асинхронный, а нам важно
  // встать до бандла сайта — иначе гонка, из-за которой файл и написан,
  // решается случайно (ревью 08.08.2026).
  s.async = false;
  s.src = runtime.getURL("room-probe-page.js");
  // Снимаем тег сразу после выполнения: он больше не нужен, а лишний узел в
  // <html> мешал бы разметке сайта и нашим же проверкам идемпотентности.
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
}

injectProbe();
