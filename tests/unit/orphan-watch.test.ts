// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Сторож осиротевшего контент-скрипта: после обновления расширения Chrome
 * оставляет старые скрипты жить «вслепую» — DOM работает, extension-API
 * мёртв. Две жалобы за неделю 05.08.2026 сводились к этому невидимому
 * состоянию; баннер — единственный способ сказать игроку про F5.
 */
const seam = vi.hoisted(() => ({ runtime: { id: "alive" } as { id?: unknown } }));

vi.mock("@core/env", () => ({
  get browser() {
    return { runtime: seam.runtime };
  },
}));

import {
  ORPHAN_BANNER_ID,
  isContextAlive,
  renderOrphanBanner,
  startOrphanWatch,
  stopOrphanWatch,
} from "@content/orphan-watch";

const banner = () => document.getElementById(ORPHAN_BANNER_ID);

beforeEach(() => {
  document.body.innerHTML = "";
  seam.runtime = { id: "alive" };
  vi.useFakeTimers();
});

afterEach(() => {
  stopOrphanWatch();
  vi.useRealTimers();
});

describe("isContextAlive", () => {
  test.each([
    ["живой контекст", { id: "abcd" }, true],
    ["осиротевший: id пропал", {}, false],
    ["runtime исчез целиком", undefined, false],
    ["id не строка", { id: 7 }, false],
    ["id пустая строка", { id: "" }, false],
  ])("%s", (_name, runtime, expected) => {
    expect(isContextAlive(runtime as { id?: unknown })).toBe(expected);
  });

  test("бросающий доступ к id — та же смерть контекста", () => {
    const trap = {
      get id(): string {
        throw new Error("Extension context invalidated");
      },
    };
    expect(isContextAlive(trap)).toBe(false);
  });
});

describe("сторож", () => {
  test("живой контекст — баннера нет, сколько ни жди", () => {
    startOrphanWatch();
    vi.advanceTimersByTime(60_000);
    expect(banner()).toBeNull();
  });

  test("контекст умер — баннер появляется, и ровно один", () => {
    startOrphanWatch();
    vi.advanceTimersByTime(11_000);
    expect(banner()).toBeNull();

    seam.runtime = {}; // обновление расширения: id пропал
    vi.advanceTimersByTime(11_000);
    expect(banner(), "баннер обязан появиться").not.toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(document.querySelectorAll(`#${ORPHAN_BANNER_ID}`).length).toBe(1);
  });

  test("закрытый игроком баннер не возвращается: решение человека — закон", () => {
    startOrphanWatch();
    seam.runtime = {};
    vi.advanceTimersByTime(11_000);
    expect(banner()).not.toBeNull();

    banner()?.querySelector<HTMLButtonElement>('[aria-label="Закрыть"]')?.click();
    expect(banner()).toBeNull();
    // Сторож после срабатывания погашен — перерисовки не будет никогда.
    vi.advanceTimersByTime(120_000);
    expect(banner()).toBeNull();
  });

  test("stopOrphanWatch (мастер-выключатель) глушит сторож до срабатывания", () => {
    startOrphanWatch();
    stopOrphanWatch();
    seam.runtime = {};
    vi.advanceTimersByTime(60_000);
    expect(banner()).toBeNull();
  });

  test("в баннере есть кнопка перезагрузки, и решает игрок, а не мы", () => {
    // Авто-reload посреди живого матча недопустим: сторож только рисует.
    renderOrphanBanner(document);
    const reload = Array.from(banner()?.querySelectorAll("button") ?? []).find((b) =>
      (b.textContent || "").includes("Обновить"),
    );
    expect(reload).toBeTruthy();
  });

  test("renderOrphanBanner идемпотентен", () => {
    renderOrphanBanner(document);
    renderOrphanBanner(document);
    expect(document.querySelectorAll(`#${ORPHAN_BANNER_ID}`).length).toBe(1);
  });

  test("повторный start не плодит второй интервал: stop глушит ЕДИНСТВЕННЫЙ таймер", () => {
    // Штатная топология проводки — два вызова start (boot + мастер-тумблер).
    // Без гарда в start первый интервал утекал бы и не глушился stop-ом
    // (мутант ревью 06.08.2026).
    startOrphanWatch();
    startOrphanWatch();
    stopOrphanWatch();
    seam.runtime = {};
    vi.advanceTimersByTime(60_000);
    expect(banner(), "после stop не должно остаться ни одного живого интервала").toBeNull();
  });

  test("кнопка «Обновить страницу» действительно перезагружает", () => {
    const reloadSpy = vi.fn();
    // jsdom не даёт шпионить за location.reload — подсовываем фасад документа:
    // renderOrphanBanner берёт reload через doc.location, всё остальное — DOM.
    const doc = new Proxy(document, {
      get(target, prop) {
        if (prop === "location") return { reload: reloadSpy };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as Document;
    renderOrphanBanner(doc);
    const reload = Array.from(banner()?.querySelectorAll("button") ?? []).find((b) =>
      (b.textContent || "").includes("Обновить"),
    );
    reload?.click();
    expect(reloadSpy, "клик игрока обязан вести к reload").toHaveBeenCalledTimes(1);
  });
});
