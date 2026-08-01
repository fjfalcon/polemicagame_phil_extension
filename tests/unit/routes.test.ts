import { describe, expect, test } from "vitest";

import { isGameRoomPath, isSearchPath } from "@shared/routes";

describe("isGameRoomPath", () => {
  test.each(["/game", "/game/", "/game/123"])("%s — комната", (path) => {
    expect(isGameRoomPath(path)).toBe(true);
  });

  test.each(["/game-search", "/game-search/", "/gameover", "/", "/profile/13509"])(
    "%s — не комната",
    (path) => expect(isGameRoomPath(path)).toBe(false),
  );
});

describe("isSearchPath", () => {
  test.each(["/game-search", "/game-search/", "/game-search/quick"])("%s — поиск", (path) => {
    expect(isSearchPath(path)).toBe(true);
  });

  test.each(["/game", "/", "/game-searching"])("%s — не поиск", (path) => {
    expect(isSearchPath(path)).toBe(false);
  });
});
