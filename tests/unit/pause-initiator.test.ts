// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * «Кто поставил паузу» (просьба владельца 08.08.2026).
 *
 * Сервер присылает инициатора (`pause.initiatorId`), сайт его не показывает.
 * Мутационный критерий: каждый тест валит конкретную поломку — спутанные
 * события паузы, затирание известного инициатора пустым кадром, подпись,
 * пережившая конец паузы, неидемпотентная запись в DOM.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readPauseFrame } from "@content/page/room-probe-page";
import {
  LABEL_CLASS,
  PROBE_SOURCE,
  describeInitiator,
  pauseInitiatorFeature,
  renderLabel,
} from "@content/features/pause-initiator";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

const ctx = { settings: { pause_initiator_enabled: true } as Settings };

/** Кадр socket.io: 42["событие",{…}] — так их шлёт engine.io v3. */
const frame = (event: string, payload?: unknown): string =>
  `42${JSON.stringify(payload === undefined ? [event] : [event, payload])}`;

/** Экран паузы сайта (тот же блок, что итог игры, но с ended-pause). */
function pauseScreen(visible = true): void {
  document.body.innerHTML = `
    <div class="roller">
      <div class="ended ended-pause">
        <span class="ended__title">Пауза</span>
        <span class="ended__details">Игра приостановлена судьёй</span>
      </div>
    </div>
    <div class="player desktop-version">
      <div class="player__info info">
        <div class="player-number player-4">5</div><span class="info__name">Cobalt</span>
      </div>
    </div>`;
  // jsdom не считает layout: размеры экрана паузы задаём явно, иначе
  // проверка видимости (настоящая с 08.08.2026) отсечёт его как скрытый.
  const screen = document.querySelector(".ended-pause") as HTMLElement;
  Object.defineProperties(screen, {
    offsetWidth: { configurable: true, value: visible ? 400 : 0 },
    offsetHeight: { configurable: true, value: visible ? 120 : 0 },
  });
}

/** Сообщение от зонда (как его шлёт page-скрипт). */
function probe(data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent("message", { source: window, data: { source: PROBE_SOURCE, ...data } }),
  );
}

const label = () => document.querySelector(`.${LABEL_CLASS}`);
// Лог пишется несколькими аргументами («паузу поставил:», «№5 Cobalt»),
// поэтому ищем по склеенной строке вызова, а не по каждому аргументу.
const infoHas = (needle: string) =>
  vi.mocked(log.info).mock.calls.some((args) => args.join(" ").includes(needle));

beforeEach(() => {
  document.body.innerHTML = "";
  vi.mocked(log.info).mockClear();
});

afterEach(() => {
  pauseInitiatorFeature.disable();
  domSubscriber = null;
});

