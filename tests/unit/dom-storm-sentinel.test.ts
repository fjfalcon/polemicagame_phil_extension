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
    const { registerOwnContainer } = await import("@core/dom");
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    registerOwnContainer(panel);
    const messages = document.createElement("div");
    panel.appendChild(messages);
    // Сама вставка панели в body — ЧУЖАЯ мутация: даём ей уйти и считаем с нуля.
    await vi.advanceTimersByTimeAsync(300);
    passes = 0;
    await stream(() => messages, 70);
    expect(passes, "своя работа подписчиков не будит вовсе").toBe(0);
    expect(stormWarned(), "и тревогу не поднимает").toBe(false);
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

describe("свои записи не будят подписчиков", () => {
  test("мутации внутри нашей панели проходов не вызывают, чужие — вызывают", async () => {
    // Перетаскивание панели пишет style покадрово, чат дорисовывает строки —
    // раньше это будило ВСЕХ подписчиков четыре раза в секунду. Пауза на
    // время жеста оказалась опаснее проблемы (незакрытый жест = слепота до
    // F5, adversarial 28.08.2026), поэтому фильтруем сами записи.
    vi.resetModules();
    const { onDomChange, registerOwnContainer } = await import("@core/dom");
    passes = 0;
    const off = onDomChange(() => {
      passes++;
    });
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    registerOwnContainer(panel);
    await vi.advanceTimersByTimeAsync(300);
    passes = 0;

    for (let i = 0; i < 20; i++) {
      panel.appendChild(document.createElement("span"));
      panel.style.left = `${i}px`;
      await vi.advanceTimersByTimeAsync(260);
    }
    expect(passes, "своя работа подписчиков не будит").toBe(0);

    const foreign = document.createElement("div");
    document.body.appendChild(foreign);
    await vi.advanceTimersByTimeAsync(300);
    expect(passes, "а чужая — будит сразу").toBeGreaterThan(0);
    off();
  });

  test("СМЕШАННЫЙ батч виден: одна своя запись не отбеливает чужие", async () => {
    // Прежняя проверка «батч целиком наш» давала амнистию всему батчу из-за
    // одной нашей записи — с открытым чатом это почти каждый батч.
    vi.resetModules();
    const { onDomChange, registerOwnContainer } = await import("@core/dom");
    let seen = 0;
    const off = onDomChange((muts) => {
      seen += muts.length;
    });
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    registerOwnContainer(panel);
    const foreign = document.createElement("div");
    document.body.appendChild(foreign);
    await vi.advanceTimersByTimeAsync(300);
    seen = 0;

    panel.appendChild(document.createElement("span")); // наша
    foreign.appendChild(document.createElement("span")); // чужая
    await vi.advanceTimersByTimeAsync(300);
    expect(seen, "подписчик получил ТОЛЬКО чужую запись").toBe(1);
    off();
  });

  test("вложенный узел нашей панели — тоже наш", async () => {
    vi.resetModules();
    const { onDomChange, registerOwnContainer, unregisterOwnContainer } = await import("@core/dom");
    passes = 0;
    const off = onDomChange(() => {
      passes++;
    });
    const panel = document.createElement("div");
    const body = document.createElement("div");
    const deep = document.createElement("div");
    body.appendChild(deep);
    panel.appendChild(body);
    document.body.appendChild(panel);
    registerOwnContainer(panel);
    await vi.advanceTimersByTimeAsync(300);
    passes = 0;
    deep.appendChild(document.createElement("span"));
    await vi.advanceTimersByTimeAsync(300);
    expect(passes).toBe(0);

    // Панель ушла — её узлы больше не «наши».
    unregisterOwnContainer(panel);
    deep.appendChild(document.createElement("span"));
    await vi.advanceTimersByTimeAsync(300);
    expect(passes, "после снятия регистрации записи снова видны").toBeGreaterThan(0);
    off();
  });
});
