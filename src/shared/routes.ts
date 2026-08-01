/**
 * Маршруты сайта — общее знание content-скрипта и background.
 *
 * Правило должно быть ОДНО: иначе фон и страница расходятся во мнении,
 * игровая ли это вкладка.
 */

/** Страница игровой комнаты (POST-переход после on_game_found). */
export function isGameRoomPath(pathname: string): boolean {
  return pathname === "/game" || pathname.startsWith("/game/");
}

/** Страница поиска игры. */
export function isSearchPath(pathname: string): boolean {
  return pathname === "/game-search" || pathname.startsWith("/game-search/");
}
