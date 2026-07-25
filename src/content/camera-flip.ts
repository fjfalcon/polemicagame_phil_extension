/**
 * Переворот видео игрока на 180° через canvas-оверлей (без режима/кнопки на странице).
 * Используется кнопкой «повернуть камеру» в ряду кнопок игрока (player-notes).
 *
 * В Firefox видео иногда приходит перевёрнутым — это позволяет развернуть его обратно.
 */
import { SITE } from "@core/selectors";
import { log } from "@core/log";

interface FlipState {
  wrapper: HTMLElement;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  originalOpacity: string;
  originalFlipped: string | undefined;
  rafId: number | null;
}

const activeFlips = new Map<HTMLVideoElement, FlipState>();

export function isPlayerFlipped(playerEl: HTMLElement): boolean {
  const v = playerEl.querySelector<HTMLVideoElement>(SITE.playerVideoEl);
  return !!v && v.dataset.flipped === "true";
}

/** Перевернуть/вернуть видео игрока. Возвращает новое состояние (true = перевёрнуто) или null. */
export function toggleFlipForPlayer(playerEl: HTMLElement): boolean | null {
  const wrapper = playerEl.querySelector<HTMLElement>(SITE.playerVideoWrapper);
  const video = wrapper?.querySelector<HTMLVideoElement>(SITE.playerVideoEl) ?? null;
  if (!wrapper || !video) {
    log.debug("camera-flip", "no video/wrapper in player");
    return null;
  }
  const active = activeFlips.get(video);
  if (active) {
    cleanupFlip(active);
    return false;
  }
  return flip(wrapper, video);
}

function flip(wrapper: HTMLElement, video: HTMLVideoElement): boolean {
  const canvas = document.createElement("canvas");
  canvas.className = "polemica-camera-flip";
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.style.cssText = "width:100%;height:100%;position:absolute;top:0;left:0";

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    log.warn("camera-flip", "no 2d context");
    return false;
  }
  ctx.scale(-1, -1); // поворот на 180°
  ctx.translate(-canvas.width, -canvas.height);

  const state: FlipState = {
    wrapper,
    video,
    canvas,
    originalOpacity: video.style.opacity,
    originalFlipped: video.dataset.flipped,
    rafId: null,
  };
  wrapper.appendChild(canvas);
  video.style.opacity = "0";
  // Флаг ставим ДО старта отрисовки, иначе первый кадр сразу выходит по условию.
  video.dataset.flipped = "true";
  activeFlips.set(video, state);

  const draw = () => {
    if (
      video.ended ||
      !video.isConnected ||
      !wrapper.isConnected ||
      !canvas.isConnected ||
      video.dataset.flipped !== "true"
    ) {
      cleanupFlip(state);
      return;
    }
    try {
      if (video.readyState >= 2) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      /* кадр ещё не готов */
    }
    state.rafId = requestAnimationFrame(draw);
  };
  if (video.paused) video.play().catch(() => undefined);
  state.rafId = requestAnimationFrame(draw);

  log.debug("camera-flip", "flip", { paused: video.paused, readyState: video.readyState });
  return true;
}

function cleanupFlip(state: FlipState): void {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  state.canvas.remove();
  state.video.style.opacity = state.originalOpacity;
  if (state.originalFlipped === undefined) delete state.video.dataset.flipped;
  else state.video.dataset.flipped = state.originalFlipped;
  if (activeFlips.get(state.video) === state) activeFlips.delete(state.video);
}

export function unflipAll(): void {
  for (const state of [...activeFlips.values()]) cleanupFlip(state);
}
