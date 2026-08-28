import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  notes: {} as Record<string, unknown>,
  /** Палитра «на диске» — общая для всех вкладок, как настоящая. */
  tags: [] as string[],
  readFailed: false,
  saves: 0,
  tagSaves: 0,
  tagSaveOk: true,
  /** Сколько задач координатора выполняется ПРЯМО СЕЙЧАС. */
  inFlight: 0,
  /** Промис, на котором «зависает» чтение (эмуляция усыплённого воркера). */
  hang: null as Promise<void> | null,
  /** Зафиксировано ли наложение двух задач (доказательство разных очередей). */
  overlapped: false,
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: { get: vi.fn(async () => ({ pn_notes_migrated_v1: true })), set: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})) },
    },
    runtime: { id: "test" },
  },
}));
// Чистые функции берём НАСТОЯЩИЕ (ревью 27.08.2026): самодельные заглушки
// уже дважды скрывали проверяемый путь — normalizeNoteRecord пропускал битую
// запись, isSafeNoteKey пускал constructor/prototype.
vi.mock("@core/notes-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@core/notes-store")>();
  return {
    ...real,
    // loadNotes/saveNotes остаются управляемыми — это ввод-вывод теста.
    loadNotes: vi.fn(async () => {
      // Вход в критическую секцию: если сюда попали двое разом — очередей
      // больше одной, и обещание координатора не выполняется.
      state.inFlight++;
      if (state.inFlight > 1) state.overlapped = true;
      if (state.hang) await state.hang;
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight--;
      return state.readFailed
        ? { notes: {}, customTags: [], loadFailed: true }
        : { notes: state.notes, customTags: state.tags };
    }),
    saveCustomTags: vi.fn(async (tags: string[]) => {
      // Пауза между чтением и записью — то самое окно, в котором вкладки
      // затирали цвета друг друга.
      await Promise.resolve();
      if (!state.tagSaveOk) return false;
      state.tags = tags;
      state.tagSaves++;
      return true;
    }),
    saveNotes: vi.fn(async (notes: Record<string, unknown>) => {
      await Promise.resolve();
      state.notes = notes;
      state.saves++;
      return true;
    }),
  };
});
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyNoteOps, applyTagOps, mergeNotesViaCoordinator } from "../../src/background/notes-coordinator";

