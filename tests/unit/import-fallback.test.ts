/**
 * Оркестрация фолбэка импорта заметок (ревью 26.08.2026, №2/№3): петля
 * «перечитать → мерж → согласие при росте → перечитать СНОВА → записать».
 * Мутационные стражи: запись мержа, посчитанного ДО диалога, — потеря
 * параллельных правок; пропуск согласия при росте — правки без спроса.
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
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MAX_CONFIRMS, classifyMergeResponse, runCoordinatorImport, runImportFallback } from "@popup/import-fallback";
import type { NotesMap } from "@core/notes-store";

/** Заметка с меткой времени: свежая побеждает существующую (иначе mergeNotes
 *  оставил бы старую и replaced не рос). */
const note = (text: string, timestamp = 2_000_000_000_000) => ({ text, timestamp });
const incoming: NotesMap = { "u:1": note("новая заметка про первого") };

/** Депы с программируемой последовательностью карт на каждое перечитывание. */
function deps(maps: NotesMap[], overrides: Partial<Parameters<typeof runImportFallback>[2]> = {}) {
  let reads = 0;
  const saved: NotesMap[] = [];
  const d = {
    loadNotes: vi.fn(async () => ({ notes: maps[Math.min(reads++, maps.length - 1)] })),
    saveNotes: vi.fn(async (m: NotesMap) => {
      saved.push(m);
      return true;
    }),
    confirmMore: vi.fn(async () => true),
    ...overrides,
  };
  return { d, saved };
}

describe("петля фолбэка импорта", () => {
  test("карта не менялась — одна запись, без лишних вопросов", async () => {
    const { d, saved } = deps([{}]);
    const r = await runImportFallback(incoming, 0, d);
    expect(r).toEqual({ status: "saved", added: 1, replaced: 0, truncated: 0 });
    expect(d.confirmMore).not.toHaveBeenCalled();
    expect(saved[0]["u:1"]).toMatchObject({ text: "новая заметка про первого" });
  });

  test("рост затираемых → согласие → ПЕРЕЧИТАННАЯ карта пишется, не додиалоговая", async () => {
    // Первое чтение: игровая вкладка уже написала u:1 (replaced=1 > 0).
    // Пока пользователь жал «да», она написала ещё и u:2 — второе чтение.
    const first: NotesMap = { "u:1": note("правка вкладки", 1) };
    const second: NotesMap = { "u:1": note("правка вкладки", 1), "u:2": note("свежая заметка вкладки", 1) };
    const { d, saved } = deps([first, second]);
    const r = await runImportFallback(incoming, 0, d);
    expect(d.confirmMore).toHaveBeenCalledWith(1, 0);
    expect(r.status).toBe("saved");
    // Мутант «писать мерж до диалога» терял бы u:2.
    expect(saved[0]["u:2"], "правка за время диалога пережила запись").toMatchObject({
      text: "свежая заметка вкладки",
    });
  });

  test("отказ в диалоге — ничего не записано", async () => {
    const { d, saved } = deps([{ "u:1": note("правка вкладки", 1) }], {
      confirmMore: vi.fn(async () => false),
    });
    const r = await runImportFallback(incoming, 0, d);
    expect(r).toEqual({ status: "cancelled" });
    expect(saved).toHaveLength(0);
  });

  test("карта растёт быстрее согласий — ОТМЕНА, не запись «как получилось»", async () => {
    // Каждое перечитывание приносит новый затираемый ключ.
    const maps: NotesMap[] = Array.from({ length: MAX_CONFIRMS + 2 }, (_, i) => {
      const m: NotesMap = {};
      for (let k = 0; k <= i; k++) m[`u:${k + 1}`] = note(`правка ${k}`, 1);
      return m;
    });
    const grow: NotesMap = {};
    for (let k = 1; k <= MAX_CONFIRMS + 2; k++) grow[`u:${k}`] = note(`импорт ${k}`);
    const { d, saved } = deps(maps);
    const r = await runImportFallback(grow, 0, d);
    // Граница согласия: применить больше одобренного нельзя даже «чуть-чуть»
    // (ревью 26.08.2026, №3). Повтор импорта бесплатен.
    expect(r).toEqual({ status: "unstable" });
    expect(d.confirmMore).toHaveBeenCalledTimes(MAX_CONFIRMS);
    expect(saved, "ничего не записано").toHaveLength(0);
  });

  test("чтение упало — отказ без записи (не пишем поверх непрочитанного)", async () => {
    const { d, saved } = deps([{}], {
      loadNotes: vi.fn(async () => ({ notes: {}, loadFailed: true })),
    });
    const r = await runImportFallback(incoming, 0, d);
    expect(r).toEqual({ status: "read_failed" });
    expect(saved).toHaveLength(0);
  });

  test("запись упала — честный save_failed", async () => {
    const { d } = deps([{}], { saveNotes: vi.fn(async () => false) });
    const r = await runImportFallback(incoming, 0, d);
    expect(r).toEqual({ status: "save_failed" });
  });
});

