// @vitest-environment jsdom
/**
 * Сторож шторма: он ищет ЦИКЛ «подписчик пишет — наблюдатель будит
 * подписчика». Живой чат Twitch даёт непрерывный поток мутаций в своей же
 * панели, и сторож латчился на штатной работе — то есть обесценивал себя
 * ровно к моменту, когда понадобится (внешний аудит 28.08.2026).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/env", () => ({
  browser: { runtime: { id: "x" }, storage: { local: { get: vi.fn(), set: vi.fn() } } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from "@core/log";

const stormWarned = (): boolean =>
  vi.mocked(log.warn).mock.calls.some((args) =>
    args.some((a) => String(a).includes("поток мутаций не затихает")),
  );

/** Непрерывный поток мутаций в течение «минуты с лишним». */
async function stream(makeNode: () => HTMLElement, seconds: number): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    const node = makeNode();
    node.appendChild(document.createElement("span"));
    await vi.advanceTimersByTimeAsync(260);
  }
}

let unsub: (() => void) | null = null;
let passes = 0;

/**
 * Свежий экземпляр наблюдателя на каждый тест: он модульный синглтон и
 * переносит время последнего прохода между тестами — с фейковыми часами это
 * откладывало флаш на минуту и делало проверку вакуумной.
 */
async function freshObserver(): Promise<void> {
  vi.resetModules();
  const { onDomChange } = await import("@core/dom");
  passes = 0;
  unsub = onDomChange(() => {
    passes++;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 28, 21, 0, 0));
  window.history.replaceState(null, "", "/game-search");
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

afterEach(() => {
  unsub?.();
  unsub = null;
  vi.useRealTimers();
});

describe("сторож шторма вне игровой комнаты", () => {
  test("наш собственный чат НЕ считается циклом", async () => {
    await freshObserver();
    const panel = document.createElement("div");
    panel.className = "fp-panel twitch-chat-panel";
    document.body.appendChild(panel);
    const messages = document.createElement("div");
    panel.appendChild(messages);
    await stream(() => messages, 70);
    expect(passes, "проходы наблюдателя реально были — тест не вакуумный").toBeGreaterThan(100);
    expect(stormWarned(), "штатная работа чата не должна поднимать тревогу").toBe(false);
  });

  test("а поток в чужой разметке — считается", async () => {
    await freshObserver();
    const host = document.createElement("div");
    document.body.appendChild(host);
    await stream(() => host, 70);
    expect(passes, "проходы наблюдателя реально были").toBeGreaterThan(100);
    expect(stormWarned(), "настоящий цикл обязан быть виден").toBe(true);
  });
});

describe("пауза проходов на время жеста", () => {
  test("во время перетаскивания подписчики молчат, после — один проход", async () => {
    // Покадровые записи style при drag будили ВСЕХ подписчиков четыре раза
    // в секунду всё время жеста (внешний аудит 28.08.2026).
    vi.resetModules();
    const { onDomChange, suspendDomPasses } = await import("@core/dom");
    let passes = 0;
    const off = onDomChange(() => {
      passes++;
    });
    const host = document.createElement("div");
    document.body.appendChild(host);

    suspendDomPasses(true);
    for (let i = 0; i < 20; i++) {
      host.appendChild(document.createElement("span"));
      await vi.advanceTimersByTimeAsync(260);
    }
    expect(passes, "пока человек держит панель — ни одного прохода").toBe(0);

    suspendDomPasses(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(passes, "после отпускания накопленное разобрано").toBeGreaterThan(0);
    expect(passes, "и разобрано ОДНИМ проходом, а не двадцатью").toBeLessThanOrEqual(2);
    off();
  });
});
