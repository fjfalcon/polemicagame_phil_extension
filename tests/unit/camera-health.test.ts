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
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  OVERLAY_CLASS,
  WATCH_INTERVAL_MS,
  cameraHealthFeature,
  isDeadTrack,
  isFrozen,
  ownSpeechInProgress,
} from "@content/features/camera-health";
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
    <div class="controls"><div class="left"></div><div class="center">${opts.center ?? ""}</div></div>
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
