import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@core/env", () => ({
  browser: {
    tabs: { query: mocks.query, sendMessage: mocks.sendMessage },
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendToActiveTabStrict, sendToTab } from "@core/messaging";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.sendMessage.mockReset();
});

describe("message delivery contracts", () => {
  test("best-effort broadcasts swallow a missing receiver", async () => {
    mocks.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    await expect(sendToTab(7, { type: "notes_merge", incoming: {} })).resolves.toBeUndefined();
  });

  test("strict commands reject when there is no active tab", async () => {
    mocks.query.mockResolvedValue([]);
    await expect(sendToActiveTabStrict({ type: "notes_merge", incoming: {} })).rejects.toThrow(
      "no active tab",
    );
  });

  test("strict commands propagate a missing-receiver rejection", async () => {
    mocks.query.mockResolvedValue([{ id: 7 }]);
    mocks.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    await expect(sendToActiveTabStrict({ type: "notes_merge", incoming: {} })).rejects.toThrow(
      "Receiving end does not exist",
    );
  });
});
