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
  MAX_NOTE_KEY,
  MAX_NOTE_TEXT,
  MAX_OWN_NOTE_TEXT,
  buildNickColorIndex,
  canonicalNoteKey,
  isSafeNoteKey,
  isSafeTag,
  MAX_NICK_HISTORY,
  mergeNickLists,
  mergeNotes,
  nickColorFrom,
  normalizeNoteRecord,
  withNickHistory,
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

  test.each([["Alice"], null, undefined, {}, 0, true])(
    "rejects non-string key at runtime %#",
    (key) => expect(isSafeNoteKey(key as never)).toBe(false),
  );

  test("enforces the storage key limit itself", () => {
    expect(isSafeNoteKey("a".repeat(MAX_NOTE_KEY))).toBe(true);
    expect(isSafeNoteKey("a".repeat(MAX_NOTE_KEY + 1))).toBe(false);
  });

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

  test.each([
    ["nick key first", { Alice: rec("nick", 1), "u:7": rec("id", 2, { nick: "Alice" }) }],
    ["id key first", { "u:7": rec("id", 2, { nick: "Alice" }), Alice: rec("nick", 1) }],
  ])("mixed backup order does not create a duplicate (%s)", (_name, incoming) => {
    const { merged } = mergeNotes({}, incoming as NotesMap);
    expect(Object.keys(merged)).toEqual(["u:7"]);
    expect(merged["u:7"]).toEqual(rec("id", 2, { nick: "Alice" }));
  });

  test("an existing nick key is never emptied into an id record", () => {
    // Ник на сайте освобождается и достаётся другому человеку, id — вечен.
    // Пока запись под ником есть, она остаётся собой: заметку о тёзке нельзя
    // молча влить в чужую и удалить последнюю копию (ревью 02.08.2026, №2).
    const { merged } = mergeNotes(
      { Alice: rec("заметка о нынешнем Alice", 5) },
      { Alice: rec("она же, свежее", 9), "u:7": rec("заметка о прежнем Alice", 1, { nick: "Alice" }) },
    );
    expect(merged.Alice).toEqual(rec("она же, свежее", 9));
    expect(merged["u:7"]).toEqual(rec("заметка о прежнем Alice", 1, { nick: "Alice" }));
  });

  test("a file cannot rewrite the nick that links a record to its player", () => {
    // Ник — связка идентичности: по нему ищется id-запись и строится индекс
    // цветов. Файл с устаревшим ником рвал связку (ревью 02.08.2026, блокер).
    const base: NotesMap = { "u:7": rec("локальная", 1000, { nick: "Alice" }) };
    const file: NotesMap = {
      "u:7": rec("из файла", 5000, { nick: "Bob" }),
      Alice: rec("ник-запись", 1),
    };
    const first = mergeNotes(base, file);
    expect(first.merged["u:7"]).toEqual(rec("из файла", 5000, { nick: "Alice" }));
    expect(Object.keys(first.merged)).toEqual(["u:7"]);

    // Тот же файл во второй раз не должен менять уже ничего.
    const second = mergeNotes(first.merged, file);
    expect(Object.keys(second.merged)).toEqual(["u:7"]);
    expect([second.added, second.replaced]).toEqual([0, 0]);

    // А вот битый нестроковый ник со старого хранилища цементировать не надо:
    // его как раз должна вылечить запись из файла.
    const healed = mergeNotes(
      { "u:7": rec("локальная", 1000, { nick: 123 as never }) },
      { "u:7": rec("из файла", 5000, { nick: "Bob" }) },
    ).merged;
    expect(healed["u:7"]).toEqual(rec("из файла", 5000, { nick: "Bob" }));
  });

  test("onlyNew adds missing keys and never touches existing records", () => {
    // Режим замороженного моста storage.sync: старый снимок не воскрешает
    // снятую метку и стёртый текст.
    const local: NotesMap = { "u:7": rec("", 1_780_000_000_000, { nick: "Alice" }) };
    const fromSync: NotesMap = {
      "u:7": rec("заметка 2024", 1_700_000_000_000, { tag: "#333", nickColor: "#111" }),
      Bob: rec("которой тут нет", 1_700_000_000_000),
    };
    const { merged, added, replaced } = mergeNotes(local, fromSync, { onlyNew: true });
    expect(merged["u:7"]).toEqual(rec("", 1_780_000_000_000, { nick: "Alice" }));
    expect(merged.Bob).toEqual(rec("которой тут нет", 1_700_000_000_000));
    expect([added, replaced]).toEqual([1, 0]);
  });

  test("a corrupted value in the base does not break the merge", () => {
    // На диске под ключом может лежать null (повреждённое хранилище): раньше
    // канонизация базы падала на нём и роняла ВЕСЬ импорт.
    const { merged } = mergeNotes(
      { "u:007": null as never, "u:7": rec("живая", 5) },
      { "u:7": rec("новая", 9) },
    );
    expect(merged["u:7"]).toEqual(rec("новая", 9));
  });

  test.each(["constructor", "prototype"])(
    "a note that already lives under the key %j is not silently dropped",
    (key) => {
      // Заводить такие ключи isSafeNoteKey не даёт, но если ключ когда-то
      // доехал до диска — выбрасывать заметку при слиянии нельзя. Опасен
      // только __proto__: присваивание по нему подменяет прототип.
      const { merged } = mergeNotes({ [key]: rec("заметка игрока", 5) }, {});
      expect(merged[key]).toEqual(rec("заметка игрока", 5));
      // Проверять через toEqual({}) бессмысленно: присваивание по __proto__
      // дёргает сеттер, собственного свойства не появляется и пустая карта
      // выглядит «нормально» — при том что прототип уже подменён.
      const polluted = mergeNotes({ ["__proto__"]: rec("подмена", 5) }, {}).merged;
      expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    },
  );

  test.each(["toString", "valueOf", "hasOwnProperty"])(
    "a nick shadowing Object.prototype.%s stays a real record",
    (nick) => {
      const { merged, added } = mergeNotes({}, { [nick]: rec("note", 1) });
      expect(added).toBe(1);
      expect(merged[nick]).toEqual(rec("note", 1));
    },
  );

  test("leading-zero id keys already present in the base canonicalize too", () => {
    const { merged } = mergeNotes({ "u:007": rec("old", 1) }, { "u:7": rec("new", 2) });
    expect(merged).toEqual({ "u:7": rec("new", 2) });
  });

  test("two leading-zero variants inside the base collapse into one record", () => {
    const { merged } = mergeNotes(
      { "u:007": rec("old", 1, { nickColor: "#111" }), "u:7": rec("new", 2) },
      {},
    );
    expect(merged).toEqual({ "u:7": rec("new", 2, { nickColor: "#111" }) });
  });

  const noteArb = fc.record({
    text: fc.string({ maxLength: 40 }),
    timestamp: fc.integer({ min: 0, max: 10_000 }),
    nickColor: fc.option(fc.constantFrom("#fff", "red", "rgba(1,2,3,0.5)"), { nil: undefined }),
    // nick обязателен в arbitrary: на нём держатся ВСЕ ветки дедупа, и без
    // него property-тесты пропустили блокер с перезаписью ника из файла.
    nick: fc.option(fc.constantFrom("Alice", "Bob", "Carol"), { nil: undefined }),
  });
  // Значение — и запись, и легаси-строка; ключ — и ник, и канонический
  // id-ключ. Именно на этих двух формах слияние и не было идемпотентным.
  const valueArb = fc.oneof(noteArb, fc.string({ maxLength: 20 }));
  const keyArb = fc.oneof(
    fc.stringMatching(/^[A-Za-z]{1,8}$/),
    fc.integer({ min: 1, max: 999 }).map((id) => `u:${id}`),
  );
  const mapArb = fc.array(fc.tuple(keyArb, valueArb), {
    maxLength: 20,
  }).map((entries) => Object.fromEntries(entries) as NotesMap);

  test("property: merging a canonical map with itself changes nothing", () => {
    fc.assert(
      fc.property(mapArb, (notes) => {
        const { merged, added, replaced } = mergeNotes(notes, notes);
        expect(merged).toEqual(notes);
        expect([added, replaced]).toEqual([0, 0]);
      }),
      { seed: 0x91_00_01, numRuns: 200 },
    );
  });

  test("property: importing the same file twice changes nothing the second time", () => {
    fc.assert(
      fc.property(mapArb, mapArb, (base, file) => {
        const first = mergeNotes(base, file).merged;
        const second = mergeNotes(first, file);
        expect(second.merged).toEqual(first);
        expect([second.added, second.replaced]).toEqual([0, 0]);
      }),
      { seed: 0x91_00_06, numRuns: 300 },
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

  test("property: a newer empty text never erases an existing note", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: 5000 }),
        (text, gap) => {
          // Запись «только цвет» с другого устройства свежее, но текста в ней
          // нет — импорт такого бэкапа не должен стирать заметку.
          const merged = mergeNotes(
            { Alice: rec(text, 1) },
            { Alice: rec("", 1 + gap, { nickColor: "#fff" }) },
          ).merged.Alice as NoteRecord;
          expect(merged.text).toBe(text);
          expect(merged.nickColor).toBe("#fff");
        },
      ),
      { seed: 0x91_00_04, numRuns: 200 },
    );
  });

  test("property: a nonempty color survives regardless of argument order", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("#fff", "red", "rgba(1,2,3,0.5)"),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        (color, tsColored, tsPlain) => {
          const colored: NotesMap = { Alice: rec("colored", tsColored, { nickColor: color }) };
          const plain: NotesMap = { Alice: rec("plain", tsPlain) };
          for (const merged of [
            mergeNotes(colored, plain).merged.Alice as NoteRecord,
            mergeNotes(plain, colored).merged.Alice as NoteRecord,
          ]) {
            expect(merged.nickColor).toBe(color);
          }
        },
      ),
      { seed: 0x91_00_05, numRuns: 200 },
    );
  });
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

  test("indexes leading-zero id keys under the canonical id", () => {
    const index = buildNickColorIndex({ "u:0123": rec("", 1, { nickColor: "#111" }) });
    expect(nickColorFrom(index, 123, null)).toBe("#111");
  });

  test("a malformed persisted record does not take the whole index down", () => {
    const index = buildNickColorIndex({
      "u:1": rec("", 1, { nick: 123 as never, nickColor: "#111" }),
      "u:2": rec("", 1, { nick: "Alice", nickColor: "#222" }),
    });
    expect(nickColorFrom(index, 1, null)).toBe("#111");
    expect(nickColorFrom(index, null, "Alice")).toBe("#222");
  });
});

