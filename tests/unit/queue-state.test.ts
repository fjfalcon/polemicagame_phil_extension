// @vitest-environment jsdom
/**
 * Состояние очередей перед возвратом в поиск.
 *
 * Цифра влияет на решение «идти или подождать», поэтому проверяем, чем она
 * может соврать: выдать отказ сети за пустые очереди, посчитать список
 * участников как одного игрока, показать несуществующую очередь.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchQueueState, formatQueues, parseQueueState } from "@core/queue-state";

describe("разбор ответа", () => {
  test("живой формат сайта читается", () => {
    // Снято с настоящего ответа 09.08.2026.
    const counts = parseQueueState({
      queues: {
        standard: { players: 2, available: false },
        polite: { players: 1, available: false },
        prime: { players: 1, available: false },
      },
    });
    expect(counts).toEqual([
      { mode: "standard", title: "Обычный", players: 2 },
      { mode: "polite", title: "Рейтинг", players: 1 },
      { mode: "prime", title: "Prime", players: 1 },
    ]);
  });

  test("состав очереди считается по длине, а сами игроки наружу не идут", () => {
    // Стоящему в очереди сайт отдаёт список участников вместо числа.
    const counts = parseQueueState({ queues: { standard: { players: [{ id: 1 }, { id: 2 }] } } });
    expect(counts).toEqual([{ mode: "standard", title: "Обычный", players: 2 }]);
    expect(JSON.stringify(counts), "ников и id в выводе быть не должно").not.toContain("id");
  });

  test("мусор не превращается в нули", () => {
    // Ноль читается как «очередь пуста» — утверждение, которого мы не знаем.
    expect(parseQueueState(null)).toBeNull();
    expect(parseQueueState({ queues: {} })).toBeNull();
    expect(parseQueueState({ queues: { standard: { players: "много" } } })).toBeNull();
    expect(parseQueueState({ queues: { standard: { players: -1 } } })).toBeNull();
  });

  test("незнакомая очередь игнорируется, известные остаются", () => {
    const counts = parseQueueState({ queues: { standard: { players: 3 }, secret: { players: 9 } } });
    expect(counts).toEqual([{ mode: "standard", title: "Обычный", players: 3 }]);
  });

  test("строка для показа", () => {
    expect(
      formatQueues([
        { mode: "standard", title: "Обычный", players: 2 },
        { mode: "prime", title: "Prime", players: 0 },
      ]),
    ).toBe("Обычный 2 · Prime 0");
  });
});

describe("сеть", () => {
  test("отказ сервера — это НЕ «очереди пусты»", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    expect(await fetchQueueState()).toBeNull();
    vi.unstubAllGlobals();
  });

  test("обрыв связи не роняет вкладку", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network");
    }));
    await expect(fetchQueueState()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  test("адрес — тот же сервис, что у страницы поиска", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ queues: { standard: { players: 1 } } }) }));
    vi.stubGlobal("fetch", spy);
    await fetchQueueState();
    expect(String(spy.mock.calls[0][0])).toBe("https://game.polemicagame.com/api/search");
    vi.unstubAllGlobals();
  });
});
