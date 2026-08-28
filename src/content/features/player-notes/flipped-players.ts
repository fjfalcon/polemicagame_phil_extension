/**
 * Разбор списка перевёрнутых камер из sessionStorage СТРАНИЦЫ.
 *
 * Отдельный модуль (арх-ревью 28.08.2026): источник недоверенный, и у
 * разбора свои property-тесты — держать его посреди UI-фичи незачем.
 */

/**
 * Потолок числа перевёрнутых камер. За столом максимум ~12 игроков, 30 — с
 * запасом. sessionStorage принадлежит САЙТУ (недоверенный источник, AGENTS.md
 * §5): без потолка подсунутый гигантский массив навсегда селился в Set и
 * раздувал каждую последующую запись (аудит хрупкости 06.08.2026). Излишек
 * молча отбрасывается срезом.
 */
export const MAX_FLIPPED = 30;

/**
 * Разбор списка перевёрнутых камер из sessionStorage. Любой вход (не-JSON,
 * не-массив, не-строки, гигантский массив) даёт валидный Set размером не
 * больше MAX_FLIPPED — исключений наружу нет. Экспорт — тестовый шов для
 * property-тестов page-storage-trust (по паттерну noteTrustedInput в
 * queue-requeue.ts).
 */
export function parseFlippedPlayers(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return new Set();
    return new Set(
      list.filter((u): u is string => typeof u === "string" && u !== "").slice(0, MAX_FLIPPED),
    );
  } catch {
    /* повреждённый sessionStorage — просто начинаем с пустого набора */
    return new Set();
  }
}
