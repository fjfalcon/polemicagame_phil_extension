/**
 * Резолв «ник за столом → запись заметки».
 *
 * Слой выделен из player-notes.ts 28.08.2026 именно ради этих тестов: его
 * ошибка показывает игроку ЧУЖУЮ заметку, а до выделения проверить его можно
 * было только через DOM целого стола. Здесь — прямые проверки, включая
 * блокер 8.1.29 («—» из недоступной статистики уводил всех в общий ключ).
 */
import { describe, expect, test, vi } from "vitest";

// @core/notes-store тянет @core/env (браузерный полифилл) ради работы с
// хранилищем; самому слою ключей хранилище не нужно вовсе.
vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() } }, runtime: { id: "x" } },
}));

import { NoteKeys } from "@content/features/player-notes/note-keys";
import type { NotesMap } from "@core/notes-store";

function keys(notes: NotesMap, ids: Record<string, number | string> = {}): NoteKeys {
  return new NoteKeys({ notes: () => notes, lookupId: (lower) => ids[lower] });
}

describe("id игрока для ключа: белый список, а не чёрный", () => {
  test.each([
    ["—", undefined],
    ["???", undefined],
    ["", undefined],
    ["0", undefined],
    ["12abc", undefined],
    [0, undefined],
    [-5, undefined],
    [3.5, undefined],
    [NaN, undefined],
    [42, 42],
    ["42", "42"],
  ])("id %p → %p", (raw, expected) => {
    expect(keys({}, { аня: raw as number | string }).userId("Аня")).toBe(expected);
  });

  test("плейсхолдеры НЕ сливают разных игроков в один ключ (блокер 8.1.29)", () => {
    // «—» приходит из unavailablePlayerStats, когда рейтинг недоступен: если
    // бы он проходил, все такие игроки писали бы в u:— друг поверх друга.
    const k = keys({}, { аня: "—", боря: "—" });
    expect(k.keyFor("Аня")).toBe("Аня");
    expect(k.keyFor("Боря")).toBe("Боря");
  });
});

describe("выбор ключа", () => {
  test("id известен и запись под id есть — читаем id-ключ", () => {
    const k = keys({ "u:42": { text: "мафия", timestamp: 1, version: "4" } }, { аня: 42 });
    expect(k.keyFor("Аня")).toBe("u:42");
    expect(k.text("Аня")).toBe("мафия");
  });

  test("id известен, но запись пока под НИКОМ — читаем ник (миграция не успела)", () => {
    const k = keys({ Аня: { text: "старая", timestamp: 1, version: "4" } }, { аня: 42 });
    expect(k.keyFor("Аня")).toBe("Аня");
    expect(k.text("Аня")).toBe("старая");
  });

  test("id не резолвлен — запись находится по полю nick внутри id-записи", () => {
    // Игрок, раскрашенный через менеджер (запись сразу на id-ключе), иначе
    // стоял бы белым до резолва id, а со скрытым профилем — вечно.
    const k = keys({ "u:7": { text: "", timestamp: 1, version: "4", nick: "Аня", nickColor: "#f00" } });
    expect(k.keyFor("Аня")).toBe("u:7");
    expect(k.rawNickColor("Аня")).toBe("#f00");
  });

  test("ничего не известно — ключом становится сам ник", () => {
    expect(keys({}).keyFor("Аня")).toBe("Аня");
  });
});

describe("чтение полей записи", () => {
  const notes: NotesMap = {
    "u:42": {
      text: "льёт на первого",
      timestamp: 1,
      version: "4",
      tag: "#ff0000",
      nickColor: "#00ff00",
      nick: "Аня",
      nicks: ["Аня", "Анюта", "аня"],
    },
    Боря: "легаси-строка",
  };

  test("легаси-строка читается как текст, а метки и цвета у неё нет", () => {
    const k = keys(notes);
    expect(k.text("Боря")).toBe("легаси-строка");
    expect(k.tag("Боря")).toBe("");
    expect(k.rawNickColor("Боря")).toBe("");
    expect(k.formerNicks("Боря")).toEqual([]);
  });

  test("прежние ники — без текущего, регистр не важен", () => {
    expect(keys(notes, { аня: 42 }).formerNicks("Аня")).toEqual(["Анюта"]);
  });

  test("нет записи — пустые значения, а не undefined", () => {
    const k = keys({});
    expect(k.text("Некто")).toBe("");
    expect(k.tag("Некто")).toBe("");
    expect(k.formerNicks("Некто")).toEqual([]);
  });

  test("легаси-ключи-ники собираются с учётом регистра", () => {
    const k = keys({ Аня: "a", аня: "b", АНЯ: "c", "u:42": { text: "", timestamp: 1, version: "4" } });
    expect(k.nickKeys("аНя").sort()).toEqual(["АНЯ", "Аня", "аня"]);
  });
});

describe("кэш ник-индекса", () => {
  test("reset() виден сразу — иначе новый состав стола читал бы старые записи", () => {
    const notes: NotesMap = {
      "u:7": { text: "", timestamp: 1, version: "4", nick: "Аня", nickColor: "#f00" },
    };
    const k = keys(notes);
    expect(k.keyFor("Аня")).toBe("u:7"); // индекс построен
    delete notes["u:7"];
    notes["u:9"] = { text: "", timestamp: 2, version: "4", nick: "Аня", nickColor: "#0f0" };
    k.reset();
    expect(k.keyFor("Аня")).toBe("u:9");
  });
});

describe("ключи с прототипа не притворяются заметками", () => {
  test.each(["constructor", "__proto__", "toString", "valueOf"])(
    "игрок с ником %p не читает объект с Object.prototype",
    (nick) => {
      // `map[key]` уходит по цепочке прототипов: до фикса 28.08.2026 такой ник
      // отдавал функцию-конструктор, и она проходила дальше как «запись».
      const k = keys({});
      expect(k.get(nick)).toBeUndefined();
      expect(k.text(nick)).toBe("");
      expect(k.tag(nick)).toBe("");
      expect(k.rawNickColor(nick)).toBe("");
      expect(k.formerNicks(nick)).toEqual([]);
    },
  );

  test("настоящая запись с таким ключом читается как обычно", () => {
    const k = keys({ constructor: { text: "и такое бывает", timestamp: 1, version: "4" } });
    expect(k.text("constructor")).toBe("и такое бывает");
  });
});

describe("обе записи существуют разом (id и ник)", () => {
  test("читаем id-запись: она актуальнее, миграция ещё не отработала", () => {
    // Мутант `||` → `&&` в выборе ключа выживал: этого состояния не было ни в
    // одном тесте (adversarial 28.08.2026).
    const k = keys(
      {
        "u:42": { text: "актуальная", timestamp: 200, version: "4" },
        Аня: { text: "устаревшая", timestamp: 100, version: "4" },
      },
      { аня: 42 },
    );
    expect(k.keyFor("Аня")).toBe("u:42");
    expect(k.text("Аня")).toBe("актуальная");
  });
});
