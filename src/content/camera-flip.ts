/**
 * Переворот видео игрока на 180° через canvas-оверлей (без режима/кнопки на странице).
 * Используется кнопкой «повернуть камеру» в ряду кнопок игрока (player-notes).
 *
 * В Firefox видео иногда приходит перевёрнутым — это позволяет развернуть его обратно.
 */
import { SITE } from "@core/selectors";
import { log } from "@core/log";

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
  if (video.dataset.flipped === "true") {
    unflip(wrapper, video);
    return false;
  }
  flip(wrapper, video);
  return true;
}

function flip(wrapper: HTMLElement, video: HTMLVideoElement): void {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.style.cssText = "width:100%;height:100%;position:absolute;top:0;left:0";
  wrapper.appendChild(canvas);
  video.style.opacity = "0";

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    log.warn("camera-flip", "no 2d context");
    return;
  }
  ctx.scale(-1, -1); // поворот на 180°
  ctx.translate(-canvas.width, -canvas.height);

  // Флаг ставим ДО старта отрисовки, иначе первый кадр сразу выходит по условию.
  video.dataset.flipped = "true";

  const draw = () => {
    if (video.ended || video.dataset.flipped !== "true") return;
    try {
      if (video.readyState >= 2) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      /* кадр ещё не готов */
    }
    requestAnimationFrame(draw);
  };
  if (video.paused) video.play().catch(() => undefined);
  requestAnimationFrame(draw);

  log.debug("camera-flip", "flip", { paused: video.paused, readyState: video.readyState });
}

function unflip(wrapper: HTMLElement, video: HTMLVideoElement): void {
  wrapper.querySelector("canvas")?.remove();
  video.style.opacity = "1";
  video.dataset.flipped = "false";
}