beforeEach(() => {
  state.notes = {};
  state.tags = [];
  state.readFailed = false;
  state.saves = 0;
  state.tagSaves = 0;
  state.tagSaveOk = true;
  state.inFlight = 0;
  state.overlapped = false;
  state.hang = null;
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

  test("успех НЕ прячет потерю: счётчики едут наверх (ревью 27.08.2026)", async () => {
    const res = await applyNoteOps([
      { key: "u:1", record: { text: "норм", timestamp: 1 } },
      { key: "__proto__", record: { text: "опасный ключ", timestamp: 1 } },
      { key: "u:2", record: { text: 12345 } as never },
    ]);
    expect(res.ok).toBe(true);
    expect(res.skipped, "опасный ключ и битая запись — потери").toBe(2);
    expect(res.truncated).toBe(0);
  });

  test("граница согласия: замен больше одобренного — consent_exceeded БЕЗ записи", async () => {
    // Ревью 26.08.2026: цифры диалога считались по снимку попапа, а карта у
    // координатора свежая — писать больше одобренного нельзя молча.
    state.notes = { "u:1": { text: "старая", timestamp: 1 }, "u:2": { text: "тоже", timestamp: 1 } };
    const result = await mergeNotesViaCoordinator(
      { "u:1": { text: "новая", timestamp: 9 }, "u:2": { text: "новее", timestamp: 9 } },
      1, // пользователь одобрил ОДНУ замену, реально будет две
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("consent_exceeded");
    expect(result.replaced, "свежие числа для нового вопроса").toBe(2);
    expect(state.saves, "ничего не записано").toBe(0);
  });

  test("замен ровно в пределах одобренного — пишем как обычно", async () => {
    state.notes = { "u:1": { text: "старая", timestamp: 1 } };
    const result = await mergeNotesViaCoordinator({ "u:1": { text: "новая", timestamp: 9 } }, 1);
    expect(result.ok).toBe(true);
    expect(state.saves).toBe(1);
  });

  test("FAIL-CLOSED: без предела согласия мерж не выполняется (bad_request)", async () => {
    // Шестая волна 26.08.2026: отсутствующий/битый предел раньше молча
    // выключал границу согласия — теперь это отказ без записи.
    state.notes = { "u:1": { text: "старая", timestamp: 1 } };
    for (const bad of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const result = await mergeNotesViaCoordinator({ "u:1": { text: "новая", timestamp: 9 } }, bad as never);
      expect(result).toEqual({ ok: false, reason: "bad_request" });
    }
    expect(state.saves, "ни одной записи").toBe(0);
  });
});

describe("палитра: правки интентом, а не снимком", () => {
  test("две вкладки добавляют РАЗНЫЕ цвета одновременно — оба выживают", async () => {
    // Раньше вкладка присылала весь массив: обе читали [красный], строили
    // [красный, свой] и вторая затирала первую (внешний аудит 28.08.2026).
    state.tags = ["#ff0000"];
    await Promise.all([applyTagOps(["#0000ff"], []), applyTagOps(["#00ff00"], [])]);
    expect(state.tags.sort()).toEqual(["#0000ff", "#00ff00", "#ff0000"]);
  });

  test("удаление в одной вкладке не воскресает из снимка другой", async () => {
    state.tags = ["#ff0000", "#00ff00"];
    await Promise.all([applyTagOps([], ["#ff0000"]), applyTagOps(["#0000ff"], [])]);
    expect(state.tags).not.toContain("#ff0000");
    expect(state.tags.sort()).toEqual(["#0000ff", "#00ff00"]);
  });

  test("нечитаемое состояние — ОТКАЗ, а не запись поверх неизвестного", async () => {
    state.tags = ["#ff0000"];
    state.readFailed = true;
    const res = await applyTagOps(["#0000ff"], []);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("read_failed");
    expect(state.tagSaves, "на диск не ходили вовсе").toBe(0);
    expect(state.tags, "чужие цвета целы").toEqual(["#ff0000"]);
  });

  test("небезопасный цвет не попадает в палитру", async () => {
    // url(...)/expression в CSS-значении — то, ради чего заведён isSafeTag.
    await applyTagOps(["url(javascript:alert(1))", "#00ff00", 42 as unknown as string], []);
    expect(state.tags).toEqual(["#00ff00"]);
  });

  test("пустой интент не трогает диск", async () => {
    state.tags = ["#ff0000"];
    const res = await applyTagOps([], []);
    expect(res.ok).toBe(true);
    expect(state.tagSaves).toBe(0);
  });

  test("ответ содержит свежий список — вкладка принимает его целиком", async () => {
    state.tags = ["#ff0000"];
    const res = await applyTagOps(["#0000ff"], []);
    expect(res.tags?.sort()).toEqual(["#0000ff", "#ff0000"]);
  });
});

describe("палитра: очередь и отказы", () => {
  test("операции тегов и заметок живут в ОДНОЙ очереди", async () => {
    // «Единственная очередь на браузер» — обещание шапки координатора. Без
    // теста мутант «завести отдельную очередь для тегов» проходил незаметно,
    // а цена его настоящая: обе задачи зовут loadNotes({persistMigration}),
    // то есть две очереди = две одновременные миграции sync→local
    // (adversarial 28.08.2026).
    const order: string[] = [];
    await Promise.all([
      applyTagOps(["#00ff00"], []).then(() => order.push("теги")),
      applyNoteOps([{ key: "Аня", record: { text: "заметка", timestamp: 1 } }]).then(() =>
        order.push("заметки"),
      ),
      applyTagOps(["#0000ff"], []).then(() => order.push("теги2")),
    ]);
    expect(state.overlapped, "две задачи координатора выполнялись ОДНОВРЕМЕННО").toBe(false);
    expect(order, "порядок сохранён очередью").toEqual(["теги", "заметки", "теги2"]);
    expect(state.tags.sort(), "обе правки палитры доехали").toEqual(["#0000ff", "#00ff00"]);
  });

  test("легаси-цвет с диска удаляется, даже если он небезопасен", async () => {
    // Удаление по МЯГКОМУ правилу — симметрия с ключами заметок: строгий
    // фильтр делал бы такую запись неудаляемой («удалил, а она вернулась»).
    state.tags = ["url(javascript:alert(1))", "#00ff00"];
    const res = await applyTagOps([], ["url(javascript:alert(1))"]);
    expect(res.ok).toBe(true);
    expect(state.tags).toEqual(["#00ff00"]);
  });

  test("небезопасный цвет с диска не переживает запись палитры", async () => {
    // Список уезжает на диск целиком — это единственная точка, где можно
    // просеять то, что доехало со старой версии.
    state.tags = ["red;position:fixed", "#00ff00"];
    await applyTagOps(["#0000ff"], []);
    expect(state.tags.sort()).toEqual(["#00ff00", "#0000ff"].sort());
  });

  test("провал записи не выдаётся за успех", async () => {
    state.tagSaveOk = false;
    const res = await applyTagOps(["#00ff00"], []);
    expect(res.ok).toBe(false);
    expect(res.tags, "списка при отказе нет").toBeUndefined();
  });

  test("дубликат не удваивает цвет в палитре", async () => {
    state.tags = ["#00ff00"];
    await applyTagOps(["#00ff00"], []);
    expect(state.tags).toEqual(["#00ff00"]);
  });

  test("палитра не растёт бесконечно: потолок тот же, что у импорта", async () => {
    state.tags = Array.from({ length: 100 }, (_, i) => `#${String(i).padStart(6, "0")}`);
    const res = await applyTagOps(["#abcdef"], []);
    expect(state.tags.length).toBe(100);
    expect(res.dropped, "о потере сказано вслух").toBe(1);
  });
});

describe("очередь: сериализация важнее отзывчивости", () => {
  test("медленная задача ДЕРЖИТ очередь — следующая не начинается", async () => {
    // Таймаут здесь пробовали 28.08.2026 и сняли: промис отклонить можно, а
    // задачу отменить нельзя — она доходит до своей записи, и вторая задача
    // писала поверх живой первой. Свойство «одна запись за раз» дороже
    // отзывчивости (adversarial: проверено затиранием чужой правки).
    let release: () => void = () => undefined;
    state.hang = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    const slow = applyTagOps(["#00ff00"], []).then(() => order.push("медленная"));
    const next = applyNoteOps([{ key: "Аня", record: { text: "после", timestamp: 1 } }]).then(
      () => order.push("следующая"),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(order, "пока первая висит, вторая НЕ выполнилась").toEqual([]);
    state.hang = null;
    release();
    await Promise.all([slow, next]);
    expect(order).toEqual(["медленная", "следующая"]);
    expect(state.overlapped, "и они не пересеклись во времени").toBe(false);
  });
});
