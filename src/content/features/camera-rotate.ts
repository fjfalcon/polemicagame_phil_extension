/**
 * Режим поворота камер. В Firefox видео игроков иногда отображается перевёрнутым —
 * этот режим позволяет кликом по игроку перевернуть его камеру на 180° (зеркально,
 * через canvas-оверлей). Повторный клик возвращает оригинал.
 *
 * Дополнительно постоянно восстанавливает flex-`order` слотов (чтобы порядок игроков
 * не «прыгал») и переигрывает зависшие перевёрнутые видео.
 *
 * Порт пользовательского userscript «Rotate Mafia Game Videos» (fjfalcon, см. legacy/).
 */
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import { SITE } from "@core/selectors";
import type { Feature } from "@core/feature";

const APPLIED_ATTR = "rotationStyleApplied";
const ORDER_ATTR = "originalOrder";

class CameraRotator {
  private rotationMode = false;
  private button: HTMLButtonElement | null = null;
  private offDom: (() => void) | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onClick: ((e: MouseEvent) => void) | null = null;

  enable(): void {
    this.button = this.createButton();
    document.body.appendChild(this.button);
    this.updateButton();

    this.onClick = (e: MouseEvent) => {
      if (!this.rotationMode) return;
      const target = e.target as HTMLElement;
      const player = target.closest<HTMLElement>(SITE.player);
      if (!player) return;
      // Не мешаем кликам по меню/кнопкам/ссылкам игрока.
      if (target.closest("button, a, input, .player__menu, [class*='menu']")) return;
      const flipped = this.toggleFlip(player);
      // Если перевернули — гасим клик, чтобы сайт не выключил камеру этим же кликом.
      if (flipped) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", this.onClick, { capture: true });

    this.applyStylesToPlayers();
    this.offDom = onDomChange(() => this.applyStylesToPlayers());

    // Восстановление order + переигрывание зависших перевёрнутых видео.
    this.intervalId = setInterval(() => this.maintain(), 100);

    log.info("camera-rotate", "enabled");
  }

  disable(): void {
    if (this.onClick) document.removeEventListener("click", this.onClick, { capture: true });
    this.onClick = null;
    this.offDom?.();
    this.offDom = null;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.restoreAll();
    this.button?.remove();
    this.button = null;
    this.rotationMode = false;
  }

  private createButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483000;padding:10px;color:#fff;" +
      "border:none;border-radius:5px;cursor:pointer;font:13px system-ui,sans-serif";
    btn.addEventListener("click", () => {
      this.rotationMode = !this.rotationMode;
      this.updateButton();
    });
    return btn;
  }

  private updateButton(): void {
    if (!this.button) return;
    this.button.textContent = this.rotationMode
      ? "Выключить режим поворота"
      : "Включить режим поворота";
    this.button.style.backgroundColor = this.rotationMode ? "#f44336" : "#4CAF50";
  }

  private applyStylesToPlayers(): void {
    document.querySelectorAll<HTMLElement>(SITE.player).forEach((player) => {
      if (player.dataset[APPLIED_ATTR]) return;
      player.style.cursor = "pointer";
      player.dataset[APPLIED_ATTR] = "true";
      if (!player.dataset.playerId) {
        player.dataset.playerId = `player_${Math.random().toString(36).slice(2, 11)}`;
      }
      player.dataset[ORDER_ATTR] = player.style.order || getComputedStyle(player).order;
    });
  }

  private maintain(): void {
    this.applyStylesToPlayers();
    document.querySelectorAll<HTMLElement>(SITE.player).forEach((player) => {
      const order = player.dataset[ORDER_ATTR];
      if (order && player.style.order !== order) player.style.order = order;
      const video = player.querySelector<HTMLVideoElement>(SITE.playerVideoEl);
      if (video && video.dataset.flipped === "true" && video.paused) {
        video.play().catch(() => undefined);
      }
    });
  }

  /** Возвращает true, если переворот/возврат выполнен (для гашения клика сайта). */
  private toggleFlip(player: HTMLElement): boolean {
    const wrapper = player.querySelector<HTMLElement>(SITE.playerVideoWrapper);
    const video = wrapper?.querySelector<HTMLVideoElement>(SITE.playerVideoEl) ?? null;
    const order = player.style.order || getComputedStyle(player).order;
    player.dataset[ORDER_ATTR] = order;

    if (!wrapper || !video) {
      log.debug("camera-rotate", "no video/wrapper in player", {
        wrapper: !!wrapper,
        video: !!video,
      });
      return false;
    }

    if (video.dataset.flipped === "true") {
      this.unflip(wrapper, video);
    } else {
      this.flip(wrapper, video);
    }

    if (player.style.order !== order) player.style.order = order;
    return true;
  }

  private flip(wrapper: HTMLElement, video: HTMLVideoElement): void {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.style.cssText = "width:100%;height:100%;position:absolute;top:0;left:0";
    wrapper.appendChild(canvas);
    video.style.opacity = "0";

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      log.warn("camera-rotate", "no 2d context");
      return;
    }
    ctx.scale(-1, -1); // поворот на 180°
    ctx.translate(-canvas.width, -canvas.height);

    // ВАЖНО: флаг ставим ДО запуска отрисовки, иначе первый кадр сразу выходит
    // по условию и канвас остаётся пустым (чёрным).
    video.dataset.flipped = "true";

    const draw = () => {
      if (video.ended || video.dataset.flipped !== "true") return;
      try {
        if (video.readyState >= 2) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        /* кадр ещё не готов — попробуем на следующем тике */
      }
      requestAnimationFrame(draw);
    };
    (video as any).__rotDraw = draw;
    if (video.paused) video.play().catch(() => undefined);
    requestAnimationFrame(draw);

    log.debug("camera-rotate", "flip", {
      paused: video.paused,
      readyState: video.readyState,
      w: canvas.width,
      h: canvas.height,
    });
  }

  private unflip(wrapper: HTMLElement, video: HTMLVideoElement): void {
    const draw = (video as any).__rotDraw as (() => void) | undefined;
    if (draw) delete (video as any).__rotDraw;
    wrapper.querySelector("canvas")?.remove();
    video.style.opacity = "1";
    video.dataset.flipped = "false";
    log.debug("camera-rotate", "unflip");
  }

  /** Вернуть все перевёрнутые видео в исходное состояние и снять наши data-атрибуты/стили. */
  private restoreAll(): void {
    document.querySelectorAll<HTMLElement>(SITE.player).forEach((player) => {
      const wrapper = player.querySelector<HTMLElement>(SITE.playerVideoWrapper);
      const video = wrapper?.querySelector<HTMLVideoElement>(SITE.playerVideoEl) ?? null;
      if (wrapper && video && video.dataset.flipped === "true") this.unflip(wrapper, video);
      player.style.cursor = "";
      delete player.dataset[APPLIED_ATTR];
    });
  }
}

let rotator: CameraRotator | null = null;

export const cameraRotateFeature: Feature = {
  id: "camera-rotate",
  settingKey: "camera_rotate_enabled",
  enable() {
    rotator = new CameraRotator();
    rotator.enable();
  },
  disable() {
    rotator?.disable();
    rotator = null;
  },
};