describe("история ников", () => {
  test("переименование сохраняет прошлое имя", () => {
    const before: NoteRecord = { text: "врун", timestamp: NOW, nick: "Vasya" };
    expect(withNickHistory(before, "Петя")).toEqual({ nick: "Петя", nicks: ["Vasya"] });
  });

  test("тот же ник в другом регистре историей не считается", () => {
    // Сайт различает «Vasya» и «vasya», человек — нет. Иначе хвост забился бы
    // одним и тем же именем и вытеснил настоящие прошлые ники.
    const before: NoteRecord = { text: "", timestamp: NOW, nick: "Vasya" };
    expect(withNickHistory(before, "vasya")).toEqual({ nick: "vasya" });
  });

  test("прежние имена копятся, свежие впереди, длина ограничена", () => {
    let rec: NoteRecord = { text: "", timestamp: NOW, nick: "n0" };
    for (let i = 1; i <= MAX_NICK_HISTORY + 2; i++) {
      rec = { ...rec, ...withNickHistory(rec, `n${i}`) };
    }
    expect(rec.nick).toBe(`n${MAX_NICK_HISTORY + 2}`);
    expect(rec.nicks).toHaveLength(MAX_NICK_HISTORY);
    expect(rec.nicks?.[0], "самое свежее прошлое имя — первым").toBe(`n${MAX_NICK_HISTORY + 1}`);
  });

  test("у записи без прошлого ника хвост не появляется", () => {
    expect(withNickHistory(undefined, "Петя")).toEqual({ nick: "Петя" });
    expect(withNickHistory("легаси-текст", "Петя")).toEqual({ nick: "Петя" });
  });

  test("слияние двух устройств не теряет половину истории", () => {
    // На каждом устройстве игрок застал СВОИ переименования: победа свежей
    // записи целиком выкинула бы чужой хвост.
    const a: NoteRecord = { text: "a", timestamp: NOW, nick: "Now", nicks: ["A1", "A2"] };
    const b: NoteRecord = { text: "b", timestamp: NOW - 1000, nick: "Now", nicks: ["B1"] };
    const merged = mergeNotes({ "u:1": a }, { "u:1": b });
    const out = merged.merged["u:1"] as NoteRecord;
    expect(out.nicks).toEqual(["A1", "A2", "B1"]);
  });

  test("текущий ник в хвост не попадает", () => {
    expect(mergeNickLists(["Петя", "Vasya"], undefined, "Петя")).toEqual(["Vasya"]);
  });

  test("импорт чужого файла: мусор вместо истории не доезжает", () => {
    const clean = normalizeNoteRecord({
      text: "t",
      timestamp: NOW,
      nick: "Петя",
      nicks: ["ок", 42, null, "тоже ок"],
    });
    expect(clean?.nicks).toEqual(["ок", "тоже ок"]);
    expect(normalizeNoteRecord({ text: "t", timestamp: NOW, nicks: "строка" })?.nicks).toBeUndefined();
  });
});
