import { beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  failSet: false,
  failGet: false,
}));

vi.mock("@core/env", () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (arg: unknown) => {
          if (store.failGet) throw new Error("quota exceeded");
          if (arg === null) return { ...store.data };
          const keys = typeof arg === "string" ? [arg] : Object.keys(arg as object);
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in store.data) out[k] = store.data[k];
          return out;
        }),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          // Модель исчерпанной квоты: большая запись журнала падает, а
          // крошечная отметка о сбое проходит — на этом и держится LOG-1.
          const isTinyMarker = Object.keys(patch).every((k) => k.endsWith(":health"));
          if (store.failSet && !isTinyMarker) throw new Error("quota exceeded");
          Object.assign(store.data, patch);
        }),
        remove: vi.fn(async () => undefined),
      },
    },
  },
}));

import { log } from "@core/log";

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  store.failSet = false;
  store.failGet = false;
  // Состояние логгера модульное и переживает тесты: без сброса проверки
  // проходили бы по инерции предыдущего сбоя (поймано мутацией).
  await log.clearAll();
  store.data = {};
});

describe("здоровье журнала (LOG-1)", () => {
  test("исправный журнал объявляется полным", async () => {
    log.info("test", "строка");
    log.flushNow();
    await vi.waitFor(() => expect(store.data).not.toEqual({}));
    expect(log.isComplete()).toBe(true);
    const entries = await log.collectAll();
    expect(entries.some((e) => e.m.includes("НЕ ПОЛНОСТЬЮ"))).toBe(false);
  });

  test("упавшая запись помечает журнал неполным и добавляет строку в экспорт", async () => {
    // Раньше исключение глоталось молча: пользователь выгружал почти пустой
    // файл и принимал его за полный журнал, а поддержка делала по нему выводы.
    store.failSet = true;
    log.error("test", "важная ошибка");
    log.flushNow();
    await vi.waitFor(() => expect(log.isComplete()).toBe(false));

    const entries = await log.collectAll();
    const note = entries.filter((e) => e.m.includes("НЕ ПОЛНОСТЬЮ"));
    expect(note, "пометка о неполноте обязана быть ровно одна").toHaveLength(1);
    expect(note[0].l).toBe("error");

    // О самом сбое сообщаем в консоль, а не через log.*. Проверяем именно
    // ОТСУТСТВИЕ записи: log.error("log", …) тоже напечатал бы в консоль
    // «[polemica:log] …», но при этом закольцевался бы —
    // record → flush падает → reportStorageFailure → record → … (ревью).
    expect(
      log.getBuffer().some((e) => e.s === "log"),
      "логгер не имеет права сообщать о своей поломке через самого себя",
    ).toBe(false);
    expect(
      vi.mocked(console.error).mock.calls.some((a) => String(a[0]).includes("polemica:log")),
    ).toBe(true);
  });

  test("сбой оставляет отметку в хранилище, а не только в памяти", async () => {
    store.failSet = true;
    log.info("test", "строка");
    log.flushNow();
    await vi.waitFor(() =>
      expect(store.data["polemica:logs:health"], "отметка нужна другим контекстам").toBeDefined(),
    );
  });

  test("отметку о сбое видит ДРУГОЙ контекст (её оставила игровая вкладка)", async () => {
    // Файл собирает попап, а отказ записи случается прежде всего в игровой
    // вкладке — там объём. Без общей отметки попап печатал бы «complete: yes»
    // ровно в том случае, ради которого пометка и заводилась.
    expect(log.isComplete(), "предусловие: свой контекст здоров").toBe(true);
    store.data["polemica:logs:health"] = { ctx: "content#a1b2", at: Date.now(), operation: "flush" };
    const entries = await log.collectAll();
    expect(log.isComplete()).toBe(false);
    expect(entries.some((e) => e.m.includes("НЕ ПОЛНОСТЬЮ"))).toBe(true);
    // Служебный ключ не должен попасть в экспорт мусорной строкой.
    expect(entries.every((e) => typeof e.m === "string")).toBe(true);
  });

  test("провернувшееся кольцо не «выздоравливает» от удачной записи", async () => {
    // Транзиентный сбой самоизлечим: строки остаются в буфере и доедут
    // следующим flush. Но если за это время кольцо (600 записей) провернулось,
    // ранние строки потеряны безвозвратно — и журнал полным уже не станет.
    store.failSet = true;
    log.info("test", "первая — она и потеряется");
    log.flushNow();
    await vi.waitFor(() => expect(log.isComplete()).toBe(false));

    for (let i = 0; i < 700; i++) log.info("test", `строка ${i}`);
    store.failSet = false;
    log.flushNow();
    await vi.waitFor(() => expect(store.data).not.toEqual({}));
    expect(log.isComplete(), "часть строк потеряна — журнал неполон").toBe(false);
  });

  test("вчерашний сбой не клеймит сегодняшний журнал", async () => {
    // Без срока жизни один случайный сбой ночью навсегда пометил бы КАЖДЫЙ
    // будущий экспорт как неполный — и признак перестали бы читать ровно
    // тогда, когда он настоящий (ревью 02.08.2026). Логи content живут сутки.
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    store.data["polemica:logs:health"] = { ctx: "content#a1b2", at: twoDaysAgo, operation: "flush" };
    const entries = await log.collectAll();
    expect(log.isComplete()).toBe(true);
    expect(entries.some((e) => e.m.includes("НЕ ПОЛНОСТЬЮ"))).toBe(false);
  });

  test("очистка логов возвращает журналу здоровье", async () => {
    store.failSet = true;
    log.info("test", "строка");
    log.flushNow();
    await vi.waitFor(() => expect(log.isComplete()).toBe(false));
    store.failSet = false;
    await log.clearAll();
    expect(log.isComplete()).toBe(true);
  });
});

describe("метка документа в контексте (LOG-2)", () => {
  test("строки content помечены сессией документа", () => {
    // Строки двух одновременно открытых игр иначе неразличимы в экспорте.
    // В node-окружении контекст не content — проверяем сам факт наличия метки.
    log.info("test", "строка");
    expect(log.getBuffer().at(-1)!.c).toMatch(/^(content#\w+|bg|popup|ext)$/);
  });
});

describe("чистка секретов на стоке (LOG-3)", () => {
  test("секрет из произвольного вызова не доезжает до хранилища", async () => {
    // Раньше redactSecrets надо было звать руками, и безопасность строки
    // зависела от того, вспомнил ли о нём автор.
    log.info("test", "ответ сервера: obs_password=hunter2secret");
    const entries = log.getBuffer();
    const line = entries.at(-1)!.m;
    expect(line).not.toContain("hunter2secret");
    expect(line).toContain("…");
  });
});
