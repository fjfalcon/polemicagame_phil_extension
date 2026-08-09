/**
 * Сколько людей сейчас в очередях поиска.
 *
 * Просьба владельца 09.08.2026: после игры, когда уже висит кнопка «В поиск»,
 * хочется понимать — есть ли смысл вставать, — не уходя со страницы.
 *
 * Источник: тот же адрес, которым пользуется сама страница поиска
 * (`getSearchState` в game-search: `GET <game-сервис>/api/search`). Ответ
 * анонимный, без ключей и без сессии, и содержит только числа по очередям —
 * ничего личного оттуда не приходит.
 *
 * ЗАПРОС ТОЛЬКО ПО ДЕЛУ: один раз при показе кнопки и потом по нажатию
 * «обновить». Никаких опросов по таймеру — цифра нужна человеку в момент
 * решения, а не каждую секунду; фоновый опрос со всех вкладок был бы платой
 * ни за что (вопрос из чата 09.08.2026 — «там что, get-запросы по кд идут?»).
 */
import { log } from "./log";

const SCOPE = "queue-state";

/** Адрес игрового сервиса (тот же, что зашит в конфиг страницы поиска). */
const SEARCH_API = "https://game.polemicagame.com/api/search";
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Подписи очередей. Сверено с censorshipModes живого game-search.js
 * 09.08.2026: standard «Обычный», polite «Рейтинг», prime «Prime».
 * За переименованием следит контрактная проба.
 */
export const QUEUE_TITLES: Record<string, string> = {
  standard: "Обычный",
  polite: "Рейтинг",
  prime: "Prime",
};

/** Порядок показа — как на странице поиска. */
export const QUEUE_ORDER = ["standard", "polite", "prime"] as const;

export interface QueueCount {
  mode: string;
  title: string;
  players: number;
}

/**
 * Разбор ответа. Поле `players` бывает и числом, и списком участников
 * (сайт умеет отдавать состав тому, кто сам стоит в очереди) — считаем
 * длину, но САМ СПИСОК наружу не отдаём: нам нужно количество, а не кто там.
 */
export function parseQueueState(payload: unknown): QueueCount[] | null {
  const queues = (payload as { queues?: Record<string, unknown> } | null)?.queues;
  if (!queues || typeof queues !== "object") return null;
  const out: QueueCount[] = [];
  for (const mode of QUEUE_ORDER) {
    const raw = (queues as Record<string, { players?: unknown }>)[mode];
    if (!raw) continue;
    const players = Array.isArray(raw.players)
      ? raw.players.length
      : typeof raw.players === "number"
        ? raw.players
        : null;
    if (players === null || !Number.isFinite(players) || players < 0) continue;
    out.push({ mode, title: QUEUE_TITLES[mode] ?? mode, players });
  }
  return out.length > 0 ? out : null;
}

/** Забрать состояние очередей. null — не удалось (это НЕ «очереди пусты»). */
export async function fetchQueueState(): Promise<QueueCount[] | null> {
  try {
    const res = await fetch(SEARCH_API, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      log.warn(SCOPE, `очереди: ответ ${res.status}`);
      return null;
    }
    const parsed = parseQueueState(await res.json());
    if (!parsed) log.warn(SCOPE, "очереди: неожиданный формат ответа");
    return parsed;
  } catch (e) {
    log.warn(SCOPE, "состояние очередей не загрузилось", e);
    return null;
  }
}

/** Строка для показа рядом с кнопкой: «Обычный 2 · Рейтинг 1 · Prime 1». */
export function formatQueues(counts: QueueCount[]): string {
  return counts.map((q) => `${q.title} ${q.players}`).join(" · ");
}
