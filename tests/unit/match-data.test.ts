import { describe, expect, test, vi } from "vitest";

vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getMatchId } from "../../src/content/match-data";

describe("getMatchId", () => {
  test.each([
    ["/match/314446", "314446"],
    ["/match/314446/", "314446"],
    ["/match/a-b", "a-b"],
    ["/game/314446", null],
    ["/match/314446/extra", null],
    ["/match/", null],
  ] as const)("%s -> %s", (path, expected) => {
    expect(getMatchId(path)).toBe(expected);
  });
});
