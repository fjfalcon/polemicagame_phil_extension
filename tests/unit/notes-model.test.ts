/**
 * Модель заметок: карта, палитра, очередь записи и правила сохранения.
 *
 * Слой выделен 28.08.2026. Здесь живут самые дорогие для пользователя данные,
 * и правила вокруг них копились через потери: блок записи при непрочитанном
 * хранилище, откат памяти под состояние диска, очередь «одна запись за раз»,
 * честное «сохранено не полностью». Раньше всё это проверялось только через
 * DOM целого стола.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadResult: { notes: {} as Record<string, unknown>, customTags: [] as string[], loadFailed: false },
  coordinator: null as null | ((msg: unknown) => unknown),
  savedMaps: [] as Record<string, unknown>[],
  saveOk: true,
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
    runtime: { id: "x" },
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));
vi.mock("@core/messaging", () => ({
  sendRuntime: vi.fn(async (msg: unknown) => h.coordinator?.(msg)),
}));
vi.mock("@core/notes-store", async (importOriginal) => {
  // Настоящие чистые функции (ключи, нормализация) — мокаем только ввод-вывод.
  const real = await importOriginal<typeof import("@core/notes-store")>();
  return {
    ...real,
    loadNotes: vi.fn(async () => h.loadResult),
    saveNotes: vi.fn(async (map: Record<string, unknown>) => {
      h.savedMaps.push(map);
      return h.saveOk;
    }),
    saveCustomTags: vi.fn(async () => true),
  };
});

import { showToast } from "@core/toast";
import { NotesModel } from "@content/features/player-notes/notes-model";

const signals = {
  colors: 0,
  indicators: 0,
  tags: 0,
  tooltips: 0,
  toasts: [] as string[],
};

function make(ids: Record<string, number | string> = {}): NotesModel {
  return new NotesModel({
    isActive: () => true,
    onColorsChanged: () => signals.colors++,
    onIndicatorsChanged: () => signals.indicators++,
    onTagsChanged: () => signals.tags++,
    onTooltipsChanged: () => signals.tooltips++,
    onPlayerTooltips: () => undefined,
    toast: (m) => signals.toasts.push(m),
    lookupId: (lower) => ids[lower],
  });
}

beforeEach(() => {
  h.loadResult = { notes: {}, customTags: [], loadFailed: false };
  h.coordinator = null;
  h.savedMaps = [];
  h.saveOk = true;
  Object.assign(signals, { colors: 0, indicators: 0, tags: 0, tooltips: 0 });
  signals.toasts = [];
  vi.clearAllMocks();
});

describe("непрочитанное хранилище блокирует запись", () => {
  test("после сбоя чтения НЕ пишем: иначе пустая карта затрёт заметки", async () => {
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    const m = make();
    await m.load();
    expect(m.isReadOnly).toBe(true);
    expect(await m.saveNotes(["Аня"]), "запись обязана отказать").toBe(false);
    expect(h.savedMaps, "на диск ничего не ушло").toEqual([]);
  });

  test("человеку говорят СРАЗУ, а не когда он нажмёт «Сохранить»", async () => {
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    await make().load();
    expect(vi.mocked(showToast).mock.calls[0]?.[0]).toContain("НЕ удалены");
  });

  test("валидная карта из другой вкладки снимает блок", async () => {
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    const m = make();
    await m.load();
    m.adoptExternalNotes({ Аня: { text: "из соседней вкладки", timestamp: 1 } });
    expect(m.isReadOnly).toBe(false);
    expect(m.keys.text("Аня")).toBe("из соседней вкладки");
  });
});

describe("запись через координатора", () => {
  test("успех подхватывает свежую карту координатора целиком", async () => {
    // Координатор возвращает карту, где ЕСТЬ правка другой вкладки: память
    // обязана принять её целиком, иначе своя запись затрёт чужую.
    h.loadResult = {
      notes: { "u:42": { text: "старая", timestamp: 1 } },
      customTags: [],
      loadFailed: false,
    };
    h.coordinator = () => ({
      ok: true,
      truncated: 0,
      skipped: 0,
      notes: {
        "u:42": { text: "моя правка", timestamp: 5 },
        "u:99": { text: "правка соседней вкладки", timestamp: 6 },
      },
    });
    const m = make({ аня: 42, боря: 99 });
    await m.load();
    expect(await m.setNoteText("u:42", "моя правка")).toBe(true);
    expect(m.keys.text("Аня")).toBe("моя правка");
    expect(m.keys.text("Боря"), "чужая правка не потеряна").toBe("правка соседней вкладки");
  });

  test("обрезка по длине НЕ выдаётся за успех", async () => {
    h.coordinator = () => ({ ok: true, truncated: 1, skipped: 0, notes: {} });
    const m = make();
    await m.setNoteText("Аня", "очень длинная заметка", "Аня");
    expect(vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("не полностью"))).toBe(
      true,
    );
  });

  test("отказ координатора откатывает память под состояние диска", async () => {
    h.coordinator = () => ({ ok: false, truncated: 0, skipped: 0 });
    h.saveOk = false; // фолбэк тоже не смог
    const m = make();
    expect(await m.setNoteText("Аня", "новая", "Аня")).toBe(false);
    expect(m.keys.text("Аня"), "записи не появилось").toBe("");
  });

  test("мёртвый координатор — пишем напрямую, правка не теряется", async () => {
    h.coordinator = () => undefined; // фона нет (старая вкладка после обновления)
    const m = make();
    expect(await m.setNoteText("Аня", "запомнить", "Аня")).toBe(true);
    expect(h.savedMaps.length, "ушло на диск прямой записью").toBe(1);
    expect(m.keys.text("Аня")).toBe("запомнить");
  });
});

describe("очередь записи", () => {
  test("две правки подряд не переплетаются", async () => {
    const order: string[] = [];
    h.coordinator = () => ({ ok: true, truncated: 0, skipped: 0, notes: {} });
    const m = make();
    const first = m.enqueue(async () => {
      order.push("первая начала");
      await new Promise((r) => setTimeout(r, 10));
      order.push("первая кончила");
      return 1;
    });
    const second = m.enqueue(async () => {
      order.push("вторая начала");
      return 2;
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["первая начала", "первая кончила", "вторая начала"]);
  });

  test("упавшая задача не останавливает очередь", async () => {
    const m = make();
    const failed = m.enqueue(async () => {
      throw new Error("сеть");
    });
    await expect(failed).rejects.toThrow("сеть");
    await expect(m.enqueue(async () => "жива")).resolves.toBe("жива");
  });
});

describe("палитра меток", () => {
  test("свой цвет добавляется один раз", () => {
    const m = make();
    m.addCustomTag("#ff0000");
    m.addCustomTag("#ff0000");
    expect(m.customTags).toEqual(["#ff0000"]);
  });

  test("удаление считает, у скольких игроков этот цвет стоит", () => {
    h.loadResult = {
      notes: {
        "u:1": { text: "", timestamp: 1, nickColor: "#ff0000" },
        "u:2": { text: "", timestamp: 1, tag: "#ff0000" },
        "u:3": { text: "", timestamp: 1, nickColor: "#00ff00" },
      },
      customTags: ["#ff0000"],
      loadFailed: false,
    };
    const m = make();
    return m.load().then(() => {
      expect(m.countTagUsages("#ff0000")).toBe(2);
      expect(m.countTagUsages("#123456")).toBe(0);
    });
  });

  test("убранный цвет не воскресает в этой сессии", async () => {
    h.loadResult = { notes: {}, customTags: ["#ff0000"], loadFailed: false };
    const m = make();
    await m.load();
    m.removeCustomTag("#ff0000");
    expect(m.customTags).toEqual([]);
    expect(m.removedThisSession.has("#ff0000")).toBe(true);
  });
});

describe("перерисовка заказывается точечно", () => {
  test("удаление записи трогает и цвета, и метки, и точки, и тултипы", async () => {
    h.loadResult = { notes: { "u:7": { text: "есть", timestamp: 1 } }, customTags: [], loadFailed: false };
    h.coordinator = () => ({ ok: true, truncated: 0, skipped: 0, notes: {} });
    const m = make();
    await m.load();
    await m.deleteEntry("u:7");
    expect(signals).toMatchObject({ colors: 1, indicators: 1, tags: 1, tooltips: 1 });
  });

  test("правка текста трогает точки и тултипы, но не палитру", async () => {
    h.coordinator = () => ({ ok: true, truncated: 0, skipped: 0, notes: {} });
    const m = make();
    await m.setNoteText("Аня", "текст", "Аня");
    expect(signals.indicators).toBe(1);
    expect(signals.tooltips).toBe(1);
    expect(signals.tags, "палитру трогать незачем").toBe(0);
  });
});
