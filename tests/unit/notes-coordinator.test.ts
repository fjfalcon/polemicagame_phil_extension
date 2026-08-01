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

import { applyNoteOps } from "../../src/background/notes-coordinator";

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
});
