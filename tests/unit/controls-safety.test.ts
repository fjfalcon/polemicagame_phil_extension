// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Безопасный ряд кнопок.
 *
 * Фича защищает от потраченного выкрика, поэтому проверяем не «класс
 * появился», а то, чем она может навредить: увести вправо не ту кнопку,
 * оставить метку на переиспользованном узле и писать в DOM на каждом тике.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@core/dom", () => ({
  onDomChange: vi.fn(() => () => {}),
  safeClick: vi.fn(),
  isVisible: () => true,
}));
vi.mock("@core/env", () => ({
  browser: { storage: { local: { get: vi.fn(), set: vi.fn() } } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  FINISH_CLASS,
  GUESS_CLASS,
  classifyButton,
  controlsSafetyFeature,
  markButtons,
} from "@content/features/controls-safety";

/** Ряд контролов сайта: три зоны, кнопки действий — в центре. */
function buildControls(labels: string[]): void {
  document.body.innerHTML = `
    <div class="controls">
      <div class="left"><div class="button preset-1">Настройки</div></div>
      <div class="center">
        ${labels.map((l) => `<div class="button preset-1">${l}</div>`).join("")}
      </div>
      <div class="right"><div class="button preset-1">Выйти</div></div>
    </div>`;
}

const centerButtons = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".controls .center .button"));

afterEach(() => {
  controlsSafetyFeature.disable();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("что и куда уезжает", () => {
  test("«Завершите речь» — вправо, ЛХ — влево", () => {
    buildControls(["Оставить ЛХ", "Завершите речь"]);
    markButtons();
    const [guess, finish] = centerButtons();
    expect(guess.classList.contains(GUESS_CLASS)).toBe(true);
    expect(finish.classList.contains(FINISH_CLASS)).toBe(true);
  });

  test("«Выкрикнуть» НЕ трогаем — от неё и уводим", () => {
    // Уведи мы её вправо, она встала бы ровно туда, куда уходит «Завершите
    // речь», и подмена на месте вернулась бы.
    buildControls(["Выкрикнуть"]);
    markButtons();
    const [outcry] = centerButtons();
    expect(outcry.classList.contains(FINISH_CLASS)).toBe(false);
    expect(outcry.classList.contains(GUESS_CLASS)).toBe(false);
  });

  test("английский интерфейс понимается так же", () => {
    // Сайт двуязычный: на EN подписи другие, а опасность та же.
    expect(classifyButton("End the speech")).toBe(FINISH_CLASS);
    expect(classifyButton("Make a guess")).toBe(GUESS_CLASS);
    expect(classifyButton("Reset guess")).toBe(GUESS_CLASS);
    expect(classifyButton("Outcry"), "выкрик не наш").toBeNull();
  });

  test("подпись с лишними пробелами и регистром всё равно узнаётся", () => {
    expect(classifyButton("  ЗАВЕРШИТЕ   РЕЧЬ ")).toBe(FINISH_CLASS);
    expect(classifyButton("")).toBeNull();
    expect(classifyButton("Готов")).toBeNull();
  });

  test("кнопки ВНЕ центра не трогаем", () => {
    // В левой и правой зонах живут свои кнопки сайта; автоотступ там сломал
    // бы вёрстку ряда.
    buildControls([]);
    document.querySelector(".left .button")!.textContent = "Завершите речь";
    markButtons();
    expect(document.querySelector(".left .button")!.classList.contains(FINISH_CLASS)).toBe(false);
  });
});

describe("жизнь на живой странице", () => {
  test("Vue переиспользовал узел под другое действие — метка снимается", () => {
    // Ровно этот случай и опасен: узел был «Завершите речь», стал
    // «Выкрикнуть». Оставь мы класс — выкрик уехал бы вправо, туда, где
    // только что был палец.
    buildControls(["Завершите речь"]);
    markButtons();
    const button = centerButtons()[0];
    expect(button.classList.contains(FINISH_CLASS)).toBe(true);

    button.textContent = "Выкрикнуть";
    markButtons();
    expect(button.classList.contains(FINISH_CLASS)).toBe(false);
  });

  test("повторный проход НИЧЕГО не пишет в DOM", async () => {
    // Наблюдатель зовёт нас на каждом изменении страницы: лишняя запись
    // будила бы его снова — петля из §4 п.1.
    buildControls(["Завершите речь", "Оставить ЛХ"]);
    markButtons();
    let writes = 0;
    const observer = new MutationObserver((records) => {
      writes += records.length;
    });
    observer.observe(document.body, { attributes: true, subtree: true, childList: true });
    markButtons();
    await Promise.resolve();
    observer.disconnect();
    expect(writes).toBe(0);
  });

  test("сдвиг настоящий: «Завершите речь» вправо, ЛХ влево", () => {
    // Класс без правильного CSS не двигает ничего. Проверяем вычисленный
    // стиль, а не наличие метки: именно автоотступ и разводит кнопки, а при
    // одной кнопке в центре только он и работает (порядок бессмысленен).
    buildControls(["Завершите речь"]);
    controlsSafetyFeature.enable({ settings: {} } as never);
    const finish = centerButtons()[0];
    expect(getComputedStyle(finish).marginLeft, "прижата к правому краю").toBe("auto");
    expect(getComputedStyle(finish).marginRight).not.toBe("auto");

    controlsSafetyFeature.disable();
    buildControls(["Оставить ЛХ"]);
    controlsSafetyFeature.enable({ settings: {} } as never);
    const guess = centerButtons()[0];
    expect(getComputedStyle(guess).marginRight, "прижата к левому краю").toBe("auto");
    expect(getComputedStyle(guess).marginLeft).not.toBe("auto");
  });

  test("выключение снимает и стиль, и все метки", () => {
    buildControls(["Завершите речь", "Оставить ЛХ"]);
    controlsSafetyFeature.enable({ settings: {} } as never);
    expect(document.getElementById("pn-controls-safety")).not.toBeNull();
    expect(document.querySelectorAll(`.${FINISH_CLASS}, .${GUESS_CLASS}`)).toHaveLength(2);

    controlsSafetyFeature.disable();
    expect(document.getElementById("pn-controls-safety")).toBeNull();
    expect(document.querySelectorAll(`.${FINISH_CLASS}, .${GUESS_CLASS}`)).toHaveLength(0);
  });
});
