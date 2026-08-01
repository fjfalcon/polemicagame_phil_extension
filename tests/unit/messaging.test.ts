import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  runtimeSend: vi.fn(),
  runtime: { id: "abcdef" as string | undefined },
}));

vi.mock("@core/env", () => ({
  browser: {
    tabs: { query: mocks.query, sendMessage: mocks.sendMessage },
    runtime: {
      get id() {
        return mocks.runtime.id;
      },
      sendMessage: mocks.runtimeSend,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from "@core/log";
import { sendRuntime, sendToActiveTabStrict, sendToTab } from "@core/messaging";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.sendMessage.mockReset();
  mocks.runtimeSend.mockReset();
  mocks.runtime.id = "abcdef";
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

describe("осиротевшая после обновления страница", () => {
  test("обычное «нет получателя» (попап закрыт) НЕ объявляется осиротевшей", async () => {
    // Эту строку пишет и сам background, когда шлёт событие в закрытый попап.
    // Матчить текст ошибки нельзя — лог наполнился бы ложью, уводящей разбор
    // жалобы не туда (ревью 02.08.2026, блокер).
    mocks.runtimeSend.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist."),
    );
    await expect(sendRuntime({ type: "getContentVersion" })).resolves.toBeUndefined();
    const said = vi.mocked(log.info).mock.calls.map((a) => a.join(" ")).join("\n");
    expect(said).not.toContain("осиротела");
  });

  test("инвалидированный контекст объявляется один раз", async () => {
    // Канонический признак: у осиротевшего скрипта runtime.id пропадает.
    mocks.runtime.id = undefined;
    mocks.runtimeSend.mockRejectedValue(new Error("Extension context invalidated."));
    await sendRuntime({ type: "getContentVersion" });
    await sendRuntime({ type: "getContentVersion" });
    const orphanLines = vi
      .mocked(log.info)
      .mock.calls.map((a) => a.join(" "))
      .filter((line) => line.includes("осиротела"));
    expect(orphanLines).toHaveLength(1);
  });
});
