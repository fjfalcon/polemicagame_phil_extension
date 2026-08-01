// @vitest-environment jsdom
import phaseFixture from "../fixtures/phase-labels.ru.json";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyPhaseText,
  endedScreenVisible,
  hasPhaseMarker,
  matchFinishedVisible,
} from "@core/selectors";

afterEach(() => {
  document.body.replaceChildren();
});

describe("phase classification", () => {
  test.each(phaseFixture.labels)("$text -> $phase", ({ text, phase }) => {
    expect(classifyPhaseText(text.toLowerCase())).toBe(phase);
    expect(classifyPhaseText(`${text} | игрок №7`.toLowerCase())).toBe(phase);
  });

  test.each([
    ["ночь | голосование мафии", "night"],
    ["утро", "day"],
    ["ход доктора", "night"],
    ["аукцион", "night"],
  ] as const)("regression: %s -> %s", (text, phase) => {
    expect(classifyPhaseText(text)).toBe(phase);
  });

  test.each(["", "7", "00:42", "игрок №10", "таймер 12:34"])("%j is not a phase", (text) => {
    expect(classifyPhaseText(text)).toBeNull();
  });

  test("short English markers use boundaries", () => {
    expect(hasPhaseMarker("today", ["day"])).toBe(false);
    expect(hasPhaseMarker("dismiss", ["miss"])).toBe(false);
    expect(hasPhaseMarker("day 2", ["day"])).toBe(true);
    expect(hasPhaseMarker("mafia miss", ["miss"])).toBe(true);
  });
});

describe("endedScreenVisible", () => {
  function ended(classes = "ended") {
    const el = document.createElement("div");
    el.className = classes;
    Object.defineProperties(el, {
      offsetWidth: { configurable: true, value: 300 },
      offsetHeight: { configurable: true, value: 200 },
    });
    document.body.append(el);
    return el;
  }

  test("recognizes a visible victory screen", () => {
    // Класс СВЕРЕН С БАНДЛОМ (contClasses): ended-civilian, а не «-win».
    // Прежняя фикстура называла несуществующий класс — безобидно для этой
    // проверки, но служила образцом и тянула ошибку дальше (ревью 02.08.2026).
    ended("ended ended-civilian");
    expect(endedScreenVisible()).toBe(true);
  });

  test("does not confuse the shared pause screen with game end", () => {
    ended("ended ended-pause");
    expect(endedScreenVisible()).toBe(false);
  });

  test("ignores absent and zero-size screens", () => {
    expect(endedScreenVisible()).toBe(false);
    const el = ended();
    Object.defineProperty(el, "offsetWidth", { configurable: true, value: 0 });
    expect(endedScreenVisible()).toBe(false);
  });
});

describe("matchFinishedVisible (матч действительно доигран)", () => {
  function ended(classes: string) {
    const el = document.createElement("div");
    el.className = classes;
    Object.defineProperties(el, {
      offsetWidth: { configurable: true, value: 300 },
      offsetHeight: { configurable: true, value: 200 },
    });
    document.body.append(el);
    return el;
  }

  test.each(["ended ended-civilian", "ended ended-mafia"])("%s — матч закончен", (classes) => {
    ended(classes);
    expect(matchFinishedVisible()).toBe(true);
  });

  test.each(["ended ended-pause", "ended ended-mafia-missed"])(
    "%s — это середина живой игры, владение автосценой не снимаем",
    (classes) => {
      // Пауза и промах мафии рисуются ТЕМ ЖЕ блоком. Спутать их с концом матча
      // значит отдать сцену другой вкладке посреди эфира.
      ended(classes);
      expect(matchFinishedVisible()).toBe(false);
    },
  );

  test("скрытый экран не считается", () => {
    const el = ended("ended ended-mafia");
    Object.defineProperty(el, "offsetHeight", { configurable: true, value: 0 });
    expect(matchFinishedVisible()).toBe(false);
  });
});
