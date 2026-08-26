import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  notes: {} as Record<string, unknown>,
  readFailed: false,
  saves: 0,
}));

vi.mock("@core/notes-store", () => ({
  MAX_OWN_NOTE_TEXT: 20_000,
  loadNotes: vi.fn(async () =>
    state.readFailed ? { notes: {}, customTags: [], loadFailed: true } : { notes: state.notes, customTags: [] },
  ),
  saveNotes: vi.fn(async (notes: Record<string, unknown>) => {
    await Promise.resolve();
    state.notes = notes;
    state.saves++;
    return true;
  }),
  normalizeNoteRecord: vi.fn((record: unknown) => record),
  mergeNotes: vi.fn((base: Record<string, unknown>, incoming: Record<string, unknown>) => ({
    merged: { ...base, ...incoming },
    added: Object.keys(incoming).filter((key) => !(key in base)).length,
    replaced: Object.keys(incoming).filter((key) => key in base).length,
  })),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyNoteOps, mergeNotesViaCoordinator } from "../../src/background/notes-coordinator";

beforeEach(() => {
  state.notes = {};
  state.readFailed = false;
  state.saves = 0;
});

describe("notes background coordinator", () => {
  test("serializes concurrent edits from two tabs without losing unrelated keys", async () => {
    const alice = { text: "Alice", timestamp: 1 };
    const bob = { text: "Bob", timestamp: 2 };
    const [a, b] = await Promise.all([
      applyNoteOps([{ key: "u:1", record: alice }]),
      applyNoteOps([{ key: "u:2", record: bob }]),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(state.notes).toEqual({ "u:1": alice, "u:2": bob });
    expect(state.saves).toBe(2);
  });

  test("read failure creates a read-only gate instead of overwriting with an empty map", async () => {
    state.readFailed = true;
    const result = await applyNoteOps([{ key: "u:1", record: { text: "x", timestamp: 1 } }]);
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(state.saves).toBe(0);
  });

  test("граница согласия: замен больше одобренного — consent_exceeded БЕЗ записи", async () => {
    // Ревью 26.08.2026: цифры диалога считались по снимку попапа, а карта у
    // координатора свежая — писать больше одобренного нельзя молча.
    state.notes = { "u:1": { text: "старая" }, "u:2": { text: "тоже" } };
    const result = await mergeNotesViaCoordinator(
      { "u:1": { text: "новая" }, "u:2": { text: "новее" } },
      1, // пользователь одобрил ОДНУ замену, реально будет две
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("consent_exceeded");
    expect(result.replaced, "свежие числа для нового вопроса").toBe(2);
    expect(state.saves, "ничего не записано").toBe(0);
  });

  test("замен ровно в пределах одобренного — пишем как обычно", async () => {
    state.notes = { "u:1": { text: "старая" } };
    const result = await mergeNotesViaCoordinator({ "u:1": { text: "новая" } }, 1);
    expect(result.ok).toBe(true);
    expect(state.saves).toBe(1);
  });

  test("без approvedReplaced (старый вызыватель) — прежнее поведение", async () => {
    state.notes = { "u:1": { text: "старая" } };
    const result = await mergeNotesViaCoordinator({ "u:1": { text: "новая" } });
    expect(result.ok).toBe(true);
    expect(state.saves).toBe(1);
  });
});
