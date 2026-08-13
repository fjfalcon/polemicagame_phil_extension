// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Подсказка клавиши на кнопке.
 *
 * Подсказка — это обещание («нажми C — выкрикнешь»). Поэтому сторожим не
 * «надпись появилась», а случаи, когда её быть НЕ должно: выключенный хоткей,
 * заблокированная кнопка, чужая страница. Плюс идемпотентность записи: атрибут
 * ставится в узел сайта, и лишняя запись будит общий наблюдатель.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

let domSubscriber: (() => void) | null = null;
vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: () => void) => {
    domSubscriber = cb;
    return () => {
      domSubscriber = null;
    };
  }),
  isVisible: (el: Element) => !(el as HTMLElement).dataset.hidden,
  safeClick: vi.fn(),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  HINT_ATTR,
  findPauseItem,
  hotkeyHintsFeature,
  keyHintLabel,
} from "@content/features/hotkey-hints";
import type { Settings } from "@shared/types";

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    settings: {
      outcry_hotkey_enabled: true,
      outcry_hotkey_code: "KeyC",
      pause_hotkey_enabled: true,
      pause_hotkey_code: "F8",
      ...over,
    } as unknown as Settings,
  }) as never;

function room(center: string, menu = ""): void {
  document.body.innerHTML = `
    <div class="controls"><div class="left"></div><div class="center">${center}</div><div class="right"></div></div>
    <div class="base-menu">${menu}</div>`;
}

const hintOf = (sel: string): string | null =>
  document.querySelector<HTMLElement>(sel)?.getAttribute(HINT_ATTR) ?? null;

afterEach(() => {
  hotkeyHintsFeature.disable();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  window.history.replaceState({}, "", "/game");
});

describe("что подписываем", () => {
  test("кнопка выкрика получает свою клавишу", () => {
    room('<div class="button preset-1" id="cry">Выкрикнуть</div>');
    hotkeyHintsFeature.enable(ctx());
    expect(hintOf("#cry")).toBe("C");
    expect(document.getElementById("pn-hotkey-hints"), "стиль обязан быть").not.toBeNull();
  });

  test("пункт «Пауза» получает клавишу паузы", () => {
    room("", '<div class="base-menu__item" id="p">Пауза</div>');
    hotkeyHintsFeature.enable(ctx());
    expect(hintOf("#p")).toBe("F8");
  });

  test("пробел рисуется значком, а не словом", () => {
    // Просьба владельца: на кнопке нужен знак пробела.
    expect(keyHintLabel("Space")).toBe("␣");
    expect(keyHintLabel("KeyC")).toBe("C");
    expect(keyHintLabel("F8")).toBe("F8");
  });

  test("переназначил клавишу — подпись меняется сразу", () => {
    room('<div class="button preset-1" id="cry">Выкрикнуть</div>');
    hotkeyHintsFeature.enable(ctx());
    hotkeyHintsFeature.update?.(ctx({ outcry_hotkey_code: "Space" }));
    expect(hintOf("#cry")).toBe("␣");
  });
});

describe("где подписи быть НЕ должно", () => {
  test("хоткей выкрика выключен — обещать нечего", () => {
    room('<div class="button preset-1" id="cry">Выкрикнуть</div>');
    hotkeyHintsFeature.enable(ctx({ outcry_hotkey_enabled: false }));
    expect(hintOf("#cry")).toBeNull();
  });

  test("кнопка заблокирована — клавиша не сработает", () => {
    room('<div class="button preset-1 disabled" id="cry">Выкрикнуть</div>');
    hotkeyHintsFeature.enable(ctx());
    expect(hintOf("#cry")).toBeNull();
  });

  test("пункт паузы заблокирован (пауза уже идёт)", () => {
    room("", '<div class="base-menu__item disabled" id="p">Пауза</div>');
    hotkeyHintsFeature.enable(ctx());
    expect(hintOf("#p")).toBeNull();
  });

  test("похожая подпись — не наш пункт", () => {
    // Только ТОЧНЫЕ подписи: «Продолжить» и «Настройки паузы» кликать нечем.
    room("", '<div class="base-menu__item" id="p">Настройки паузы</div>');
    expect(findPauseItem()).toBeNull();
  });

  test("вне комнаты ни стиля, ни меток", () => {
    window.history.replaceState({}, "", "/match/617128");
    room('<div class="button preset-1" id="cry">Выкрикнуть</div>');
    hotkeyHintsFeature.enable(ctx());
    expect(document.getElementById("pn-hotkey-hints")).toBeNull();
    expect(hintOf("#cry")).toBeNull();
  });

  test("кнопка сменила действие — метка снимается", () => {
    // Vue переиспользует узел: был выкрик, стало «Завершите речь». Оставленная
    // подсказка обещала бы выкрик у кнопки конца речи — то есть фол.
    room('<div class="button preset-1" id="cry">Выкрикнуть</div>');
    hotkeyHintsFeature.enable(ctx());
    expect(hintOf("#cry")).toBe("C");

    document.getElementById("cry")!.textContent = "Завершите речь";
    domSubscriber?.();
    expect(hintOf("#cry")).toBeNull();
  });

  test("выключение фичи убирает всё наше", () => {
    room(
      '<div class="button preset-1" id="cry">Выкрикнуть</div>',
      '<div class="base-menu__item" id="p">Пауза</div>',
    );
    hotkeyHintsFeature.enable(ctx());
    hotkeyHintsFeature.disable();
    expect(document.getElementById("pn-hotkey-hints")).toBeNull();
    expect(hintOf("#cry")).toBeNull();
    expect(hintOf("#p")).toBeNull();
  });
});

test("повторный проход НИЧЕГО не пишет в DOM", async () => {
  // Запись будит общий наблюдатель; постоянная запись — это цикл
  // «запись → наблюдатель → запись» (инвариант §4 п.1).
  room('<div class="button preset-1" id="cry">Выкрикнуть</div>');
  hotkeyHintsFeature.enable(ctx());

  const seen: MutationRecord[] = [];
  const observer = new MutationObserver((records) => seen.push(...records));
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  for (let i = 0; i < 5; i++) domSubscriber?.();
  await Promise.resolve();
  observer.disconnect();
  expect(seen, "атрибут уже стоит — переписывать его незачем").toHaveLength(0);
});

test("меню закрыто — по документу не ходим", () => {
  // Проход идёт на каждое шевеление DOM. Обход всех `.button, li` комнаты на
  // тик — это тот самый расход, который вычищал перф-аудит 06.08.2026.
  document.body.innerHTML = `
    <div class="controls"><div class="center"></div></div>
    <div class="players">${'<div class="button preset-1">Игрок</div>'.repeat(30)}</div>`;
  hotkeyHintsFeature.enable(ctx());
  // Сторожим ОБА приёмника: обход по документу и обход внутри узла — иначе
  // «искать по всей странице» проходило бы мимо теста (поймано мутантом).
  const onElement = vi.spyOn(Element.prototype, "querySelectorAll");
  const onDocument = vi.spyOn(Document.prototype, "querySelectorAll");
  domSubscriber?.();
  const scanned = [...onElement.mock.calls, ...onDocument.mock.calls].filter((c) =>
    String(c[0]).includes("base-menu__item"),
  );
  expect(scanned, "внутрь пунктов меню лезем только когда меню открыто").toHaveLength(0);
  onElement.mockRestore();
  onDocument.mockRestore();
});
