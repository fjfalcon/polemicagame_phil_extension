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
  MAX_FRAME_CHARS,
  MAX_TOTAL_CHARS,
  WS_LOG_PREFIX,
  WS_LOG_TTL_MS,
  clearAll,
  collectAll,
  flushNow,
  formatFrames,
  isGameFrame,
  record,
  resetBuffer,
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
    const frames = await collectAll();
    expect(frames.map(f => f.m)).toEqual(["один", "два"]);
  });

  test("протухшее не выгружается", async () => {
    storage.data.set(`${WS_LOG_PREFIX}old`, {
      at: Date.now() - WS_LOG_TTL_MS - 1000,
      frames: [{ t: 1, d: "in", m: "вчерашнее" }],
    });
    expect(await collectAll()).toEqual([]);
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
    await expect(collectAll()).resolves.toEqual([]);
  });
});
