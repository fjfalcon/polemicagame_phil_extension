/**
 * Короткая справка по матчу: кто в нём был первым убитым («ПУ»).
 *
 * Просьба владельца 13.08.2026 — показывать ПУ в списке последних игр
 * (скриншот с пометками «ПУ» от руки). В списке игр профиля этого признака
 * нет: там только роль, результат и очки. Зато страница матча отдаёт разбор
 * целиком, и в нём есть готовое поле `firstKilled` — сразу userId, без
 * реконструкции по событиям ночи.
 *
 * Цена вопроса (замер 13.08.2026): страница матча — 31 КБ и ~0.5 с, то есть
 * дешевле одной страницы истории игр. Восемь таких запросов уходят разом, а
 * разобранный ответ кладётся в кэш НАВСЕГДА: результат сыгранного матча не
 * меняется, и второй раз спрашивать про него нечего.
 *
 * Отдельный модуль от content/match-data.ts намеренно: тот разбирает матч
 * ОТКРЫТОЙ страницы и живёт событиями DOM, а здесь — точечный запрос по
 * номеру, который нужен тултипу на любой странице.
 */
import { log } from "./log";

const SCOPE = "match-brief";

/**
 * Сколько разборов держим. Матчей за сессию перебирается немного (десяток
 * игроков × восемь игр), но кэш живёт всю жизнь вкладки — предел нужен, чтобы
 * долгий стрим не растил его бесконечно.
 */
export const CACHE_LIMIT = 400;
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * `number` — id первого убитого; `null` — матч разобран, но первого убитого в
 * нём нет (так бывает: игра закончилась без ночного отстрела). Разница важна:
 * из первого «нет» получилось бы «мы не знаем», а из второго — «точно не он».
 */
type FirstKilled = number | null;

const cache = new Map<string, FirstKilled>();
const inFlight = new Map<string, Promise<FirstKilled | undefined>>();

/** Только для тестов и диагностики. */
export function resetMatchBriefCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Вытащить первого убитого из HTML страницы матча.
 *
 * Разбор идёт по тому же атрибуту, что и у страницы разбора
 * (`<Gamestats :game-data='...'>`), но БЕЗ JSON.parse всего документа: нам
 * нужно одно число, а payload — десятки килобайт на каждый из восьми матчей.
 * Регулярка сужена до участка внутри атрибута, а `&quot;` покрыт отдельной
 * веткой — сайт отдаёт кавычки то так, то так.
 */
export function parseFirstKilled(html: string): FirstKilled | undefined {
  const attr =
    /(?::game-data|data-game|:game)='([^']*)'/.exec(html)?.[1] ??
    /(?::game-data|data-game|:game)="([^"]*)"/.exec(html)?.[1];
  if (attr === undefined) return undefined;
  const m = /(?:"|&quot;)firstKilled(?:"|&quot;)\s*:\s*(null|\d+)/.exec(attr);
  if (!m) return undefined;
  if (m[1] === "null") return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Кто был первым убитым в матче. `undefined` — узнать не удалось: показывать
 * «не ПУ» по неудаче нельзя, это была бы выдумка.
 */
export function fetchFirstKilled(matchId: number | string): Promise<FirstKilled | undefined> {
  const key = String(matchId);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const pending = inFlight.get(key);
  // Одна и та же игра встречается у разных игроков за столом — второй раз её
  // не спрашиваем даже пока первый запрос в полёте.
  if (pending) return pending;

  const request = (async (): Promise<FirstKilled | undefined> => {
    try {
      const res = await fetch(`https://polemicagame.com/match/${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Та же страховка, что и у разбора открытой страницы матча.
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!res.ok) {
        log.warn(SCOPE, `матч ${key}: ответ ${res.status}`);
        return undefined;
      }
      const parsed = parseFirstKilled(await res.text());
      if (parsed === undefined) {
        log.warn(SCOPE, `матч ${key}: первого убитого в данных нет`);
        return undefined;
      }
      // Кэшируем только разобранное: результат сыгранного матча не меняется,
      // а неудачу запоминать нельзя — сеть чинится.
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, parsed);
      return parsed;
    } catch (e) {
      log.warn(SCOPE, `матч ${key} не загрузился`, e);
      return undefined;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}
