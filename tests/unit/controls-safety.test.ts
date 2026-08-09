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

let domSubscriber: (() => void) | null = null;
vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: () => void) => {
    domSubscriber = cb;
    return () => {
      domSubscriber = null;
    };
  }),
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
  KIND_CLASS,
  classifyButton,
  controlsSafetyFeature,
  markButtons,
  readPositions,
  styleText,
} from "@content/features/controls-safety";
import { DEFAULT_CONTROL_POSITIONS } from "@shared/controls-layout";

const FINISH_CLASS = KIND_CLASS.finish;
const GUESS_CLASS = KIND_CLASS.guess;
const OUTCRY_CLASS = KIND_CLASS.outcry;
/** Контекст фичи с раскладкой по умолчанию. */
const ctx = { settings: {} } as never;

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

  test("по умолчанию «Выкрикнуть» остаётся по центру", () => {
    // Уедь она вправо, встала бы ровно туда, куда уходит «Завершите речь», и
    // подмена под пальцем вернулась бы.
    buildControls(["Выкрикнуть"]);
    controlsSafetyFeature.enable(ctx);
    const [outcry] = centerButtons();
    expect(outcry.classList.contains(OUTCRY_CLASS), "метку ставим всегда").toBe(true);
    expect(getComputedStyle(outcry).marginLeft, "но никуда не двигаем").not.toBe("auto");
    expect(getComputedStyle(outcry).marginRight).not.toBe("auto");
  });

  test("дефолты — это прежняя безопасная раскладка", () => {
    // Настройка появилась позже самой фичи: молча сменить поведение у всех,
    // кто ничего не менял, нельзя.
    expect(DEFAULT_CONTROL_POSITIONS).toEqual({ finish: "right", outcry: "center", guess: "left" });
    expect(readPositions(null)).toEqual(DEFAULT_CONTROL_POSITIONS);
    // Мусор из storage не должен обнулять раскладку.
    expect(readPositions({ ctl_pos_finish: "чёрт-те что" } as never).finish).toBe("right");
  });

  test("английский интерфейс понимается так же", () => {
    // Сайт двуязычный: на EN подписи другие, а опасность та же.
    expect(classifyButton("End the speech")).toBe("finish");
    expect(classifyButton("Make a guess")).toBe("guess");
    expect(classifyButton("Reset guess")).toBe("guess");
    expect(classifyButton("Outcry")).toBe("outcry");
  });

  test("подпись с лишними пробелами и регистром всё равно узнаётся", () => {
    expect(classifyButton("  ЗАВЕРШИТЕ   РЕЧЬ ")).toBe("finish");
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

describe("границы: только игровая комната", () => {
  /** Сменить адрес страницы, как это делает переход SPA. */
  function goTo(path: string): void {
    window.history.replaceState({}, "", path);
  }

  test("вне комнаты ни стиля, ни меток — фича живёт на всех страницах сайта", () => {
    // Разметка похожая бывает и в разборе матча; лезть туда нам незачем.
    goTo("/match/617128");
    buildControls(["Завершите речь"]);
    controlsSafetyFeature.enable(ctx);
    expect(document.getElementById("pn-controls-safety"), "стиль не ставим").toBeNull();
    expect(centerButtons()[0].classList.contains(FINISH_CLASS)).toBe(false);
    goTo("/game");
  });

  test("уход из комнаты убирает наше, возврат — возвращает", () => {
    goTo("/game");
    buildControls(["Завершите речь"]);
    controlsSafetyFeature.enable(ctx);
    const finish = centerButtons()[0];
    expect(finish.classList.contains(FINISH_CLASS)).toBe(true);

    goTo("/profile/13509");
    domSubscriber?.();
    expect(document.getElementById("pn-controls-safety")).toBeNull();
    expect(finish.classList.contains(FINISH_CLASS), "метка снята").toBe(false);

    goTo("/game");
    domSubscriber?.();
    expect(document.getElementById("pn-controls-safety")).not.toBeNull();
    expect(finish.classList.contains(FINISH_CLASS)).toBe(true);
  });
});

describe("жизнь на живой странице", () => {
  test("раскладка берётся из настроек и меняется без перезагрузки", () => {
    // Ради этого настройка и делалась: перестановка не должна стоить релиза.
    buildControls(["Завершите речь"]);
    controlsSafetyFeature.enable(ctx);
    const finish = centerButtons()[0];
    expect(getComputedStyle(finish).marginLeft).toBe("auto");

    controlsSafetyFeature.update?.({ settings: { ctl_pos_finish: "left" } } as never);
    expect(getComputedStyle(finish).marginRight, "уехала влево").toBe("auto");
    expect(getComputedStyle(finish).marginLeft).not.toBe("auto");

    controlsSafetyFeature.update?.({ settings: { ctl_pos_finish: "center" } } as never);
    expect(getComputedStyle(finish).marginLeft, "центр — без отступов вовсе").not.toBe("auto");
    expect(getComputedStyle(finish).marginRight).not.toBe("auto");
  });

  test("центр не порождает CSS-правил", () => {
    // Правило «margin: 0» перебило бы вёрстку сайта там, где мы не просили.
    expect(styleText({ finish: "center", outcry: "center", guess: "center" })).toBe("");
  });

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
    expect(button.classList.contains(OUTCRY_CLASS), "и появляется метка нового действия").toBe(true);
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
    controlsSafetyFeature.enable(ctx);
    const finish = centerButtons()[0];
    expect(getComputedStyle(finish).marginLeft, "прижата к правому краю").toBe("auto");
    expect(getComputedStyle(finish).marginRight).not.toBe("auto");

    controlsSafetyFeature.disable();
    buildControls(["Оставить ЛХ"]);
    controlsSafetyFeature.enable(ctx);
    const guess = centerButtons()[0];
    expect(getComputedStyle(guess).marginRight, "прижата к левому краю").toBe("auto");
    expect(getComputedStyle(guess).marginLeft).not.toBe("auto");
  });

  test("выключение снимает и стиль, и все метки", () => {
    buildControls(["Завершите речь", "Оставить ЛХ"]);
    controlsSafetyFeature.enable(ctx);
    expect(document.getElementById("pn-controls-safety")).not.toBeNull();
    expect(document.querySelectorAll(`.${FINISH_CLASS}, .${GUESS_CLASS}`)).toHaveLength(2);

    controlsSafetyFeature.disable();
    expect(document.getElementById("pn-controls-safety")).toBeNull();
    expect(document.querySelectorAll(`.${FINISH_CLASS}, .${GUESS_CLASS}`)).toHaveLength(0);
  });
});
