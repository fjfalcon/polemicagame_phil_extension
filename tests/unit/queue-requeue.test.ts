import { describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({ onDomChange: vi.fn() }));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseCountdownSeconds } from "@content/features/queue-requeue";

describe("parseCountdownSeconds", () => {
  test.each([
    [null, -1],
    ["", -1],
    ["00:00", 0],
    ["00:03", 3],
    ["1:05", 65],
    ["Игра будет распущена через 02:30", 150],
  ] as const)("%j -> %d", (input, expected) => {
    expect(parseCountdownSeconds(input)).toBe(expected);
  });

  test.todo("BUG: reject seconds >= 60 instead of accepting `1:60`");
  test.todo("BUG: reject or fully parse three-digit minutes instead of matching a substring");
});
