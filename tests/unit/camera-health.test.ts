// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://polemicagame.com/game" }
/**
 * Здоровье камер: метка обрыва и кнопка «Перезагрузить камеры».
 *
 * Метка — утверждение «у него упала связь», кнопка — действие над живым
 * медиа. Сторожим то, чем можно навредить: метка на себе или на живом
 * потоке, кнопка во время своей речи, вечно заблокированная кнопка, следы
 * после выключения.
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
  isVisible: () => true,
  safeClick: vi.fn(),
}));
vi.mock("@core/env", () => ({
  browser: { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), flushNow: vi.fn() },
}));
const toasts: string[] = [];
vi.mock("@core/toast", () => ({
  showToast: (t: string) => {
    toasts.push(t);
    return true;
  },
  clearToasts: vi.fn(),
}));

import {
  BUTTON_ID,
  FROZEN_PASSES,
  MEDIA_CMD_SOURCE,
  MEDIA_RESULT_SOURCE,
  OVERLAY_CLASS,
  WATCH_INTERVAL_MS,
  cameraHealthFeature,
  deadCause,
  isDeadTrack,
  isFrozen,
  ownSpeechInProgress,
  tileLabel,
} from "@content/features/camera-health";
import { log } from "@core/log";
import type { Settings } from "@shared/types";

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    settings: {
      camera_reload_enabled: true,
      stream_lost_icon_enabled: true,
      ...over,
    } as unknown as Settings,
  }) as never;

/** Стол: чужая плитка с видео + (опц.) контролы. */
function room(opts: { center?: string; my?: boolean } = {}): HTMLVideoElement {
  document.body.innerHTML = `
    <div class="controls"><div class="left"></div><div class="center">${opts.center ?? ""}</div><div class="right"><div class="button preset-1 small">⚙</div></div></div>
    <div class="players">
      <div class="player${opts.my ? " my-player" : ""}" id="p0">
        <div class="player__video-wrapper" style="position:relative">
          <video class="player__video"></video>
        </div>
      </div>
    </div>`;
  return document.querySelector("video") as HTMLVideoElement;
}

/** Поток с одной видео-дорожкой заданного состояния. */
function stream(track: { muted?: boolean; readyState?: string } | null): MediaStream {
  return { getVideoTracks: () => (track ? [track] : []) } as unknown as MediaStream;
}

const overlay = () => document.querySelector(`.${OVERLAY_CLASS}`);
const tickOnce = () => vi.advanceTimersByTime(WATCH_INTERVAL_MS);

beforeEach(() => {
  vi.useFakeTimers();
  toasts.length = 0;
});

afterEach(() => {
  cameraHealthFeature.disable();
  document.body.innerHTML = "";
  vi.useRealTimers();
  window.history.replaceState({}, "", "/game");
});

describe("чистые датчики", () => {
  test("muted и ended — обрыв, живая дорожка — нет", () => {
    expect(isDeadTrack({ muted: true })).toBe(true);
    expect(isDeadTrack({ readyState: "ended" })).toBe(true);
    expect(isDeadTrack({ muted: false, readyState: "live" })).toBe(false);
    expect(isDeadTrack(undefined), "нет дорожки — нет и утверждения").toBe(false);
    // Причина различима в журнале: «упала сеть» и «камера убрана» — разное.
    expect(deadCause({ muted: true })).toBe("muted");
    expect(deadCause({ muted: true, readyState: "ended" }), "ended сильнее").toBe("ended");
    expect(deadCause({ muted: false })).toBeNull();
  });

  test("замер — только при совпадении с ПРОШЛЫМ замером", () => {
    expect(isFrozen(undefined, 5), "первый замер ничего не значит").toBe(false);
    expect(isFrozen(5, 5)).toBe(true);
    expect(isFrozen(5, 5.1)).toBe(false);
  });

  test("своя речь распознаётся по кнопке «Завершите речь»", () => {
    room({ center: '<div class="button">Завершите речь</div>' });
    expect(ownSpeechInProgress()).toBe(true);
    room({ center: '<div class="button">Выкрикнуть</div>' });
    expect(ownSpeechInProgress()).toBe(false);
  });
});

