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
    // Секунд >= 60 не бывает: такую строку мы не поняли, а не «две минуты».
    ["1:60", -1],
    ["00:99", -1],
    // Трёхзначные минуты разбираем целиком, а не внутренним куском «00:30».
    ["100:30", 6030],
    // Число рядом с отсчётом не должно давать ложного совпадения.
    ["12345:30", -1],
    ["02:304", -1],
  ] as const)("%j -> %d", (input, expected) => {
    expect(parseCountdownSeconds(input)).toBe(expected);
  });
});
