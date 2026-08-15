/**
 * Фича: детектор замирания главного потока («фризов») вкладки.
 *
 * Родился из жалобы 15.08.2026: «всё сильно тормозит, даже фол взять не
 * могла, но стрим работал» — то есть стоял именно главный поток вкладки. В
 * журнале при этом ТИШИНА, а тишина читается двояко: «расширение ничего не
 * делало» или «поток стоял, и никто не успевал писать». Различить было нечем
 * — датчик дрейфа жил только в диагностике очереди, а та работает на
 * странице поиска, не в комнате.
 *
 * Устройство: интервал раз в секунду сравнивает фактическое время с
 * ожидаемым. Опоздание больше порога = главный поток был занят чем-то одним
 * и длинным. Строка уходит в журнал и НЕМЕДЛЕННО на диск: если вкладка вот-вот
 * умрёт, улика обязана пережить её.
 *
 * Цена: одно вычитание чисел в секунду, без чтения DOM. Для сравнения:
 * страховочный проход player-notes каждые 2 секунды обходит все плитки.
 *
 * ФОНОВАЯ ВКЛАДКА — главный источник лжи: браузер сам растягивает таймеры
 * свёрнутых вкладок (Chrome — до минуты), и наивный детектор рапортовал бы
 * «фриз» на каждый alt-tab. Поэтому тик, захвативший скрытое состояние,
 * отбрасывается целиком: лучше пропустить настоящий фриз в фоне (там он и
 * не мешает никому), чем засорить журнал ложными.
 */
import { log } from "@core/log";
import type { Feature } from "@core/feature";

const SCOPE = "freeze";

/** Период тика. */
export const TICK_MS = 1000;
/**
 * Порог опоздания. Ниже двух секунд живут GC-паузы и обычный джиттер
 * таймеров под нагрузкой — про них писать значит утопить настоящие фризы.
 */
export const STALL_THRESHOLD_MS = 2000;
/**
 * Отсечка сна: на Windows монотонные часы идут и во сне системы, и после
 * пробуждения наивный детектор рапортовал бы «фриз час» при видимой вкладке
 * (находка adversarial 15.08.2026). Больше двух минут веб-страница главный
 * поток не держит — это сон, не фриз.
 */
export const SLEEP_CUTOFF_MS = 120_000;
/**
 * Дроссель журнала: страница, стабильно лагающая по 2.5 с, писала бы строку
 * каждые ~4 с — кольцо журнала прокрутилось бы за полчаса и вытеснило
 * ПЕРВОПРИЧИНУ (урок латча player-notes, PN-1). Подавленные считаются.
 */
export const LOG_COOLDOWN_MS = 10_000;

/**
 * Классификация одного тика. Чистая функция — сторожится мутационно.
 * null — тик обычный; число — главный поток стоял примерно столько мс.
 *
 * `hiddenDuring` — вкладка была скрыта хоть часть промежутка: браузерное
 * троттлинг-растяжение неотличимо от фриза, тик отбрасывается.
 */
export function classifyTick(
  expectedAt: number,
  actualAt: number,
  hiddenDuring: boolean,
): number | null {
  if (hiddenDuring) return null;
  const lag = actualAt - expectedAt;
  if (lag >= SLEEP_CUTOFF_MS) return null; // сон системы, не фриз
  return lag >= STALL_THRESHOLD_MS ? Math.round(lag) : null;
}

let interval: number | null = null;
let onVisibility: (() => void) | null = null;

export const freezeWatchFeature: Feature = {
  id: "freeze-watch",
  // Всегда включён: это датчик, он ничего не делает за игрока. Пишет только
  // в журнал, который и так под общим тумблером логирования.
  settingKey: null,

  enable() {
    let expectedAt = performance.now() + TICK_MS;
    // Скрытость учитывается ЗА ПРОМЕЖУТОК, а не в момент тика: вкладку могли
    // свернуть и развернуть между двумя тиками — момент показал бы visible,
    // а растяжение уже случилось.
    let hiddenDuring = document.hidden;
    onVisibility = () => {
      if (document.hidden) hiddenDuring = true;
    };
    document.addEventListener("visibilitychange", onVisibility);

    let lastLoggedAt = -Infinity;
    let suppressed = 0;
    interval = window.setInterval(() => {
      const now = performance.now();
      const stalledMs = classifyTick(expectedAt, now, hiddenDuring);
      hiddenDuring = document.hidden;
      expectedAt = now + TICK_MS;
      if (stalledMs === null) return;
      if (now - lastLoggedAt < LOG_COOLDOWN_MS) {
        suppressed++;
        return;
      }
      lastLoggedAt = now;
      const tail = suppressed > 0 ? ` (ещё фризов подавлено: ${suppressed})` : "";
      suppressed = 0;
      log.warn(SCOPE, `главный поток стоял ~${(stalledMs / 1000).toFixed(1)} с${tail}`);
      // Сразу на диск: фриз — предвестник зависания, план на 3 секунды может
      // не наступить (ровно урок Firefox-договорки).
      log.flushNow();
    }, TICK_MS);
  },

  disable() {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    if (onVisibility) {
      document.removeEventListener("visibilitychange", onVisibility);
      onVisibility = null;
    }
  },
};
