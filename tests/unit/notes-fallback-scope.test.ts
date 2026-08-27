/**
 * Прямая запись заметок при недоступном координаторе (ревью 27.08.2026).
 *
 * Правило: аварийный путь нормализует ТОЛЬКО затронутые записи. Полная
 * нормализация карты означала бы, что правка одного игрока обрезает чужую
 * давнюю длинную заметку — тихая порча данных, которую никто не заметит.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: "test" },
  },
}));
vi.mock("@core/log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@core/messaging", () => ({ sendRuntime: vi.fn(async () => undefined), onMessage: vi.fn(() => () => undefined) }));
import { MAX_OWN_NOTE_TEXT, normalizeNoteRecord, type NotesMap } from "@core/notes-store";

/** Тот же алгоритм, что в player-notes.commitNoteOps (фолбэк-ветка). */
function fallbackMap(raw: NotesMap, touchedKeys: string[]): NotesMap {
  const touched = new Set(touchedKeys);
  const map: NotesMap = { ...raw };
  for (const key of touched) {
    const note = map[key];
    if (note === undefined) continue;
    const safe = normalizeNoteRecord(note, MAX_OWN_NOTE_TEXT);
    if (!safe) {
      delete map[key];
      continue;
    }
    map[key] = safe;
  }
  return map;
}

describe("фолбэк трогает только затронутые записи", () => {
  test("чужая длинная заметка не режется при сохранении другой", () => {
    const huge = "я".repeat(MAX_OWN_NOTE_TEXT + 5_000); // легаси-запись с диска
    const before: NotesMap = {
      "u:1": { text: huge, timestamp: 1 },
      "u:2": { text: "правим этого", timestamp: 2 },
    };
    const after = fallbackMap(before, ["u:2"]);
    expect((after["u:1"] as { text: string }).text, "чужая запись нетронута").toHaveLength(
      huge.length,
    );
    expect(after["u:2"]).toBeTruthy();
  });

  test("затронутая запись нормализуется (потолок применяется к ней)", () => {
    const huge = "я".repeat(MAX_OWN_NOTE_TEXT + 5_000);
    const after = fallbackMap({ "u:1": { text: huge, timestamp: 1 } }, ["u:1"]);
    expect((after["u:1"] as { text: string }).text.length).toBe(MAX_OWN_NOTE_TEXT);
  });

  test("негодная затронутая запись удаляется, соседи целы", () => {
    const after = fallbackMap(
      { "u:1": { text: "живая", timestamp: 1 }, "u:2": { text: 42 } as never },
      ["u:2"],
    );
    expect(after["u:2"], "битую не пишем").toBeUndefined();
    expect(after["u:1"]).toBeTruthy();
  });
});
