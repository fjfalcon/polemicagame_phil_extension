import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(), set: vi.fn(async () => undefined) },
      sync: { get: vi.fn() },
    },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { browser } from "@core/env";
import { loadNotes, type NotesMap } from "@core/notes-store";

const local = browser.storage.local as unknown as { get: Mock; set: Mock };
const sync = browser.storage.sync as unknown as { get: Mock };

const MIGRATED_KEY = "pn_notes_migrated_v1";

/** Устройство ещё не мигрировало: в local лежит то, что передали, флага нет. */
function givenStorage(localNotes: NotesMap, syncNotes: NotesMap, legacyNotes: NotesMap = {}) {
  local.get.mockResolvedValue({
    playerNotes: localNotes,
    tagCustomColors: [],
    [MIGRATED_KEY]: false,
  });
  sync.get.mockResolvedValue({
    playerNotes: syncNotes,
    notes: legacyNotes,
    tagCustomColors: [],
  });
}

beforeEach(() => {
  local.set.mockClear();
});

describe("разовый перенос заметок из storage.sync", () => {
  test("более новый снимок sync побеждает древний legacy-ключ", () => {
    // `notes` — формат совсем старых версий, `playerNotes` заведомо новее.
    givenStorage(
      {},
      { Alice: { text: "заметка 2025", timestamp: 1_750_000_000_000, nickColor: "#111" } },
      { Alice: { text: "заметка 2021", timestamp: 1_600_000_000_000 } },
    );
    return loadNotes().then(({ notes }) => {
      expect(notes.Alice).toEqual({
        text: "заметка 2025",
        timestamp: 1_750_000_000_000,
        nickColor: "#111",
      });
    });
  });

  test("мост не трогает локальную запись — только добавляет отсутствующие", async () => {
    // Метку и текст на устройстве сняли; замороженный снимок sync не должен
    // возвращать их обратно молча, при первом же запуске.
    givenStorage(
      { "u:7": { text: "", timestamp: 1_780_000_000_000, nick: "Alice" } },
      {
        "u:7": { text: "заметка 2024", timestamp: 1_700_000_000_000, tag: "#333" },
        Bob: { text: "которой тут нет", timestamp: 1_700_000_000_000 },
      },
    );
    const { notes } = await loadNotes();
    expect(notes["u:7"]).toEqual({ text: "", timestamp: 1_780_000_000_000, nick: "Alice" });
    expect(notes.Bob).toEqual({ text: "которой тут нет", timestamp: 1_700_000_000_000 });
  });

  test("битый ник в локальной записи не срывает перенос", async () => {
    // Раньше слияние падало на nick-числе, миграция ловила исключение и не
    // выставляла флаг — то есть повторялась при каждой загрузке навсегда.
    givenStorage(
      { "u:7": { text: "живая", timestamp: 5, nick: 123 as never } },
      { Bob: { text: "из облака", timestamp: 7 } },
    );
    const { notes } = await loadNotes();
    expect(notes.Bob).toEqual({ text: "из облака", timestamp: 7 });
    const written = local.set.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written[MIGRATED_KEY], "флаг миграции обязан быть выставлен").toBe(true);
  });
});
