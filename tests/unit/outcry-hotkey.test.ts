// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Выкрик с клавиши.
 *
 * Фича ДЕЛАЕТ ДЕЙСТВИЕ за игрока, и действие расходуемое: лишний выкрик — фол.
 * Поэтому сторожим не «клик прошёл», а границы: где клавиша обязана молчать и
 * во что именно она попадает.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const clicks: Element[] = [];
vi.mock("@core/dom", () => ({
  safeClick: (el: Element) => {
    clicks.push(el);
    return true;
  },
  isVisible: (el: Element) => !(el as HTMLElement).dataset.hidden,
  onDomChange: vi.fn(() => () => {}),
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { findOutcryButton, pressOutcry } from "@content/features/outcry-hotkey";

/** Ряд контролов сайта: действия — в центре. */
function controls(html: string): void {
  document.body.innerHTML = `
    <div class="controls">
      <div class="left"><div class="button preset-1">Настройки</div></div>
      <div class="center">${html}</div>
      <div class="right"><div class="button preset-1">Выкрикнуть</div></div>
    </div>`;
}

afterEach(() => {
  clicks.length = 0;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/game");
});

test("нажатие кликает кнопку выкрика", () => {
  controls('<div class="button preset-1">Выкрикнуть</div>');
  expect(pressOutcry()).toBe(true);
  expect(clicks).toHaveLength(1);
  expect(clicks[0].textContent).toContain("Выкрикнуть");
});

test("английский интерфейс понимается так же", () => {
  controls('<div class="button preset-1">Outcry</div>');
  expect(pressOutcry()).toBe(true);
});

test("не свой момент — клавиша молчит", () => {
  // В центре стоит «Завершите речь»: выкрикнуть сейчас нельзя, и придумывать
  // клик не во что.
  controls('<div class="button preset-1">Завершите речь</div>');
  expect(pressOutcry()).toBe(false);
  expect(clicks).toHaveLength(0);
});

test("заблокированную кнопку не жмём", () => {
  // Сайт гасит кнопку, когда выкрик уже потрачен. Клик по ней — в лучшем
  // случае ничего, в худшем — сюрприз.
  controls('<div class="button preset-1 disabled">Выкрикнуть</div>');
  expect(pressOutcry()).toBe(false);
});

test("невидимую кнопку не жмём", () => {
  controls('<div class="button preset-1" data-hidden="1">Выкрикнуть</div>');
  expect(pressOutcry()).toBe(false);
});

test("кнопки ВНЕ центра не наши", () => {
  // В правой зоне живут свои кнопки сайта; в разметке теста там как раз
  // стоит «Выкрикнуть» — попасть в неё нельзя.
  controls('<div class="button preset-1">Завершите речь</div>');
  expect(findOutcryButton()).toBeNull();
});

test("жмём самую глубокую кнопку, а не обёртку", () => {
  // У обёртки тот же текст, но нажатием сайт считает клик по внутренней.
  controls(
    '<div class="button preset-1" id="wrap"><div class="button preset-1" id="real">Выкрикнуть</div></div>',
  );
  expect(pressOutcry()).toBe(true);
  expect((clicks[0] as HTMLElement).id).toBe("real");
});

test("вне игровой комнаты клавиша не делает ничего", () => {
  // Разбор матча рисует похожую разметку; лезть туда клавише незачем.
  window.history.replaceState({}, "", "/match/617128");
  controls('<div class="button preset-1">Выкрикнуть</div>');
  expect(pressOutcry()).toBe(false);
  expect(clicks).toHaveLength(0);
});