describe("петля согласия координаторного пути", () => {
  const exceeded = (replaced: number) =>
    ({ ok: false, reason: "consent_exceeded", replaced }) as const;

  test("consent_exceeded → согласие → ретрай с НОВЫМ пределом", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(exceeded(5))
      .mockResolvedValueOnce({ ok: true, added: 1, replaced: 5 });
    const r = await runCoordinatorImport(0, { merge, confirmMore: vi.fn(async () => true) });
    expect(merge).toHaveBeenNthCalledWith(1, 0);
    expect(merge).toHaveBeenNthCalledWith(2, 5);
    expect(r).toMatchObject({ status: "done", approved: 5 });
  });

  test("отказ пользователя — cancelled, повторного merge нет", async () => {
    const merge = vi.fn().mockResolvedValue(exceeded(5));
    const r = await runCoordinatorImport(0, { merge, confirmMore: vi.fn(async () => false) });
    expect(r).toEqual({ status: "cancelled" });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  test("рост быстрее MAX_CONFIRMS согласий — unstable", async () => {
    let n = 0;
    const merge = vi.fn(async () => exceeded(++n * 10));
    const confirmMore = vi.fn(async () => true);
    const r = await runCoordinatorImport(0, { merge, confirmMore });
    expect(r).toEqual({ status: "unstable" });
    expect(confirmMore).toHaveBeenCalledTimes(MAX_CONFIRMS);
  });

  test("фон молчит/невнятен — done с итоговым approved (фолбэку нужен ИМЕННО он)", async () => {
    const merge = vi
      .fn()
      .mockResolvedValueOnce(exceeded(7))
      .mockResolvedValueOnce(undefined);
    const r = await runCoordinatorImport(0, { merge, confirmMore: vi.fn(async () => true) });
    // Мутант «вернуть додиалоговый baseline» заставлял бы фолбэк
    // переспрашивать уже одобренное (adversarial 26.08.2026, №5).
    expect(r).toEqual({ status: "done", applied: undefined, approved: 7 });
  });
});

describe("классификация ответа координатора (fail-closed, шестая волна)", () => {
  test("успех — строгий ok:true СО СЧЁТЧИКАМИ (ревью 27.08.2026)", () => {
    expect(
      classifyMergeResponse({ ok: true, added: 0, replaced: 0, truncated: 0, skipped: 0 }),
    ).toBe("success");
    expect(
      classifyMergeResponse({ ok: true, added: 3, replaced: 1, truncated: 2, skipped: 1 }),
    ).toBe("success");
    // Без счётчиков — не успех: именно такой ответ прикрывал обрезку.
    expect(classifyMergeResponse({ ok: true, added: 3, replaced: 1 })).toBe("refused");
  });
  test("malformed НЕ уходит ни в успех, ни в прямую запись — отказ", () => {
    for (const bad of [
      {},
      { ok: "true" },
      { ok: 1 },
      { ok: true }, // без чисел
      { ok: true, added: Number.NaN, replaced: 0 },
      { ok: true, added: -1, replaced: 0 },
      { ok: false },
    ]) {
      expect(classifyMergeResponse(bad as never)).toBe("refused");
    }
  });
  test("фолбэк — только на мёртвый фон; read_failed — свой класс", () => {
    expect(classifyMergeResponse(undefined)).toBe("dead");
    expect(classifyMergeResponse({ ok: false, reason: "read_failed" })).toBe("read_failed");
  });
  test("consent_exceeded с мусорным replaced не рождает диалог с мусором", async () => {
    const merge = vi.fn().mockResolvedValue({ ok: false, reason: "consent_exceeded", replaced: Number.NaN });
    const confirmMore = vi.fn(async () => true);
    const r = await runCoordinatorImport(0, { merge, confirmMore });
    expect(confirmMore, "диалога не было").not.toHaveBeenCalled();
    expect(r.status).toBe("done");
    expect(classifyMergeResponse((r as { applied?: never }).applied)).toBe("refused");
  });
});

describe("фолбэк не режет СВОЮ заметку (adversarial 27.08, HIGH-1)", () => {
  test("12 000 символов переживают запись через фолбэк, truncated честен", async () => {
    const long = "я".repeat(12_000);
    const { d, saved } = deps([{}]);
    const r = await runImportFallback({ "u:1": note(long) } as NotesMap, 0, d);
    expect(r).toMatchObject({ status: "saved", truncated: 0 });
    expect((saved[0]["u:1"] as { text: string }).text, "хвост не обрезан").toHaveLength(12_000);
  });

  test("сверхдлинное режется — и об этом сообщают наверх", async () => {
    const huge = "я".repeat(30_000);
    const { d, saved } = deps([{}]);
    const r = await runImportFallback({ "u:1": note(huge) } as NotesMap, 0, d);
    expect(r).toMatchObject({ status: "saved", truncated: 1 });
    expect((saved[0]["u:1"] as { text: string }).text.length).toBeLessThan(30_000);
  });
});
