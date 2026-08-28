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
  /** Что реально лежит «на диске» после ответов координатора. */
  saved: {} as Record<string, unknown>,
  /** Палитра «на диске» — для веток фолбэка (фон не ответил). */
  diskTags: [] as string[],
  /** Чтение диска падает: приватный режим, осиротевший контекст. */
  diskThrows: false,
  /** Что фолбэк реально записал (undefined — не писал). */
  savedTags: undefined as string[] | undefined,
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, unknown>) => {
          if (h.diskThrows) throw new Error("storage недоступен");
          return { ...defaults, tagCustomColors: h.diskTags };
        }),
        set: vi.fn(async () => undefined),
      },
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
    saveCustomTags: vi.fn(async (tags: string[]) => {
      h.savedTags = tags;
      return true;
    }),
    saveNotes: vi.fn(async (map: Record<string, unknown>) => {
      h.savedMaps.push(map);
      return h.saveOk;
    }),
  };
});

import { log } from "@core/log";
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  h.loadResult = { notes: {}, customTags: [], loadFailed: false };
  h.saved = {};
  h.diskTags = [];
  h.diskThrows = false;
  h.savedTags = undefined;
  // Координатор по умолчанию: применяет операции и возвращает свежую карту —
  // как настоящий в background.
  h.coordinator = (msg: unknown) => {
    const ops = (msg as { ops?: Array<{ key: string; record: unknown }> }).ops ?? [];
    for (const op of ops) {
      if (op.record === null) delete h.saved[op.key];
      else h.saved[op.key] = op.record;
    }
    // КОПИЯ, а не сам объект: иначе «диск» и память вкладки — одна ссылка, и
    // мутация памяти выглядела бы записью на диск (adversarial 28.08.2026).
    return { ok: true, truncated: 0, skipped: 0, notes: { ...h.saved } };
  };
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

  test("отказ с обрезкой НЕ говорит «сохранено не полностью»", async () => {
    // При отказе записи это утверждение врёт в другую сторону — будто часть
    // текста уцелела (adversarial 27.08.2026). Мутант «снять гейт res.ok»
    // раньше выживал: тест отказа отдавал нули.
    h.coordinator = () => ({ ok: false, truncated: 3, skipped: 1 });
    h.saveOk = false;
    const m = make();
    await m.setNoteText("Аня", "текст", "Аня");
    expect(
      vi.mocked(showToast).mock.calls.some((c) => String(c[0]).includes("не полностью")),
      "об обрезке при ОТКАЗЕ говорить нельзя",
    ).toBe(false);
  });

  test("отказ отката СУЩЕСТВУЮЩЕЙ записи возвращает прежний текст", async () => {
    // Интерфейс не должен показывать заметку, которой на диске нет.
    h.loadResult = {
      notes: { "u:42": { text: "было на диске", timestamp: 1 } },
      customTags: [],
      loadFailed: false,
    };
    h.coordinator = () => ({ ok: false, truncated: 0, skipped: 0 });
    h.saveOk = false;
    const m = make({ аня: 42 });
    await m.load();
    expect(await m.setNoteText("u:42", "не доехало")).toBe(false);
    expect(m.keys.text("Аня"), "память откатилась под диск").toBe("было на диске");
  });

  test("пустая правка без метки и цвета удаляет запись — не копим пустышки", async () => {
    h.loadResult = { notes: { "u:42": { text: "было", timestamp: 1 } }, customTags: [], loadFailed: false };
    h.saved = { "u:42": { text: "было", timestamp: 1 } };
    const m = make({ аня: 42 });
    await m.load();
    expect(await m.setNoteText("u:42", "")).toBe(true);
    expect("u:42" in h.saved).toBe(false);
  });

  test("успех БЕЗ счётчиков помечается в журнале: полнота не подтверждена", async () => {
    h.coordinator = () => ({ ok: true, notes: {} });
    const m = make();
    await m.setNoteText("Аня", "текст", "Аня");
    expect(
      vi.mocked(log.warn).mock.calls.some((c) => String(c[1]).includes("без счётчиков")),
    ).toBe(true);
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
    await flushMicrotasks();
    expect(m.customTags).toEqual([]);
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

describe("миграция ник → id (единственный автоматический писатель карты)", () => {
  test("заметка переезжает на вечный ключ и ник запоминается в записи", async () => {
    h.loadResult = {
      notes: { Аня: { text: "льёт на первого", timestamp: 100 } },
      customTags: [],
      loadFailed: false,
    };
    const m = make({ аня: 42 });
    await m.load();
    await m.migrateToId("Аня", 42);
    const rec = h.saved["u:42"] as { text: string; nick?: string };
    expect(rec?.text, "текст не потерян").toBe("льёт на первого");
    expect(rec?.nick, "ник сохранён внутри записи").toBe("Аня");
    expect("Аня" in h.saved, "ник-ключ убран").toBe(false);
  });

  test("побеждает СВЕЖАЯ запись; старая по времени не дописывается", async () => {
    h.loadResult = {
      notes: {
        Аня: { text: "старая заметка", timestamp: 100 },
        "u:42": { text: "новая заметка", timestamp: 500 },
      },
      customTags: [],
      loadFailed: false,
    };
    const m = make({ аня: 42 });
    await m.load();
    await m.migrateToId("Аня", 42);
    expect((h.saved["u:42"] as { text: string }).text).toBe("новая заметка");
  });

  test("НИЧЬЯ по времени: текст проигравшей не уничтожается молча, а дописывается", async () => {
    // Обе записи легаси (ts=0) — выбрать «свежую» нечем, и молча выбросить
    // одну из двух заметок про человека нельзя.
    h.loadResult = {
      notes: { Аня: "первый текст", "u:42": "второй текст" },
      customTags: [],
      loadFailed: false,
    };
    const m = make({ аня: 42 });
    await m.load();
    await m.migrateToId("Аня", 42);
    const text = (h.saved["u:42"] as { text: string }).text;
    expect(text).toContain("второй текст");
    expect(text, "проигравший текст сохранён пометкой").toContain("[слито: первый текст]");
  });

  test("цвет и метка с ник-записи НЕ теряются при переезде", async () => {
    // Жалоба: «~50 из 200 раскрашенных ников стали белыми» — цвет наследуется
    // безусловно, даже когда по времени побеждает другая запись.
    h.loadResult = {
      notes: {
        Аня: { text: "", timestamp: 100, nickColor: "#ff0000", tag: "#00ff00" },
        "u:42": { text: "свежая", timestamp: 900 },
      },
      customTags: [],
      loadFailed: false,
    };
    const m = make({ аня: 42 });
    await m.load();
    await m.migrateToId("Аня", 42);
    const rec = h.saved["u:42"] as { nickColor?: string; tag?: string };
    expect(rec.nickColor).toBe("#ff0000");
    expect(rec.tag).toBe("#00ff00");
  });

  test("«Vasya» и «vasya» сливаются в одну запись — оба ник-ключа уходят", async () => {
    h.loadResult = {
      notes: {
        Vasya: { text: "первый", timestamp: 100 },
        vasya: { text: "второй", timestamp: 200 },
      },
      customTags: [],
      loadFailed: false,
    };
    const m = make({ vasya: 7 });
    await m.load();
    await m.migrateToId("Vasya", 7);
    expect(Object.keys(h.saved)).toEqual(["u:7"]);
  });

  test("сбой чтения диска ОТМЕНЯЕТ миграцию: чужую правку затирать нельзя", async () => {
    // Миграция срабатывает с hover'а, без действий пользователя, и пишет
    // карту целиком — работать по устаревшему снимку памяти ей запрещено.
    h.loadResult = { notes: { Аня: { text: "есть", timestamp: 1 } }, customTags: [], loadFailed: false };
    const m = make({ аня: 42 });
    await m.load();
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    await m.migrateToId("Аня", 42);
    expect(h.saved, "на диск ничего не ушло").toEqual({});
  });

  test("мёртвая фича не мигрирует: enable→disable во время hover", async () => {
    h.loadResult = { notes: { Аня: { text: "есть", timestamp: 1 } }, customTags: [], loadFailed: false };
    let alive = true;
    const m = new NotesModel({
      isActive: () => alive,
      onColorsChanged: () => undefined,
      onIndicatorsChanged: () => undefined,
      onTagsChanged: () => undefined,
      onTooltipsChanged: () => undefined,
      onPlayerTooltips: () => undefined,
      toast: () => undefined,
      lookupId: () => 42,
    });
    await m.load();
    alive = false;
    await m.migrateToId("Аня", 42);
    expect(h.saved).toEqual({});
  });

  test("нечего мигрировать — в сеть и на диск не ходим вовсе", async () => {
    h.loadResult = { notes: { "u:42": { text: "уже на месте", timestamp: 1 } }, customTags: [], loadFailed: false };
    const m = make({ аня: 42 });
    await m.load();
    await m.migrateToId("Аня", 42);
    expect(h.saved).toEqual({});
  });
});

describe("цвет ника", () => {
  test.each(["__proto__", "constructor", "prototype", "", "x".repeat(300)])(
    "небезопасный ключ %p не создаёт запись",
    async (badKey) => {
      // Единственный гейт безопасности ключа на content-стороне при ручном
      // вводе игрока в менеджере цветов.
      const m = make();
      expect(await m.setNickColor(badKey, "#ff0000", "Аня")).toBe(false);
      expect(h.saved).toEqual({});
    },
  );

  test("снятие цвета у пустой записи удаляет её целиком — не копим пустышки", async () => {
    h.loadResult = {
      notes: { "u:42": { text: "", timestamp: 1, nickColor: "#ff0000" } },
      customTags: [],
      loadFailed: false,
    };
    h.saved = { "u:42": { text: "", timestamp: 1, nickColor: "#ff0000" } };
    const m = make({ аня: 42 });
    await m.load();
    expect(await m.setNickColor("u:42", "")).toBe(true);
    expect("u:42" in h.saved, "запись удалена").toBe(false);
  });

  test("легаси-строка повышается до записи, текст сохраняется", async () => {
    h.loadResult = { notes: { Аня: "старый текст" }, customTags: [], loadFailed: false };
    const m = make();
    await m.load();
    expect(await m.setNickColor("Аня", "#00ff00")).toBe(true);
    const rec = h.saved["Аня"] as { text: string; nickColor?: string };
    expect(rec.text).toBe("старый текст");
    expect(rec.nickColor).toBe("#00ff00");
  });
});

describe("палитра: интент вместо снимка", () => {
  test("добавление уходит координатору как «добавь этот», а не «вот весь список»", async () => {
    // Палитра НЕпустая: со снимком интент содержал бы оба цвета, и мутация
    // «шлём this.tags целиком» была бы неотличима (adversarial 28.08.2026).
    h.loadResult = { notes: {}, customTags: ["#ff0000"], loadFailed: false };
    const sent: unknown[] = [];
    h.coordinator = (msg) => {
      sent.push(msg);
      return { ok: true, tags: ["#ff0000", "#00ff00"] };
    };
    const m = make();
    await m.load();
    expect(await m.addCustomTag("#00ff00")).toBe(true);
    expect(sent[0]).toMatchObject({ type: "notes_tag_ops", add: ["#00ff00"], remove: [] });
    expect(m.customTags, "принят свежий список координатора — с чужим цветом").toEqual([
      "#ff0000",
      "#00ff00",
    ]);
  });

  test("отказ координатора виден вызывающему: цвет не «сохранён» молча", async () => {
    h.coordinator = () => ({ ok: false, reason: "read_failed" });
    const m = make();
    expect(await m.addCustomTag("#00ff00")).toBe(false);
  });

  test("удаление уходит тем же интентом", async () => {
    const sent: unknown[] = [];
    h.coordinator = (msg) => {
      sent.push(msg);
      return { ok: true, tags: [] };
    };
    const m = make();
    m.removeCustomTag("#ff0000");
    await flushMicrotasks();
    expect(sent[0]).toMatchObject({ type: "notes_tag_ops", add: [], remove: ["#ff0000"] });
  });

  test("блок записи при непрочитанном хранилище распространяется на палитру", async () => {
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    const m = make();
    await m.load();
    let asked = false;
    h.coordinator = () => {
      asked = true;
      return { ok: true, tags: [] };
    };
    expect(await m.addCustomTag("#00ff00")).toBe(false);
    expect(asked, "до координатора дело не дошло").toBe(false);
  });
});

describe("палитра: мёртвый фон и откат памяти", () => {
  test("фон не ответил — пишем сами, прочитав свежий список", async () => {
    h.coordinator = () => undefined; // осиротевшая вкладка после обновления
    h.diskTags = ["#ff0000"];
    const m = make();
    expect(await m.addCustomTag("#00ff00")).toBe(true);
    expect(h.savedTags?.sort(), "чужой цвет с диска сохранён").toEqual(["#00ff00", "#ff0000"]);
  });

  test("фон мёртв И диск не читается — НЕ пишем ничего (fail-safe)", async () => {
    h.coordinator = () => undefined;
    h.diskThrows = true;
    const m = make();
    expect(await m.addCustomTag("#00ff00")).toBe(false);
    expect(h.savedTags, "запись отменена").toBeUndefined();
  });

  test("отказ отката: цвет не остаётся в палитре на экране", async () => {
    h.coordinator = () => ({ ok: false, reason: "read_failed" });
    h.loadResult = { notes: {}, customTags: ["#ff0000"], loadFailed: false };
    const m = make();
    await m.load();
    expect(await m.addCustomTag("#00ff00")).toBe(false);
    expect(m.customTags, "память откатилась под диск").toEqual(["#ff0000"]);
  });

  test("небезопасный цвет мимо фона тоже не проходит", async () => {
    h.coordinator = () => undefined;
    h.diskTags = [];
    const m = make();
    expect(await m.addCustomTag("red;position:fixed;inset:0")).toBe(false);
    expect(h.savedTags, "фолбэк не чёрный ход мимо санитайзера").toBeUndefined();
  });
});

describe("фолбэк заметок при мёртвом фоне", () => {
  test("пишет поверх СВЕЖЕЙ карты с диска, а не снимка памяти", async () => {
    // Асимметрия с палитрой: две вкладки в фолбэке затирали правки друг
    // друга снимками (внешний аудит 28.08.2026).
    h.loadResult = {
      notes: { "u:1": { text: "было в памяти", timestamp: 1 } },
      customTags: [],
      loadFailed: false,
    };
    const m = make({ аня: 42 });
    await m.load();
    // Пока вкладка думала, соседняя записала СВОЮ заметку.
    h.loadResult = {
      notes: {
        "u:1": { text: "было в памяти", timestamp: 1 },
        "u:99": { text: "правка соседней вкладки", timestamp: 5 },
      },
      customTags: [],
      loadFailed: false,
    };
    h.coordinator = () => undefined; // фон мёртв
    expect(await m.setNoteText("u:42", "моя правка", "Аня")).toBe(true);
    const written = h.savedMaps.at(-1) as Record<string, { text: string }>;
    expect(written["u:99"]?.text, "чужая правка не затёрта").toBe("правка соседней вкладки");
    expect(written["u:42"]?.text, "своя правка доехала").toBe("моя правка");
  });

  test("свежая карта не прочиталась — фолбэк отменяется целиком", async () => {
    h.loadResult = { notes: {}, customTags: [], loadFailed: false };
    const m = make();
    await m.load();
    h.coordinator = () => undefined;
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    expect(await m.setNoteText("Аня", "текст", "Аня")).toBe(false);
    expect(h.savedMaps, "на диск ничего не ушло").toEqual([]);
  });
});

describe("готовность карты и палитры — раздельно", () => {
  test("приход заметок из соседней вкладки НЕ разблокирует палитру", async () => {
    // Раньше один флаг отвечал за оба агрегата: валидная карта снимала блок
    // и с палитры, про которую не было известно ничего (внешний аудит
    // 28.08.2026).
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    const m = make();
    await m.load();
    expect(m.isReadOnly).toBe(true);
    expect(m.isPaletteReadOnly).toBe(true);
    m.adoptExternalNotes({ Аня: { text: "из соседней вкладки", timestamp: 1 } });
    expect(m.isReadOnly, "карта прочитана — писать можно").toBe(false);
    expect(m.isPaletteReadOnly, "про палитру всё ещё ничего не известно").toBe(true);
    expect(await m.addCustomTag("#00ff00"), "и запись палитры отказывает").toBe(false);
  });

  test("приход палитры разблокирует именно её", async () => {
    h.loadResult = { notes: {}, customTags: [], loadFailed: true };
    const m = make();
    await m.load();
    m.adoptExternalTags(["#ff0000"]);
    expect(m.isPaletteReadOnly).toBe(false);
    expect(m.isReadOnly, "а карта заметок по-прежнему заблокирована").toBe(true);
  });
});
