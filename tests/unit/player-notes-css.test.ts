// @vitest-environment jsdom
import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/dom", () => ({ onDomChange: vi.fn(), paintNickEl: vi.fn() }));
vi.mock("@core/messaging", () => ({ onMessage: vi.fn(), sendRuntime: vi.fn() }));
vi.mock("../../src/content/camera-flip", () => ({
  toggleFlipForPlayer: vi.fn(),
  isPlayerFlipped: vi.fn(),
  unflipAll: vi.fn(),
}));
vi.mock("../../src/content/match-data", () => ({ getMatchId: vi.fn() }));

let cssAttr: (value: string) => string;

beforeAll(async () => {
  ({ cssAttr } = await import("@content/features/player-notes"));
});

describe("cssAttr", () => {
  test.each([
    "Alice Bob",
    'Alice\"Bob',
    "эмодзи😀",
    "Кириллица-Ёж",
    "control\u0001name",
    "line\nfeed",
  ])("builds a valid exact-match selector for %j", (nick) => {
    document.body.replaceChildren();
    const node = document.createElement("div");
    node.dataset.username = nick;
    document.body.append(node);
    const selector = `[data-username=${cssAttr(nick)}]`;
    expect(() => document.querySelectorAll(selector)).not.toThrow();
  });
});
