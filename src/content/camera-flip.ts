/**
 * Переворот видео игрока на 180° CSS-трансформацией (без режима/кнопки на странице).
 * Используется кнопкой «повернуть камеру» в ряду кнопок игрока (player-notes).
 *
 * В Firefox видео иногда приходит перевёрнутым — это позволяет развернуть его обратно.
 *
 * До аудита 01.08.2026 здесь был canvas-оверлей: полноразмерное копирование
 * кадров на каждый rAF (до ~553 млн пикселей/с при 10 камерах) — прямой путь
 * к фризам видео. CSS `rotate(180deg)` делает то же самое на компоузере
 * бесплатно. Inline-transform намеренно ПЕРЕКРЫВАЕТ возможный transform сайта
 * (зеркалирование): canvas тоже показывал сырые кадры без сайтовых
 * трансформаций, поведение сохранено.
 */
import { SITE } from "@core/selectors";
import { log } from "@core/log";

interface FlipState {
  video: HTMLVideoElement;
  originalTransform: string;
  originalFlipped: string | undefined;
}

const activeFlips = new Map<HTMLVideoElement, FlipState>();

/** Убрать записи отсоединённых video: сайт пересоздаёт элементы на смене фаз,
 *  и без уборки карта удерживала бы мёртвые video-поддеревья до unflipAll. */
function sweepDetached(): void {
  for (const video of [...activeFlips.keys()]) {
    if (!video.isConnected) activeFlips.delete(video);
  }
}

export function isPlayerFlipped(playerEl: HTMLElement): boolean {
  const v = playerEl.querySelector<HTMLVideoElement>(SITE.playerVideoEl);
  return !!v && v.dataset.flipped === "true";
}

/** Перевернуть/вернуть видео игрока. Возвращает новое состояние (true = перевёрнуто) или null. */
export function toggleFlipForPlayer(playerEl: HTMLElement): boolean | null {
  sweepDetached();
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
  // Осиротевший переворот: расширение перезагрузили, пока камера была
  // перевёрнута — dataset и inline rotate живы, а карта пуста. Без
  // нормализации flip() захватил бы rotate(180deg) как «оригинал» и камеру
  // было бы не вернуть. Клик в этом состоянии = «вернуть как было».
  if (video.dataset.flipped === "true") {
    video.style.transform = "";
    delete video.dataset.flipped;
    return false;
  }
  return flip(video);
}

function flip(video: HTMLVideoElement): boolean {
  const state: FlipState = {
    video,
    originalTransform: video.style.transform,
    originalFlipped: video.dataset.flipped,
  };
  video.style.transform = "rotate(180deg)";
  video.dataset.flipped = "true";
  activeFlips.set(video, state);
  if (video.paused) video.play().catch(() => undefined);
  log.debug("camera-flip", "flip", { paused: video.paused, readyState: video.readyState });
  return true;
}

function cleanupFlip(state: FlipState): void {
  state.video.style.transform = state.originalTransform;
  if (state.originalFlipped === undefined) delete state.video.dataset.flipped;
  else state.video.dataset.flipped = state.originalFlipped;
  if (activeFlips.get(state.video) === state) activeFlips.delete(state.video);
}

export function unflipAll(): void {
  for (const state of [...activeFlips.values()]) cleanupFlip(state);
  sweepDetached();
}