describe("метка обрыва", () => {
  test("muted-дорожка получает метку, ожившая — теряет", () => {
    const video = room();
    const track = { muted: true, readyState: "live" };
    video.srcObject = stream(track);
    cameraHealthFeature.enable(ctx());

    tickOnce();
    expect(overlay(), "обрыв — метка стоит").not.toBeNull();

    track.muted = false;
    tickOnce();
    expect(overlay(), "поток ожил — метка снята").toBeNull();
  });

  test("замершие кадры дают метку только после двух проходов подряд", () => {
    // Один совпавший currentTime — ещё не обрыв: живой поток тоже бывает
    // одинаков в два соседних замера на долю секунды.
    const video = room();
    video.srcObject = stream({ muted: false, readyState: "live" });
    Object.defineProperty(video, "currentTime", { value: 7, writable: true });
    Object.defineProperty(video, "paused", { value: false, writable: true });
    cameraHealthFeature.enable(ctx());

    tickOnce(); // первый замер — базовая точка
    tickOnce(); // совпадение №1
    expect(overlay(), `нужно ${FROZEN_PASSES} совпадения, было одно`).toBeNull();
    tickOnce(); // совпадение №2
    expect(overlay()).not.toBeNull();
  });

  test("журнал различает «оборвалось» и «ожило» и называет ПЛИТКУ (не ника)", () => {
    // Логи и есть доказательство «работает/нет» при живой проверке: пара
    // «оборвалось → ожило» с номером плитки читается без второй игры.
    // Ник в персистящийся лог не пишется (решение 02.08.2026).
    const video = room();
    document.querySelector("#p0")!.insertAdjacentHTML(
      "beforeend",
      '<div class="player__info info"><span class="info__name">Petya</span></div>',
    );
    const track = { muted: true, readyState: "live" };
    video.srcObject = stream(track);
    cameraHealthFeature.enable(ctx());
    tickOnce();
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" "));
    expect(infoCalls.some((c) => c.includes("плитка") && c.includes("muted"))).toBe(true);
    expect(infoCalls.some((c) => c.includes("Petya")), "ник не утёк в журнал").toBe(false);

    track.muted = false;
    tickOnce();
    const after = (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" "));
    expect(after.some((c) => c.includes("ожило") && c.includes("плитка"))).toBe(true);
    // Номер места, НЕ ник: ники в персистящийся лог не пишутся (решение
    // владельца 02.08.2026; ревью 26.08.2026).
    const label = tileLabel(document.querySelector("#p0") as HTMLElement);
    expect(label).toMatch(/^плитка \d+$/);
    expect(label).not.toContain("Petya");
  });

  test("метка идемпотентна: второй проход не плодит вторую", () => {
    const video = room();
    video.srcObject = stream({ muted: true });
    cameraHealthFeature.enable(ctx());
    tickOnce();
    tickOnce();
    expect(document.querySelectorAll(`.${OVERLAY_CLASS}`)).toHaveLength(1);
  });

  test("СВОЯ плитка не размечается", () => {
    // Локальный поток от сети не зависит — метка на себе врала бы и пугала.
    const video = room({ my: true });
    video.srcObject = stream({ muted: true });
    cameraHealthFeature.enable(ctx());
    tickOnce();
    expect(overlay()).toBeNull();
  });

  test("без потока метки нет — заглушку рисует сам сайт", () => {
    room();
    cameraHealthFeature.enable(ctx());
    tickOnce();
    expect(overlay()).toBeNull();
  });

  test("настройка выключена — меток нет и старые снимаются", () => {
    const video = room();
    video.srcObject = stream({ muted: true });
    cameraHealthFeature.enable(ctx());
    tickOnce();
    expect(overlay()).not.toBeNull();
    cameraHealthFeature.update?.(ctx({ stream_lost_icon_enabled: false }));
    expect(overlay(), "выключение обязано убрать уже стоящие").toBeNull();
  });
});

