import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(), set: vi.fn(async () => undefined) },
      sync: { get: vi.fn() },
    },
  },
}));
vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(async () => ({ ok: true })),
  onMessage: vi.fn(() => () => undefined),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { browser } from "@core/env";
import { sendRuntime } from "@core/messaging";
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
    return loadNotes({ persistMigration: true }).then(({ notes }) => {
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
    const { notes } = await loadNotes({ persistMigration: true });
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
    const { notes } = await loadNotes({ persistMigration: true });
    expect(notes.Bob).toEqual({ text: "из облака", timestamp: 7 });
    const written = local.set.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written[MIGRATED_KEY], "флаг миграции обязан быть выставлен").toBe(true);
  });
});

describe("SEC26-5: запись миграции — только координатор", () => {
  test("обычный load: объединённый ВИД без единой записи + просьба фону", async () => {
    givenStorage(
      { Alice: { text: "локальная", timestamp: 9 } },
      { Bob: { text: "из облака", timestamp: 7 } },
    );
    const { notes } = await loadNotes(); // БЕЗ persistMigration
    // Вид объединён: пользователь видит облачную заметку сразу.
    expect(notes.Bob).toEqual({ text: "из облака", timestamp: 7 });
    expect(notes.Alice).toEqual({ text: "локальная", timestamp: 9 });
    // Но НИ ОДНОЙ записи из этого контекста: снапшот-RMW и была гонка.
    expect(local.set, "запись миграции не из координатора запрещена").not.toHaveBeenCalled();
    // Фон попрошен выполнить перенос сериализованно.
    expect(sendRuntime).toHaveBeenCalledWith({ type: "notes_migrate" });
  });
});