describe("разбор кадров сокета", () => {
  test("инициатор берётся из события паузы", () => {
    expect(readPauseFrame(frame("on_start_pause", { time: 60, initiatorId: 4 }))).toEqual({
      initiatorId: 4,
      finished: false,
      // Имя события едет с сигналом ради разбора логов: «пришёл кадр, но
      // без инициатора» обязано быть отличимо от «кадров не было».
      event: "on_start_pause",
    });
  });

  test("инициатор берётся и из состояния игры — там он лежит в объекте pause", () => {
    // Именно этот путь достоверно виден в бандле сайта.
    const raw = frame("on_detailed_game_state", {
      gameTime: 100,
      pause: { time: { total: 60, current: 10 }, initiatorId: 2 },
    });
    expect(readPauseFrame(raw)).toEqual({
      initiatorId: 2,
      finished: false,
      event: "on_detailed_game_state",
    });
  });

  test("ИСТЁКШАЯ пауза в состоянии игры инициатора не воскрешает", () => {
    // После F5 сервер шлёт состояние с уже отработавшей паузой, а инициатор
    // в объекте остаётся: сайт гейтит по остатку времени, и мы обязаны так
    // же — иначе подпись всплывала бы на постороннем экране (ревью 08.08).
    const raw = frame("on_detailed_game_state", {
      pause: { time: { total: 60, current: 60 }, initiatorId: 2 },
    });
    expect(readPauseFrame(raw)).toBeNull();
  });

  test("сентинел -1 («никого») игроком не считается", () => {
    // -1 в этом протоколе штатный: так помечены prosecutor/blamed без цели.
    expect(readPauseFrame(frame("on_start_pause", { initiatorId: -1 }))).toEqual({
      initiatorId: null,
      finished: false,
      event: "on_start_pause",
    });
    for (const bad of [1.5, NaN, Infinity, "3", null]) {
      expect(
        readPauseFrame(frame("on_start_pause", { initiatorId: bad }))?.initiatorId,
        String(bad),
      ).toBeNull();
    }
  });

  test("состояние БЕЗ паузы — не сигнал: гасить им подпись нельзя", () => {
    // Такой кадр приходит и в обычной игре; будь он «пауза кончилась»,
    // подпись слетала бы посреди живой паузы. Важно взять кадр СО словом
    // pause внутри (`pauseAvailable` сайт шлёт всегда) — иначе проверка не
    // доходит до самой ветки и молча ничего не сторожит.
    expect(readPauseFrame(frame("on_detailed_game_state", { gameTime: 100 }))).toBeNull();
    expect(
      readPauseFrame(frame("on_detailed_game_state", { gameTime: 100, pauseAvailable: true })),
      "состояние с флагом доступности паузы — тоже не пауза",
    ).toBeNull();
  });

  test("конец паузы распознаётся отдельно от её начала", () => {
    expect(readPauseFrame(frame("on_finish_pause", {}))).toEqual({
      initiatorId: null,
      finished: true,
      event: "on_finish_pause",
    });
  });

  test("событие паузы без инициатора: сигнал есть, id нет", () => {
    expect(readPauseFrame(frame("on_update_pause_time", { time: 42 }))).toEqual({
      initiatorId: null,
      finished: false,
      event: "on_update_pause_time",
    });
  });

  test("чужие кадры игнорируются целиком", () => {
    for (const raw of [
      frame("on_start_stage", { type: "day" }),
      frame("on_reveal_role", { id: 3, role: 1 }),
      "2",
      "3",
      '0{"sid":"abc","pingInterval":25000}',
      "",
      42,
      null,
    ]) {
      expect(readPauseFrame(raw as unknown), String(raw).slice(0, 40)).toBeNull();
    }
  });

  test("мусор вместо JSON не роняет разбор", () => {
    expect(readPauseFrame('42["on_start_pause",{битый')).toBeNull();
  });
});