describe("кнопка «Перезагрузить камеры»", () => {
  const button = () => document.getElementById(BUTTON_ID) as HTMLButtonElement | null;

  test("в комнате есть, вне комнаты нет", () => {
    room();
    cameraHealthFeature.enable(ctx());
    expect(button()).not.toBeNull();

    window.history.replaceState({}, "", "/profile/13509");
    domSubscriber?.();
    expect(button(), "вне комнаты кнопке не место").toBeNull();
  });

  test("живёт в ряду контролов сайта, а не поверх логотипа", () => {
    // Жалоба владельца 14.08.2026: плавающая кнопка легла на логотип комнаты
    // и выглядела чужой. В ряду .controls .right она в родных классах сайта.
    room();
    cameraHealthFeature.enable(ctx());
    const b = button()!;
    expect(b.parentElement?.classList.contains("right"), "дом — правый ряд контролов").toBe(true);
    // НЕ классы сайта: они scoped и не работают на чужом узле — с ними
    // <button> показывала браузерный светлый фон (второй заход жалобы).
    // Свой инлайн-фон обязателен, иначе снова белое пятно.
    expect(b.className, "чужие классы не надеваем").not.toContain("button");
    expect(b.style.background, "тёмный фон задан явно").not.toBe("");
    expect(b.style.borderRadius, "скругление как у соседей").not.toBe("");
    expect(b.style.position, "никакого фиксированного позиционирования в ряду").not.toBe("fixed");
    // Перерисовка Vue ВЫНЕСЛА кнопку из ряда (узел жив, но не там) — проход
    // наблюдателя обязан вернуть её. Именно перенос, а не удаление: с
    // удалением справился бы и путь «создать заново», и тест ничего не
    // сторожил (мутант «existing не переставляется» его пережил).
    document.body.appendChild(b);
    domSubscriber?.();
    expect(button()?.parentElement?.classList.contains("right")).toBe(true);
    // И удаление тоже: кнопка пересоздаётся.
    button()!.remove();
    domSubscriber?.();
    expect(button()?.parentElement?.classList.contains("right")).toBe(true);
  });

  test("ряда контролов нет — плавающий фолбэк НАД логотипом", () => {
    // Фолбэк не имеет права повторить исходную жалобу: bottom:70px, не 18.
    document.body.innerHTML = `<div class="players"></div>`;
    cameraHealthFeature.enable(ctx());
    const b = button()!;
    expect(b.parentElement).toBe(document.body);
    expect(b.style.position).toBe("fixed");
    expect(b.style.bottom).toBe("70px");
  });

  test("настройка выключена — кнопки нет", () => {
    room();
    cameraHealthFeature.enable(ctx({ camera_reload_enabled: false }));
    expect(button()).toBeNull();
  });

  test("во время своей речи кнопка заблокирована", () => {
    room({ center: '<div class="button">Завершите речь</div>' });
    cameraHealthFeature.enable(ctx());
    domSubscriber?.();
    expect(button()?.disabled, "переподключение спрячет камеру посреди речи").toBe(true);
  });

  /** Перехват команд зонду + ручная готовность зонда (jsdom не грузит src). */
  function armProbe(): { sent: Array<{ source?: string; action?: string }>; ready: () => void } {
    const sent: Array<{ source?: string; action?: string }> = [];
    const orig = window.postMessage.bind(window);
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      sent.push(msg as never);
      orig(msg as never, location.origin);
    }) as never);
    return {
      sent,
      ready: () => {
        const tag = document.querySelector("script[data-pn-media-probe]") as HTMLScriptElement;
        tag?.onload?.(new Event("load"));
      },
    };
  }

  /** Ответ зонда, как его шлёт page-скрипт. */
  function probeReplies(ok: boolean, action: string): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: MEDIA_RESULT_SOURCE, ok, action },
        source: window as never,
      }),
    );
  }

  test("клик шлёт зонду команду переподключения", () => {
    room();
    cameraHealthFeature.enable(ctx());
    const sent: unknown[] = [];
    const orig = window.postMessage.bind(window);
    vi.spyOn(window, "postMessage").mockImplementation(((msg: unknown) => {
      sent.push(msg);
      orig(msg as never, location.origin);
    }) as never);

    // Зонд «уже стоит»: script.onload в jsdom не сработает без сети, поэтому
    // готовность пробрасываем через клик после ручного onload.
    button()!.click();
    const probeTag = document.querySelector("script[data-pn-media-probe]") as HTMLScriptElement;
    expect(probeTag, "первый клик ставит зонд").not.toBeNull();
    probeTag.onload?.(new Event("load"));

    expect(
      sent.some((m) => (m as { source?: string })?.source === MEDIA_CMD_SOURCE),
      "команда ушла после готовности зонда",
    ).toBe(true);
  });

  test("ЛЕСЕНКА: сначала мягкий шаг, и если метки сошли — сессию не трогаем", () => {
    // Мягкий updateStreams не рвёт ничего — у остальных даже не мигнёт.
    // Жёсткое пересоздание при уже оживших плитках было бы вредом от кнопки.
    const video = room();
    const track = { muted: true, readyState: "live" };
    video.srcObject = stream(track);
    cameraHealthFeature.enable(ctx());
    tickOnce();

    const probe = armProbe();
    button()!.click();
    probe.ready();
    expect(probe.sent.filter((m) => m.source === MEDIA_CMD_SOURCE).map((m) => m.action)).toEqual([
      "refresh",
    ]);

    probeReplies(true, "refresh");
    track.muted = false; // мягкий шаг помог — поток ожил
    tickOnce();
    vi.advanceTimersByTime(3100);
    expect(
      probe.sent.filter((m) => m.source === MEDIA_CMD_SOURCE).map((m) => m.action),
      "reconnect не понадобился",
    ).toEqual(["refresh"]);
    expect(button()!.disabled, "кнопка разблокирована").toBe(false);
  });

  test("ЛЕСЕНКА: мягкого шага мало — эскалация в пересоздание", () => {
    const video = room();
    video.srcObject = stream({ muted: true, readyState: "live" });
    cameraHealthFeature.enable(ctx());
    tickOnce();

    const probe = armProbe();
    button()!.click();
    probe.ready();
    probeReplies(true, "refresh");
    tickOnce(); // метка всё ещё стоит
    vi.advanceTimersByTime(3100);
    expect(probe.sent.filter((m) => m.source === MEDIA_CMD_SOURCE).map((m) => m.action)).toEqual([
      "refresh",
      "reconnect",
    ]);
  });

  test("зонд молчит — кнопка не остаётся заблокированной навсегда", () => {
    room();
    cameraHealthFeature.enable(ctx());
    button()!.click();
    expect(button()!.disabled).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(button()!.disabled, "страховочный таймер обязан разблокировать").toBe(false);
    expect(toasts.some((t) => t.includes("F5")), "и честно сказать про F5").toBe(true);
  });

  test("выключение фичи убирает кнопку и метки", () => {
    const video = room();
    video.srcObject = stream({ muted: true });
    cameraHealthFeature.enable(ctx());
    tickOnce();
    cameraHealthFeature.disable();
    expect(button()).toBeNull();
    expect(overlay()).toBeNull();
  });
});

test("непрошеный «результат» от страницы игнорируется", () => {
  // postMessage умеет слать и сама страница: без гейта поддельный ответ в
  // простое запускал бы наши таймеры и тосты без единого клика.
  document.body.innerHTML = `<div class="controls"><div class="center"></div><div class="right"></div></div>`;
  cameraHealthFeature.enable(
    { settings: { camera_reload_enabled: true, stream_lost_icon_enabled: true } } as never,
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: MEDIA_RESULT_SOURCE, ok: true, action: "reconnect" },
      source: window as never,
    }),
  );
  vi.advanceTimersByTime(10_000);
  expect(toasts, "ни одного тоста без нашего клика").toHaveLength(0);
});
