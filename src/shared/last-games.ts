/**
 * Настройки окна «последние игры».
 *
 * Общее место для контента и попапа: сколько игр показывать. Четыре было
 * зашито в код с самого порта, восемь попросил владелец 13.08.2026 — и раз
 * значений теперь два, нормализация мусора из storage обязана быть ОДНА
 * (иначе попап покажет пустой селект, а контент возьмёт своё число).
 */
export const LAST_GAMES_COUNTS = ["4", "8"] as const;
export type LastGamesCount = (typeof LAST_GAMES_COUNTS)[number];

/** Сколько игр показываем по умолчанию (просьба владельца — восемь). */
export const DEFAULT_LAST_GAMES_COUNT: LastGamesCount = "8";

/** Нормализовать значение настройки к допустимому. */
export function readLastGamesCount(raw: unknown): LastGamesCount {
  return (LAST_GAMES_COUNTS as readonly string[]).includes(raw as string)
    ? (raw as LastGamesCount)
    : DEFAULT_LAST_GAMES_COUNT;
}

/** То же числом — для запроса и обрезки списка. */
export function lastGamesLimit(raw: unknown): number {
  return Number(readLastGamesCount(raw));
}
