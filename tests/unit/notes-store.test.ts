import fc from "fast-check";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    },
  },
}));

import {
  MAX_NOTE_TEXT,
  MAX_OWN_NOTE_TEXT,
  buildNickColorIndex,
  canonicalNoteKey,
  isSafeNoteKey,
  isSafeTag,
  mergeNotes,
  nickColorFrom,
  normalizeNoteRecord,
  type NoteRecord,
  type NotesMap,
} from "@core/notes-store";

const NOW = 1_800_000_000_000;

function rec(text: string, timestamp: number, extra: Partial<NoteRecord> = {}): NoteRecord {
  return { text, timestamp, ...extra };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("normalizeNoteRecord", () => {
  test.each([null, 42, true, [], ["note"], {}, { text: 42 }, new Date()])(
    "rejects malformed value %#",
    (value) => expect(normalizeNoteRecord(value)).toBeNull(),
  );

  test("normalizes legacy strings and applies import/local text limits", () => {
    const long = "x".repeat(MAX_OWN_NOTE_TEXT + 10);
    expect(normalizeNoteRecord(long)?.text).toHaveLength(MAX_NOTE_TEXT);
    expect(normalizeNoteRecord({ text: long }, MAX_OWN_NOTE_TEXT)?.text).toHaveLength(
      MAX_OWN_NOTE_TEXT,
    );
  });

  test("keeps only known, correctly typed fields", () => {
    const input = Object.assign(Object.create({ inherited: "bad" }), {
      text: "note",
      timestamp: NOW - 1,
      version: "9.1.0",
      tag: "linear-gradient(#fff, #000)",
      nickColor: "#abcdef",
      nick: "Игрок",
      nested: { secret: true },
      __proto__: { polluted: true },
    });
    expect(normalizeNoteRecord(input)).toEqual({
      text: "note",
      timestamp: NOW - 1,
      version: "9.1.0",
      tag: "linear-gradient(#fff, #000)",
      nickColor: "#abcdef",
      nick: "Игрок",
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test.each([Number.NaN, Infinity, -1, 0, "123"])("normalizes invalid timestamp %s", (ts) => {
    expect(normalizeNoteRecord({ text: "x", timestamp: ts })?.timestamp).toBe(0);
  });

  test("clamps future timestamps so imports cannot win forever", () => {
    expect(normalizeNoteRecord({ text: "future", timestamp: NOW + 10 ** 12 })?.timestamp).toBe(NOW);
  });
});

describe("safe note keys and CSS tags", () => {
  test.each(["", "__proto__", "constructor", "prototype"])("rejects unsafe key %j", (key) => {
    expect(isSafeNoteKey(key)).toBe(false);
  });

  test.each([123])("rejects non-string key %j", (key) => {
    expect(isSafeNoteKey(key as never)).toBe(false);
  });

  test.todo("BUG: isSafeNoteKey must reject arrays instead of trusting the TypeScript signature");
  test.todo("BUG: isSafeNoteKey must reject null/undefined instead of throwing");
  test.todo("BUG: isSafeNoteKey must enforce the 200-character storage key limit itself");

  test.each([
    "#fff",
    "rgba(1, 2, 3, 0.5)",
    "linear-gradient(45deg, #fff, #000)",
    "red",
  ])("accepts safe color %s", (tag) => expect(isSafeTag(tag)).toBe(true));

  test.each([
    123,
    ["red"],
    null,
    "red;position:fixed",
    "url(https://evil.test/a)",
    "expression(alert(1))",
    "@import evil",
    "a".repeat(201),
  ])("rejects unsafe tag %#", (tag) => expect(isSafeTag(tag)).toBe(false));
});

describe("mergeNotes", () => {
  test("newer text inherits a nonempty color, tag and nick", () => {
    const base = {
      "u:123": rec("old", 10, { nick: "Alice", tag: "#111", nickColor: "#222" }),
    };
    const { merged, replaced } = mergeNotes(base, { "u:123": rec("new", 20) });
    expect(merged["u:123"]).toEqual(
      rec("new", 20, { nick: "Alice", tag: "#111", nickColor: "#222" }),
    );
    expect(replaced).toBe(1);
  });

  test("legacy strings participate with timestamp zero", () => {
    expect(mergeNotes({ Alice: "old" }, { Alice: rec("new", 1) }).merged.Alice).toEqual(
      rec("new", 1),
    );
    expect(mergeNotes({ Alice: rec("new", 1) }, { Alice: "old" }).merged.Alice).toEqual(
      rec("new", 1),
    );
  });

  test("nickname input merges into an existing id record", () => {
    const result = mergeNotes(
      { "u:7": rec("id", 1, { nick: "Alice" }) },
      { alice: rec("nick", 2, { nickColor: "#123456" }) },
    ).merged;
    expect(Object.keys(result)).toEqual(["u:7"]);
    expect(result["u:7"]).toEqual(rec("nick", 2, { nick: "Alice", nickColor: "#123456" }));
  });

  test("incoming leading-zero id keys canonicalize to one player", () => {
    const result = mergeNotes({}, { "u:0123": rec("old", 1), "u:123": rec("new", 2) }).merged;
    expect(result).toEqual({ "u:123": rec("new", 2) });
  });

  test("future import cannot permanently beat a later local record", () => {
    const imported = mergeNotes({}, { Alice: rec("import", NOW + 99_999) }).merged;
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1);
    expect(mergeNotes(imported, { Alice: rec("local", NOW + 1) }).merged.Alice).toEqual(
      rec("local", NOW + 1),
    );
  });

  test.todo("BUG: mixed backup order nick-key then id-key must not create duplicate records");
  test.todo("BUG: canonicalize leading-zero id keys already present in the base map");

  const noteArb = fc.record({
    text: fc.string({ maxLength: 40 }),
    timestamp: fc.integer({ min: 0, max: 10_000 }),
    nickColor: fc.option(fc.constantFrom("#fff", "red", "rgba(1,2,3,0.5)"), { nil: undefined }),
  });
  const mapArb = fc.array(fc.tuple(fc.stringMatching(/^[A-Za-z]{1,8}$/), noteArb), {
    maxLength: 20,
  }).map((entries) => Object.fromEntries(entries) as NotesMap);

  test("property: merging a normalized map with itself is idempotent", () => {
    fc.assert(
      fc.property(mapArb, (notes) => {
        expect(mergeNotes(notes, notes).merged).toEqual(notes);
      }),
      { seed: 0x91_00_01, numRuns: 200 },
    );
  });

  test("property: argument order cannot create keys outside either input", () => {
    fc.assert(
      fc.property(mapArb, mapArb, (a, b) => {
        const allowed = new Set([...Object.keys(a), ...Object.keys(b)].map(canonicalNoteKey));
        for (const merged of [mergeNotes(a, b).merged, mergeNotes(b, a).merged]) {
          expect(Object.keys(merged).every((key) => allowed.has(canonicalNoteKey(key)))).toBe(true);
        }
      }),
      { seed: 0x91_00_02, numRuns: 200 },
    );
  });

  test("property: replacing text never drops an existing nonempty nickColor", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constantFrom("#fff", "red", "rgba(1,2,3,0.5)"),
        (text, color) => {
          const merged = mergeNotes(
            { Alice: rec("old", 1, { nickColor: color }) },
            { Alice: rec(text, 2) },
          ).merged.Alice as NoteRecord;
          expect(merged.nickColor).toBe(color);
        },
      ),
      { seed: 0x91_00_03, numRuns: 200 },
    );
  });

  test.todo("BUG/property: merging must not replace a nonempty text with an empty newer text");
  test.todo("BUG/property: a color on the older argument must survive regardless of argument order");
});

describe("color index and canonical identity", () => {
  test("indexes id and nickname, preferring id lookup", () => {
    const index = buildNickColorIndex({
      "u:123": rec("", 1, { nick: "Alice", nickColor: "#111" }),
      alice: rec("", 2, { nickColor: "#222" }),
    });
    expect(nickColorFrom(index, 123, "Alice")).toBe("#111");
    expect(nickColorFrom(index, null, "ALICE")).toBe("#222");
    expect(nickColorFrom(index, 999, "Nobody")).toBe("");
  });

  test.each([
    ["u:0123", "u:123"],
    ["u:000", "u:0"],
    ["u:abc", "u:abc"],
    ["Alice", "Alice"],
  ])("canonicalNoteKey(%s) -> %s", (input, expected) => {
    expect(canonicalNoteKey(input)).toBe(expected);
  });

  test.todo("BUG: buildNickColorIndex should canonicalize leading-zero id keys");
  test.todo("BUG: malformed persisted nick values must not crash buildNickColorIndex");
});