describe("подпись инициатора", () => {
  test("номер и ник берутся с плитки игрока", () => {
    pauseScreen();
    // id 0-based, человеку показываем с единицы.
    expect(describeInitiator(4)).toBe("№5 Cobalt");
  });

  test("пауза от СУДЬИ подписывается судьёй, а не местом «№11»", () => {
    // Судейская плитка — обычный Player с id 10 (сайт: totalPlayers=11), и
    // без проверки класса подпись врала бы «№11 Ник» прямо под сайтовым
    // «Игра приостановлена судьёй» (ревью 08.08.2026, блокер).
    document.body.innerHTML = `
      <div class="player judge-player">
        <div class="player__info info">
          <div class="player-number player-10">11</div><span class="info__name">Судья</span>
        </div>
      </div>`;
    expect(describeInitiator(10)).toBe("судья");
  });

  test("своей плитки нет (мобильная вёрстка) — «вы», а не домысел о роли", () => {
    // Сайт не рендерит СВОЮ плитку на мобильной вёрстке: там паузу мог
    // поставить сам игрок, и «судья или наблюдатель» было бы ложью.
    document.body.innerHTML = `
      <div class="player my-player">
        <div class="player__info info"><div class="player-number player-6">7</div></div>
      </div>`;
    const my = document.querySelector(".player.my-player") as HTMLElement;
    expect(describeInitiator(6)).toBe("№7");
    my.querySelector(".player-number")?.remove();
    my.insertAdjacentHTML("beforeend", '<div class="player-number player-6"></div>');
    expect(describeInitiator(6), "по своей плитке узнаём себя").toBe("№7");
  });

  test("чужого игрока без плитки называем номером, без выдумок", () => {
    document.body.innerHTML = `<div class="roller"></div>`;
    expect(describeInitiator(3)).toBe("№4");
  });

  test("подпись появляется на экране паузы и пишется в лог один раз", () => {
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });

    expect(label()?.textContent).toBe("Паузу поставил: №5 Cobalt");
    expect(label()?.parentElement?.className).toContain("ended-pause");
    expect(infoHas("паузу поставил: №5 Cobalt")).toBe(true);

    vi.mocked(log.info).mockClear();
    probe({ initiatorId: 4, finished: false });
    expect(infoHas("паузу поставил"), "повтор в лог не пишем").toBe(false);
  });

  test("кадр без инициатора НЕ затирает уже известного", () => {
    // Обновления времени паузы идут чаще самого события и часто без id.
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    probe({ initiatorId: null, finished: false });
    expect(label()?.textContent).toBe("Паузу поставил: №5 Cobalt");
  });

  test("конец паузы убирает подпись и забывает инициатора", () => {
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    probe({ initiatorId: null, finished: true });
    expect(label()).toBeNull();

    // Следующая пауза не должна начинаться со старой подписью.
    domSubscriber?.();
    expect(label()).toBeNull();
  });

  test("перерисовка роллера сносит подпись — следующий тик её вернёт", () => {
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    pauseScreen(); // Vue перерисовал экран паузы
    expect(label()).toBeNull();
    domSubscriber?.();
    expect(label()?.textContent).toBe("Паузу поставил: №5 Cobalt");
  });

  test("СКРЫТЫЙ экран паузы подписи не получает", () => {
    // Сайт держит блок `.ended` в DOM и вне паузы; без настоящей проверки
    // размеров подпись всплывала бы на невидимом экране (ревью 08.08.2026:
    // прежнее условие было тождественно истинным).
    pauseScreen(false);
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    expect(label()).toBeNull();
  });

  test("без экрана паузы подписи нет, даже если инициатор известен", () => {
    document.body.innerHTML = `<div class="roller"><div class="stage"></div></div>`;
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    expect(label()).toBeNull();
    // Прямой вызов, а не только через сообщение: исключение внутри
    // обработчика события jsdom проглатывает, и тест оставался зелёным даже
    // без проверки экрана (мутация 08.08.2026).
    expect(() => renderLabel()).not.toThrow();
    expect(label()).toBeNull();
  });

  test("тик без изменений ничего не пишет в DOM (инвариант §4 п.1)", () => {
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    const before = label()?.textContent;
    const spy = vi.spyOn(Element.prototype, "appendChild");
    try {
      domSubscriber?.();
      domSubscriber?.();
      expect(spy).not.toHaveBeenCalled();
      expect(label()?.textContent).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  test("чужие postMessage игнорируются", () => {
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { source: "кто-то-другой", initiatorId: 4 },
      }),
    );
    expect(label()).toBeNull();
  });

  test("выключение снимает подпись и слушателя", () => {
    pauseScreen();
    pauseInitiatorFeature.enable(ctx);
    probe({ initiatorId: 4, finished: false });
    expect(label()).not.toBeNull();

    pauseInitiatorFeature.disable();
    expect(label()).toBeNull();
    probe({ initiatorId: 4, finished: false });
    expect(label(), "после disable сообщения зонда никого не трогают").toBeNull();
  });
});
