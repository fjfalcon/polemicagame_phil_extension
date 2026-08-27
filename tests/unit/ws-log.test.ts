// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Полный лог общения с сервером.
 *
 * Фича существует ради разбора чужих жалоб, поэтому проверяем в первую
 * очередь не «работает ли запись», а границы: что в файл НЕ попадает
 * (медиа, ключи сессии) и что запись нельзя включить мимо настройки.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock поднимается наверх файла, поэтому фабрика не имеет права трогать
// переменные модуля — состояние храним в самой фабрике и достаём через хук.
vi.mock("@core/env", () => {
  const data = new Map<string, unknown>();
  return {
    browser: {
      runtime: {
        id: "test",
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: vi.fn(async () => undefined),
      },
      storage: {
        local: {
          data,
          get: vi.fn(async (keys: unknown) => (keys === null ? Object.fromEntries(data) : {})),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) data.set(k, v);
          }),
          // Настоящий storage.local.remove принимает и строку, и массив.
          // Мок, знавший только массив, «удалял» строку по буквам и молча
          // ничего не делал — тест валился на исправном коде.
          remove: vi.fn(async (keys: string | string[]) => {
            for (const k of ([] as string[]).concat(keys)) data.delete(k);
          }),
        },
      },
    },
  };
});

const { browser } = await import("@core/env");
const storage = browser.storage.local as unknown as {
  data: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

import {
  MAX_CHUNKS,
  MAX_FRAME_CHARS,
  MAX_TOTAL_CHARS,
  PENDING_MAX_CHARS,
  WS_LOG_PREFIX,
  WS_LOG_TTL_MS,
  clearAll,
  collectAll,
  flushNow,
  formatFrames,
  isGameFrame,
  record,
  resetBuffer,
  startSession,
  finishSession,
  droppedCount,
  sweepStorage,
  sanitizeFrame,
  size,
} from "@core/ws-log";

beforeEach(() => {
  storage.data.clear();
  resetBuffer();
  vi.clearAllMocks();
});

afterEach(() => resetBuffer());

describe("что в лог НЕ попадает", () => {
  test("сигналинг медиа отсекается: Janus шлёт JSON-объект", () => {
    // Кадры движка игры начинаются с цифры (тип пакета engine.io), а
    // сообщения Janus — обычный JSON. Владелец прямо просил не писать
    // камеры и звук: это мегабайты SDP и ICE, бесполезные для разбора игры.
    expect(isGameFrame('42["on_start_pause",{}]')).toBe(true);
    expect(isGameFrame('{"janus":"event","session_id":123}')).toBe(false);
    expect(isGameFrame('[{"sdp":"v=0"}]')).toBe(false);
  });

  test("кадр janus_message игрового сокета — тоже мимо", () => {
    // Медиа ходит и по игровому сокету отдельным событием.
    expect(isGameFrame('42["janus_message",{"jsep":{"sdp":"v=0 очень длинный"}}]')).toBe(false);
  });

  test("двоичные кадры и пустышки не пишутся", () => {
    expect(isGameFrame(new ArrayBuffer(8))).toBe(false);
    expect(isGameFrame("")).toBe(false);
    expect(isGameFrame(null)).toBe(false);
  });

  test("ключ сессии вырезается: он едет в первом же кадре подключения", () => {
    // Файл пересылают в поддержку — authKey в нём был бы находкой для чужого.
    const frame = '42["connect_room",{"userId":13509,"authKey":"s3cr3tvalue123"}]';
    const clean = sanitizeFrame(frame);
    expect(clean).not.toContain("s3cr3tvalue123");
    expect(clean).toContain("authKey");
  });

  test("длинный кадр обрезается и честно об этом говорит", () => {
    const huge = `42["roomState",{"x":"${"я".repeat(MAX_FRAME_CHARS * 2)}"}]`;
    const clean = sanitizeFrame(huge);
    expect(clean.length).toBeLessThan(huge.length);
    expect(clean, "молчаливая обрезка выглядела бы как обрыв протокола").toContain("обрезано");
  });
});

describe("буфер", () => {
  test("чужие кадры не занимают место в буфере", () => {
    expect(record("in", '{"janus":"ack"}')).toBe(false);
    expect(size()).toBe(0);
  });

  test("на диск пишутся КУСКИ, а не весь буфер заново", async () => {
    // Сброс «весь буфер в один ключ» переписывал бы мегабайты каждые пять
    // секунд всю игру. Кусок пишется однажды и больше не трогается.
    const big = `42["roomState",{"x":"${"a".repeat(MAX_FRAME_CHARS)}"}]`;
    for (let i = 0; i < 60; i++) record("in", big);
    await flushNow();
    const written = storage.set.mock.calls.map(c => Object.keys(c[0] as object)[0]);
    expect(new Set(written).size, "каждый сброс — свой ключ").toBe(written.length);
  });

  test("потолок объёма держится удалением самых старых кусков", async () => {
    const big = `42["roomState",{"x":"${"a".repeat(MAX_FRAME_CHARS)}"}]`;
    // Заведомо больше потолка: 700 кадров по 4000 символов ≈ 2.8 млн.
    for (let i = 0; i < 700; i++) record("in", big);
    await flushNow();
    const total = [...storage.data.values()]
      .flatMap(v => (v as { frames?: Array<{ m: string }> }).frames ?? [])
      .reduce((n, f) => n + f.m.length, 0);
    expect(total, "старое обязано вытесняться").toBeLessThanOrEqual(MAX_TOTAL_CHARS + MAX_FRAME_CHARS);
    expect(total, "но что-то остаться должно").toBeGreaterThan(0);
  });

  test("направление кадра видно в файле", () => {
    const text = formatFrames([
      { t: 0, d: "in", m: "от сервера" },
      { t: 1, d: "out", m: "к серверу" },
    ]);
    expect(text).toMatch(/<< от сервера/);
    expect(text).toMatch(/>> к серверу/);
  });
});

describe("PERF26-4: учёт, backpressure, поколение (перф-аудит 26.08.2026)", () => {
  const frame = (chars: number) => "42[\"x\"," + "a".repeat(Math.max(0, chars - 10)) + "]";

  test("чужие куски после startSession входят в общий потолок", async () => {
    // Прошлая сессия оставила полкапа — новой доступна только вторая половина,
    // раньше счётчик стартовал с нуля и суммарно копилось два потолка.
    storage.data.set(`${WS_LOG_PREFIX}old:0`, {
      at: Date.now(),
      frames: [{ t: 1, d: "in", m: "x".repeat(Math.floor(MAX_TOTAL_CHARS / 2)) }],
    });
    await startSession();
    // Пишем свою половину + кусок сверх — вытеснение обязано начаться,
    // хотя СВОЙ storedChars ещё далёк от MAX_TOTAL_CHARS.
    const chunkSize = 200_000;
    const own = Math.ceil(MAX_TOTAL_CHARS / 2 / chunkSize) + 1;
    for (let i = 0; i < own; i++) {
      record("in", frame(3900));
      // добить кусок до порога и сбросить
      for (let j = 0; j < Math.ceil(chunkSize / 3900); j++) record("in", frame(3900));
      await flushNow();
    }
    const totalStored = [...storage.data.entries()]
      .filter(([k]) => k.startsWith(WS_LOG_PREFIX))
      .reduce((n, [, v]) => {
        const fr = (v as { frames: Array<{ m: string }> }).frames;
        return n + fr.reduce((a, f) => a + f.m.length, 0);
      }, 0);
    expect(totalStored, "суммарно — не больше общего потолка (с зазором кусок)").toBeLessThan(
      MAX_TOTAL_CHARS + 220_000,
    );
  });

  test("цепочка записи не растёт бесконечно при висящем хранилище", async () => {
    // Storage завис: первый set никогда не завершается — партии копились бы
    // в замыканиях цепочки без предела (PERF26-4, механизм 2).
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      await gate;
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
    // Каждый цикл переваливает порог куска → авто-flushNow → партия в цепочку.
    const perFrame = MAX_FRAME_CHARS;
    const framesPerChunk = Math.ceil(200_000 / perFrame) + 1;
    const chunksToTry = Math.ceil(PENDING_MAX_CHARS / 200_000) + 3;
    for (let c = 0; c < chunksToTry; c++) {
      for (let i = 0; i < framesPerChunk; i++) record("in", frame(perFrame + 100));
    }
    expect(droppedCount(), "лишние партии отброшены, цепочка ограничена").toBeGreaterThan(0);
    release();
    await flushNow();
    storage.set.mockReset();
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
  });

  test("капельный поток не плодит ключи сверх MAX_CHUNKS", async () => {
    for (let i = 0; i < MAX_CHUNKS + 30; i++) {
      record("in", frame(100));
      await flushNow(); // каждый «5-секундный» сброс — отдельный ключ
    }
    const keys = [...storage.data.keys()].filter((k) => k.startsWith(WS_LOG_PREFIX));
    expect(keys.length).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  test("поколение: выключение во время висящей записи не воскрешает сессию", async () => {
    // Storage «медленный»: задерживаем set вручную.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    storage.set.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await gate;
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
    record("in", frame(500));
    const inflight = flushNow();
    resetBuffer(); // настройку выключили, пока запись стояла
    release();
    await inflight;
    // Кусок прошлой жизни не должен остаться на диске задним числом.
    const keys = [...storage.data.keys()].filter((k) => k.startsWith(WS_LOG_PREFIX));
    expect(keys, "диск чист от прошлой жизни").toEqual([]);
    // Гигиена: gen-гейт мог НЕ израсходовать mockImplementationOnce — съев
    // отказ в соседнем тесте (пойман прогоном всего файла).
    storage.set.mockReset();
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
  });
});

describe("честность лога (ревью 27.08.2026)", () => {
  const frame2 = (chars: number) => "42[\"x\"," + "a".repeat(Math.max(0, chars - 10)) + "]";

  test("clearAll при отказе хранилища возвращает false — тост не соврёт", async () => {
    storage.data.set(`${WS_LOG_PREFIX}x:0`, { at: Date.now(), frames: [] });
    const orig = (browser.storage.local as unknown as { remove: ReturnType<typeof vi.fn> }).remove;
    (browser.storage.local as unknown as { remove: ReturnType<typeof vi.fn> }).remove =
      vi.fn(async () => {
        throw new Error("storage busy");
      });
    try {
      expect(await clearAll()).toBe(false);
    } finally {
      (browser.storage.local as unknown as { remove: unknown }).remove = orig;
    }
    expect(await clearAll(), "исправное хранилище — честное true").toBe(true);
  });

  test("выключение сразу после перегрузки: файл всё равно говорит о потере", async () => {
    // Маркер уезжал только со СЛЕДУЮЩИМ принятым куском — при немедленном
    // выключении экспорт молчал о дропе.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      await gate;
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
    const framesPerChunk = Math.ceil(200_000 / MAX_FRAME_CHARS) + 1;
    for (let c = 0; c < 12; c++) {
      for (let i = 0; i < framesPerChunk; i++) record("in", frame2(MAX_FRAME_CHARS + 100));
    }
    expect(droppedCount(), "перегрузка случилась").toBeGreaterThan(0);
    release();
    storage.set.mockReset();
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
    await finishSession();
    const { dropped } = await collectAll();
    expect(dropped, "число отброшенных доехало до файла").toBeGreaterThan(0);
  });
});

describe("единый признак неполноты (ревью 27.08.2026, п.3)", () => {
  const f = (chars: number) => "42[\"x\"," + "a".repeat(Math.max(0, chars - 10)) + "]";

  test("вытеснение по потолку тоже считается потерей", async () => {
    // Раньше в «dropped» входил только backpressure — файл с вытесненными
    // кусками выглядел полным.
    for (let i = 0; i < MAX_CHUNKS + 5; i++) {
      record("in", f(100));
      await flushNow();
    }
    const { dropped } = await collectAll();
    expect(dropped, "вытесненные кадры признаны потерянными").toBeGreaterThan(0);
  });

  test("отказ записи: и сам кусок, и последующие кадры — потери", async () => {
    storage.set.mockRejectedValue(new Error("QuotaExceededError"));
    record("in", f(200));
    record("in", f(200));
    await flushNow();
    // Лог остановлен: новые кадры физически некуда писать.
    record("in", f(200));
    expect(droppedCount(), "потеряны и партия, и последующие кадры").toBeGreaterThanOrEqual(3);
    storage.set.mockReset();
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
  });

  test("ошибка ЧТЕНИЯ — не «пустой лог», а честный признак", async () => {
    const orig = (browser.storage.local as unknown as { get: ReturnType<typeof vi.fn> }).get;
    (browser.storage.local as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    try {
      const res = await collectAll();
      expect(res.frames).toEqual([]);
      expect(res.readFailed, "UI не должен говорить «лог не включали»").toBe(true);
    } finally {
      (browser.storage.local as unknown as { get: unknown }).get = orig;
    }
  });
});

describe("фича: приём кадров", () => {
  test("сообщения не от зонда игнорируются", async () => {
    const { onProbeMessage } = await import("@content/features/ws-log");
    const fire = (data: unknown, source: unknown = window): void =>
      onProbeMessage({ data, source } as MessageEvent);

    // Чужой источник: страница вольна слать что угодно в своё же окно.
    fire({ source: "злоумышленник", frame: { dir: "in", raw: '42["x",{}]' } });
    // Правильный источник, но сообщение из другого окна (iframe сайта).
    fire({ source: "pn-room-probe", frame: { dir: "in", raw: '42["x",{}]' } }, {});
    expect(size()).toBe(0);

    fire({ source: "pn-room-probe", frame: { dir: "in", raw: '42["x",{}]' } });
    expect(size()).toBe(1);
  });

  test("команда зонду адресуется своему origin", async () => {
    const { commandProbe } = await import("@content/features/ws-log");
    const spy = vi.spyOn(window, "postMessage").mockImplementation((() => {}) as typeof window.postMessage);
    commandProbe(true);
    expect(spy).toHaveBeenCalledWith({ source: "pn-ws-log-cmd", on: true }, location.origin);
    spy.mockRestore();
  });

  test("выключение фичи гасит запись у зонда", async () => {
    const { wsLogFeature } = await import("@content/features/ws-log");
    const spy = vi.spyOn(window, "postMessage").mockImplementation((() => {}) as typeof window.postMessage);
    wsLogFeature.disable();
    expect(spy).toHaveBeenCalledWith({ source: "pn-ws-log-cmd", on: false }, location.origin);
    spy.mockRestore();
  });
});

describe("хранилище", () => {
  test("склейка идёт по времени и только по нашим ключам", async () => {
    storage.data.set(`${WS_LOG_PREFIX}b`, { at: Date.now(), frames: [{ t: 20, d: "in", m: "два" }] });
    storage.data.set(`${WS_LOG_PREFIX}a`, { at: Date.now(), frames: [{ t: 10, d: "in", m: "один" }] });
    storage.data.set("polemica:logs:content-x", { at: Date.now(), frames: [{ t: 5, d: "in", m: "чужое" }] });
    const { frames } = await collectAll();
    expect(frames.map(f => f.m)).toEqual(["один", "два"]);
  });

  test("протухшее не выгружается", async () => {
    storage.data.set(`${WS_LOG_PREFIX}old`, {
      at: Date.now() - WS_LOG_TTL_MS - 1000,
      frames: [{ t: 1, d: "in", m: "вчерашнее" }],
    });
    expect((await collectAll()).frames).toEqual([]);
  });

  test("очистка трогает только свои ключи", async () => {
    storage.data.set(`${WS_LOG_PREFIX}a`, { at: Date.now(), frames: [] });
    storage.data.set("polemica:logs:content-x", { at: Date.now(), entries: [] });
    storage.data.set("notes", { "1": "заметка" });
    await clearAll();
    expect([...storage.data.keys()].sort()).toEqual(["notes", "polemica:logs:content-x"]);
  });

  test("отказ хранилища не роняет выгрузку", async () => {
    storage.get.mockRejectedValueOnce(new Error("QuotaExceeded"));
    // Не роняет — и честно помечает, что пустота от ОТКАЗА, а не «лог пуст»
    // (ревью 27.08.2026, п.3).
    await expect(collectAll()).resolves.toEqual({ frames: [], dropped: 0, readFailed: true });
  });
});

describe("уборка за собой (жалоба 10.08.2026)", () => {
  const chunk = (at: number, chars: number) => ({
    at,
    frames: [{ t: at, d: "in", m: "x".repeat(chars) }],
  });

  test("куски ПРОШЛЫХ сессий удаляются, а не копятся вечно", async () => {
    // Ключи именуются по сессии страницы: своё вытеснение чужие куски не
    // трогало, а срок жизни применялся только при чтении и ничего не удалял.
    // С включённым логом каждый заход оставлял мегабайты навсегда — и
    // хранилище переполнялось вместе с заметками.
    const old = Date.now() - WS_LOG_TTL_MS - 1000;
    storage.data.set(`${WS_LOG_PREFIX}старая:0`, chunk(old, 10));
    storage.data.set(`${WS_LOG_PREFIX}старая:1`, chunk(old, 10));
    storage.data.set("notes", { "u:1": { text: "важное" } });
    await sweepStorage();
    expect([...storage.data.keys()], "чужое не трогаем").toEqual(["notes"]);
  });

  test("потолок объёма — ОБЩИЙ, а не на сессию", async () => {
    const now = Date.now();
    storage.data.set(`${WS_LOG_PREFIX}a:0`, chunk(now - 3000, 100));
    storage.data.set(`${WS_LOG_PREFIX}b:0`, chunk(now - 2000, 100));
    storage.data.set(`${WS_LOG_PREFIX}c:0`, chunk(now - 1000, 100));
    // Бюджет — в СЕРИАЛИЗОВАННЫХ символах (SEC26-3): метрика учёта и уборки
    // одна, размер куска считаем той же функцией, что и код.
    const oneChunk = JSON.stringify(storage.data.get(`${WS_LOG_PREFIX}c:0`)).length;
    const kept = await sweepStorage(oneChunk + 10);
    expect(kept, "оставляем в пределах бюджета").toBeLessThanOrEqual(oneChunk + 10);
    // Свежие дороже старых: остаться должен последний.
    expect([...storage.data.keys()]).toContain(`${WS_LOG_PREFIX}c:0`);
    expect([...storage.data.keys()]).not.toContain(`${WS_LOG_PREFIX}a:0`);
  });

  test("включение фичи прибирает чужое ДО первой записи", async () => {
    // Уборка должна случаться сама, а не только по кнопке в попапе: иначе
    // человек, который просто играет с включённым логом, копит мусор и
    // однажды теряет возможность сохранить заметку.
    const { wsLogFeature } = await import("@content/features/ws-log");
    storage.data.set(`${WS_LOG_PREFIX}прошлая:0`, {
      at: Date.now() - WS_LOG_TTL_MS - 1000,
      frames: [{ t: 1, d: "in", m: "старьё" }],
    });
    const spy = vi.spyOn(window, "postMessage").mockImplementation((() => {}) as typeof window.postMessage);
    wsLogFeature.enable({ settings: {} } as never);
    await vi.waitFor(() => expect(storage.data.has(`${WS_LOG_PREFIX}прошлая:0`)).toBe(false));
    wsLogFeature.disable();
    spy.mockRestore();
  });

  test("битый кусок без кадров тоже убирается", async () => {
    storage.data.set(`${WS_LOG_PREFIX}битый`, { at: Date.now() });
    await sweepStorage();
    expect([...storage.data.keys()]).toHaveLength(0);
  });

  test("отказ записи не мешает заметкам: прибираемся и замолкаем", async () => {
    // В том же хранилище лежат заметки. Если места нет — наше дело уступить,
    // а не долбиться в квоту всю игру.
    resetBuffer();
    storage.set.mockRejectedValue(new Error("QuotaExceededError"));
    record("in", '42["x",{}]');
    await flushNow();
    expect(record("in", '42["y",{}]'), "после отказа больше не пишем").toBe(false);
    storage.set.mockReset();
    storage.set.mockImplementation(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) storage.data.set(k, v);
    });
    resetBuffer();
    expect(record("in", '42["z",{}]'), "новая сессия снова пишет").toBe(true);
  });
});
