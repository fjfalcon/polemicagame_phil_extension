import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() } }, runtime: { id: "x" } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(),
  broadcastToGameTabs: vi.fn(),
}));

import { closeCategory, safeEndpoint } from "../../src/background/obs-client";

describe("safeEndpoint — адрес OBS для лога", () => {
  test("логин, пароль и query не уезжают в файл поддержки", () => {
    // В obs_host люди вписывают что угодно, включая ws://user:pass@host.
    expect(safeEndpoint("ws://user:pass@192.168.1.5:4455/?token=abcdef")).toBe(
      "ws://192.168.1.5:4455",
    );
  });

  test.each([
    ["ws://localhost:4455", "ws://localhost:4455"],
    ["wss://obs.example.com", "wss://obs.example.com"],
  ])("обычный адрес %s остаётся читаемым", (input, expected) => {
    expect(safeEndpoint(input)).toBe(expected);
  });

  test("мусор не притворяется адресом", () => {
    expect(safeEndpoint("не адрес")).toBe("(некорректный адрес)");
  });
});

describe("closeCategory — причина обрыва нашими словами", () => {
  test.each([
    [1000, "штатное закрытие"],
    [4009, "аутентификация отклонена"],
    [4008, "аутентификация отклонена"],
    [4010, "несовместимая версия obs-websocket"],
    [4011, "несовместимая версия obs-websocket"],
    [1006, "обрыв связи"],
    [1234, "прочее"],
  ])("код %d → %s", (code, expected) => {
    // Текст причины присылает СЕРВЕР, в него может попасть что угодно —
    // в лог идёт только код и наша категория.
    expect(closeCategory(code)).toBe(expected);
  });
});
