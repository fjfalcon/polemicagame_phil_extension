/**
 * Фича: здоровье камер — метка обрыва на мёртвой плитке и кнопка
 * «Перезагрузить камеры» (просьба владельца 14.08.2026: «у игрока видео
 * стрим завис — интернет упал или типа того», а лечатся все — перезагрузкой
 * всей страницы).
 *
 * Две независимые половины:
 *
 * 1. МЕТКА ОБРЫВА. У живой плитки в <video> лежит MediaStream, чья
 *    видео-дорожка отдаёт кадры. Когда у игрока падает сеть, дорожка
 *    остаётся, но браузер помечает её muted (данные перестали приходить) —
 *    это и есть «чёрный квадрат». Вторая форма зависания — дорожка живая, а
 *    кадры не идут: ловится по замершему currentTime между двумя проходами.
 *    Свою плитку не размечаем: там локальный поток с камеры, он не зависит
 *    от сети, а ложная метка на себе пугала бы сильнее правды.
 *
 * 2. КНОПКА. «F5 только для видео»: пересоздать медиа-сессию, не трогая чат,
 *    журнал и состояние игры. Дотянуться из isolated-мира до медиа нельзя,
 *    поэтому работает PAGE-зонд (page/media-probe-page.ts), который повторяет
 *    штатный путь самого сайта. Зонд ставится ЛЕНИВО — тег появляется только
 *    после первого клика: у не пользующихся кнопкой страница не меняется.
 *
 * Кнопка блокируется на время СВОЕЙ речи: переподключение прячет твою
 * картинку у всех на пару секунд, и делать это посреди собственной речи —
 * медвежья услуга по клику.
 */
import { browser } from "@core/env";
import { onDomChange } from "@core/dom";
import { log } from "@core/log";
import { showToast } from "@core/toast";
import { SITE, TEXT } from "@core/selectors";
import { isGameRoomPath } from "@shared/routes";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const SCOPE = "camera-health";

/** Команда зонду и его ответ — контракт с page/media-probe-page.ts. */
export const MEDIA_CMD_SOURCE = "pn-media-cmd";
export const MEDIA_RESULT_SOURCE = "pn-media-result";

export const BUTTON_ID = "pn-camera-reload";
export const OVERLAY_CLASS = "pn-stream-lost";
const PROBE_MARK = "data-pn-media-probe";

/** Пауза между проходами наблюдения; она же база для замера «кадры замерли». */
export const WATCH_INTERVAL_MS = 2000;
/** Через сколько после переподключения проверяем, помогло ли. */
const VERDICT_DELAY_MS = 7000;
/** Пауза после МЯГКОГО шага: дожатой подписке нужна пара секунд на кадры. */
const SOFT_WAIT_MS = 3000;

// ─────────────────────────── чистые функции ───────────────────────────

interface TrackLike {
  muted?: boolean;
  readyState?: string;
}

/**
 * Причина смерти видео-дорожки. muted — браузер сам говорит «данные не идут»
 * (типичный обрыв сети у игрока); ended — дорожку закрыли совсем. Причина
 * пишется в журнал: по ней в логах различимы «упала сеть» и «камера убрана».
 */
export type DeadCause = "muted" | "ended" | "frozen";

export function deadCause(track: TrackLike | undefined): DeadCause | null {
  if (!track) return null;
  if (track.readyState === "ended") return "ended";
  if (track.muted === true) return "muted";
  return null;
}

export function isDeadTrack(track: TrackLike | undefined): boolean {
  return deadCause(track) !== null;
}

/**
 * Метка плитки для журнала — НОМЕР места, не ник: ники игроков в файл лога
 * не пишутся (решение владельца 02.08.2026; нарушение жило здесь с рождения
 * camera-health и поймано только внешним ревью 26.08.2026). Номер места в
 * разборе не хуже: «оборвалось у плитки 5» сопоставимо со стримом.
 */
export function tileLabel(tile: HTMLElement): string {
  let i = Array.from(document.querySelectorAll<HTMLElement>(SITE.playerDesktop)).indexOf(tile);
  // Фолбэк на голый .player: наблюдаемые camera-health плитки не обязаны
  // совпадать со строгим селектором стола (мобильная разметка, зритель).
  if (i < 0) i = Array.from(document.querySelectorAll<HTMLElement>(".player")).indexOf(tile);
  return i >= 0 ? `плитка ${i + 1}` : "плитка ?";
}

/**
 * Замёрзло ли видео: поток есть, дорожка формально жива, а currentTime не
 * сдвинулся с прошлого прохода. Один замер ничего не значит (пауза отдачи
 * бывает и у живого потока на долю секунды), поэтому решение принимает
 * вызывающий по числу подряд замёрзших проходов.
 */
export function isFrozen(prev: number | undefined, now: number): boolean {
  return prev !== undefined && prev === now;
}

/** Сколько подряд «замёрзших» проходов считаем обрывом (2 × 2с = 4 секунды). */
export const FROZEN_PASSES = 2;

/**
 * Идёт ли сейчас СВОЯ речь: в центре контролов стоит «Завершите речь».
 * Тот же признак, по которому living-кнопку различает controls-safety.
 */
export function ownSpeechInProgress(root: ParentNode = document): boolean {
  const center = root.querySelector<HTMLElement>(SITE.controlsCenter);
  if (!center) return false;
  return Array.from(center.querySelectorAll<HTMLElement>(SITE.controlsButton)).some((b) => {
    const t = (b.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    return TEXT.finishSpeechButton.some((m) => t.includes(m));
  });
}

// ─────────────────────────── менеджер ───────────────────────────

class CameraHealth {
  private settings: Partial<Settings> = {};
  private unsubscribe: (() => void) | null = null;
  private interval: number | null = null;
  private verdictTimer: ReturnType<typeof setTimeout> | null = null;
  private resultListener: ((e: MessageEvent) => void) | null = null;
  private probeInjected = false;
  /** Плитка → currentTime прошлого прохода (для «замерло»). */
  private lastTimes = new WeakMap<HTMLVideoElement, number>();
  /** Плитка → сколько проходов подряд кадры стоят. */
  private frozenPasses = new WeakMap<HTMLVideoElement, number>();
  /** Кнопка ждёт ответа зонда — повторные клики не шлют команду дважды. */
  private reconnecting = false;
  /** Текущий шаг лесенки: мягкий refresh или жёсткий reconnect. */
  private stage: "refresh" | "reconnect" | null = null;

  enable(ctx: FeatureContext): void {
    this.settings = ctx.settings;
    // Наблюдатель DOM держит кнопку на месте при перерисовках комнаты, а
    // интервал ведёт замеры дорожек: DOM-событий у muted-дорожки нет.
    this.unsubscribe = onDomChange(() => this.syncButton());
    this.interval = window.setInterval(() => this.tick(), WATCH_INTERVAL_MS);
    this.resultListener = (e: MessageEvent) => this.onProbeResult(e);
    window.addEventListener("message", this.resultListener);
    this.syncButton();
  }

  update(ctx: FeatureContext): void {
    this.settings = ctx.settings;
    this.syncButton();
    if (this.settings.stream_lost_icon_enabled === false) this.removeOverlays();
  }

  disable(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.verdictTimer !== null) {
      clearTimeout(this.verdictTimer);
      this.verdictTimer = null;
    }
    if (this.resultListener) {
      window.removeEventListener("message", this.resultListener);
      this.resultListener = null;
    }
    this.reconnecting = false;
    this.stage = null;
    document.getElementById(BUTTON_ID)?.remove();
    this.removeOverlays();
  }

  // ─────────── наблюдение за плитками ───────────

  private tick(): void {
    if (!isGameRoomPath(location.pathname)) {
      this.removeOverlays();
      this.syncButton();
      return;
    }
    if (this.settings.stream_lost_icon_enabled === false) return;
    for (const tile of Array.from(document.querySelectorAll<HTMLElement>(SITE.player))) {
      // Своя плитка: локальный поток от сети не зависит, метка на себе врала бы.
      if (tile.classList.contains("my-player")) continue;
      const video = tile.querySelector<HTMLVideoElement>(SITE.playerVideoEl);
      this.markTile(tile, video ? this.probeVideo(video) : null);
    }
  }

  /** Латч: про запрет Xray говорим в журнал один раз, а не каждые 2 секунды. */
  private xrayWarned = false;

  /** Причина смерти потока этого <video>; null — живой. */
  private probeVideo(video: HTMLVideoElement): DeadCause | null {
    const stream = video.srcObject as MediaStream | null;
    if (!stream) {
      // Потока нет — сайт сам рисует заглушку, наша метка была бы дублёром.
      this.frozenPasses.delete(video);
      return null;
    }
    let track: TrackLike | undefined;
    try {
      track = stream.getVideoTracks?.()[0];
    } catch {
      // Firefox Xray может не пустить к потоку страницы — тогда работаем
      // только по currentTime, это честная деградация, а не поломка.
      track = undefined;
      if (!this.xrayWarned) {
        this.xrayWarned = true;
        log.warn(SCOPE, "браузер не пустил к дорожкам потока — метка работает по замершим кадрам");
      }
    }
    const byTrack = deadCause(track);
    if (byTrack) {
      this.frozenPasses.delete(video);
      return byTrack;
    }
    const now = video.currentTime;
    const frozen = isFrozen(this.lastTimes.get(video), now) && !video.paused;
    this.lastTimes.set(video, now);
    const passes = frozen ? (this.frozenPasses.get(video) ?? 0) + 1 : 0;
    this.frozenPasses.set(video, passes);
    return passes >= FROZEN_PASSES ? "frozen" : null;
  }

  /** Поставить/снять метку обрыва. Идемпотентно (§4 п.1). */
  private markTile(tile: HTMLElement, cause: DeadCause | null): void {
    const wrapper = tile.querySelector<HTMLElement>(SITE.playerVideoWrapper) ?? tile;
    const existing = wrapper.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`);
    if (!cause) {
      if (existing) {
        existing.remove();
        // Снятие тоже в журнал: пара «оборвалось → ожило» и есть картина
        // инцидента; без второй половины лог читается как вечный обрыв.
        log.info(SCOPE, `видео ожило: «${tileLabel(tile)}»`);
      }
      return;
    }
    if (existing) return;
    const badge = document.createElement("div");
    badge.className = OVERLAY_CLASS;
    badge.dataset.pnCause = cause;
    badge.title = "Видео от игрока не приходит — похоже, у него оборвалась связь";
    badge.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "pointer-events:none;z-index:5;background:rgba(0,0,0,.25)";
    badge.innerHTML =
      '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" ' +
      'stroke-width="2" stroke-linecap="round" style="filter:drop-shadow(0 0 3px rgba(0,0,0,.9))">' +
      '<path d="M1 1l22 22"/>' +
      '<path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>' +
      '<path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>' +
      '<path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>' +
      '<path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>' +
      '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>' +
      '<line x1="12" y1="20" x2="12" y2="20"/></svg>';
    wrapper.appendChild(badge);
    log.info(SCOPE, `видео оборвалось: «${tileLabel(tile)}» (${cause})`);
  }

  private removeOverlays(): void {
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
  }

  // ─────────── кнопка «Перезагрузить камеры» ───────────

  private syncButton(): void {
    const wanted =
      isGameRoomPath(location.pathname) && this.settings.camera_reload_enabled !== false;
    const existing = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
    if (!wanted) {
      existing?.remove();
      return;
    }
    const button = existing ?? this.createButton();
    this.placeButton(button);
    // Блок на время своей речи — обновляется каждым проходом наблюдателя.
    const speaking = ownSpeechInProgress();
    const disabled = speaking || this.reconnecting;
    if (button.disabled !== disabled) {
      button.disabled = disabled;
      button.classList.toggle("disabled", disabled);
      button.style.opacity = disabled ? "0.5" : "1";
      button.title = speaking
        ? "Идёт твоя речь — переподключение спрячет твою камеру у всех"
        : this.reconnecting
          ? "Переподключаю…"
          : "Пересоздать видеосвязь без перезагрузки страницы (чинит зависшие камеры)";
    }
  }

  private createButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    // Иконка «камера + стрелка обновления», без текста: кнопка живёт в ряду
    // РОДНЫХ иконок сайта и обязана выглядеть их роднёй, а не чужой плашкой
    // (жалоба владельца 14.08.2026: первая версия висела поверх логотипа).
    button.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>' +
      '<path d="M9.5 13a2.5 2.5 0 0 1 4.62-1.33"/>' +
      '<path d="M14.5 13a2.5 2.5 0 0 1-4.62 1.33"/>' +
      '<path d="M14.2 10.2v1.6h-1.6"/><path d="M9.8 15.8v-1.6h1.6"/></svg>';
    button.addEventListener("click", () => this.reconnect());
    return button;
  }

  /**
   * Куда встаёт кнопка. Дом — правый ряд контролов сайта (там живут его
   * камера/микрофон/настройки). Ряд перерисовывается Vue — проверка на
   * каждом проходе наблюдателя возвращает кнопку на место. Фолбэк без ряда —
   * плавающая НАД логотипом комнаты (bottom:70px), а не поверх него.
   *
   * Вид копируется с СОСЕДНЕЙ живой кнопки ряда (getComputedStyle), а не
   * классами сайта: его стили scoped (data-v-*) и на чужой узел не действуют
   * — с классами наша <button> показывала БРАУЗЕРНЫЙ светлый фон и торчала
   * белым пятном (жалоба владельца 14.08.2026, второй заход). Фолбэк-цвета —
   * из room/bundle/style.css (#464952, скругление 1rem).
   */
  private placeButton(button: HTMLButtonElement): void {
    const host = document.querySelector<HTMLElement>(".controls .right");
    if (host) {
      if (button.parentElement !== host) {
        button.className = "";
        const sibling = Array.from(host.children).find(
          (el): el is HTMLElement =>
            el !== button && el instanceof HTMLElement && el.classList.contains("button"),
        );
        const cs = sibling ? getComputedStyle(sibling) : null;
        const bg =
          cs?.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)"
            ? cs.backgroundColor
            : "#464952";
        const radius = cs?.borderRadius && cs.borderRadius !== "0px" ? cs.borderRadius : "1rem";
        const height = sibling && sibling.offsetHeight > 0 ? `height:${sibling.offsetHeight}px;` : "";
        button.style.cssText =
          "display:flex;align-items:center;justify-content:center;border:none;cursor:pointer;" +
          `color:#fff;min-width:3.833rem;padding:0 .9375rem;${height}` +
          `background:${bg};border-radius:${radius}`;
        host.prepend(button);
      }
      return;
    }
    if (button.parentElement !== document.body) {
      button.className = "";
      button.style.cssText =
        "position:fixed;bottom:70px;left:12px;z-index:2147483000;display:flex;align-items:center;" +
        "justify-content:center;width:36px;height:36px;border-radius:8px;cursor:pointer;" +
        "border:1px solid rgba(255,255,255,.25);background:rgba(11,27,57,.85);color:#e6e9f0";
      document.body.appendChild(button);
    }
  }

  /** Ленивый инжект зонда: тег появляется только после первого клика. */
  private ensureProbe(onReady: () => void): void {
    if (this.probeInjected) {
      onReady();
      return;
    }
    const s = document.createElement("script");
    s.setAttribute(PROBE_MARK, "");
    s.src = browser.runtime.getURL("media-probe-page.js");
    s.onload = () => {
      s.remove();
      this.probeInjected = true;
      onReady();
    };
    s.onerror = () => {
      s.remove();
      showToast("Не удалось поставить обработчик видео — попробуй перезагрузить страницу");
      log.warn(SCOPE, "media-probe-page.js не загрузился");
    };
    (document.head || document.documentElement).appendChild(s);
  }

  /** Ники плиток с меткой обрыва — картина «до» и «после» для журнала. */
  private deadLabels(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>(`.${OVERLAY_CLASS}`)).map((badge) => {
      const tile = badge.closest<HTMLElement>(SITE.player);
      return tile ? tileLabel(tile) : "?";
    });
  }

  private sendCmd(action: "refresh" | "reconnect"): void {
    this.stage = action;
    this.ensureProbe(() => {
      try {
        window.postMessage({ source: MEDIA_CMD_SOURCE, action }, location.origin);
      } catch {
        this.reconnecting = false;
        this.stage = null;
      }
    });
    // Страховка: зонд не ответил (страница перерисовалась, скрипт умер) —
    // кнопка не должна остаться заблокированной навсегда.
    this.verdictTimer = setTimeout(() => {
      if (this.reconnecting) {
        this.reconnecting = false;
        this.stage = null;
        this.syncButton();
        showToast("Видео не ответило на переподключение — похоже, нужен F5");
        log.warn(SCOPE, `зонд не ответил на команду ${action}`);
        log.flushNow();
      }
    }, VERDICT_DELAY_MS);
  }

  private reconnect(): void {
    if (this.reconnecting) return;
    // Гейт от гонки: речь могла начаться между проходами наблюдателя.
    if (ownSpeechInProgress()) {
      showToast("Идёт твоя речь — после неё");
      return;
    }
    this.reconnecting = true;
    this.syncButton();
    // Картина «до» — без неё по журналу не понять, что именно чинили.
    log.info(SCOPE, `кнопка камер: мёртвых плиток ${this.deadLabels().length} [${this.deadLabels().join(", ")}]`);
    showToast("Обновляю видео…");
    // ЛЕСЕНКА. Сначала мягкий шаг: updateStreams() дожимает отложенные
    // подписки и не рвёт ничего — у остальных даже не мигнёт. Жёсткое
    // пересоздание — только если мягкого не хватило.
    this.sendCmd("refresh");
  }

  private onProbeResult(e: MessageEvent): void {
    if (e.source !== window) return;
    const d = e.data as { source?: string; ok?: unknown; reason?: unknown };
    if (d?.source !== MEDIA_RESULT_SOURCE) return;
    // Ответ принимается ТОЛЬКО пока мы его ждём. postMessage доступен и самой
    // странице: без гейта поддельный «результат» в простое запускал бы наши
    // таймеры и тосты без единого клика (находка adversarial 14.08.2026).
    if (!this.reconnecting) return;
    if (this.verdictTimer !== null) {
      clearTimeout(this.verdictTimer);
      this.verdictTimer = null;
    }
    const step = this.stage ?? "reconnect";
    if (d.ok !== true) {
      this.reconnecting = false;
      this.stage = null;
      this.syncButton();
      const reason = typeof d.reason === "string" ? d.reason : "unknown";
      log.warn(SCOPE, `шаг ${step} не удался: ${reason}`);
      log.flushNow();
      showToast(
        reason === "media_not_connected"
          ? "Видеосвязь ещё не поднята — переподключать нечего"
          : "Не удалось обновить видео — сайт изменился или матч не идёт. Поможет F5",
      );
      return;
    }

    if (step === "refresh") {
      log.info(SCOPE, "мягкий шаг прошёл (updateStreams), жду кадры");
      // Дожатой подписке нужна пара секунд; если метки сошли — жёсткий шаг
      // не нужен вовсе, и ни у кого ничего не мигнуло.
      this.verdictTimer = setTimeout(() => {
        this.verdictTimer = null;
        const still = this.deadLabels();
        if (still.length === 0) {
          this.reconnecting = false;
          this.stage = null;
          this.syncButton();
          log.info(SCOPE, "хватило мягкого шага — соединения не трогали");
          log.flushNow();
          showToast("Видео обновлено");
          return;
        }
        log.info(SCOPE, `мягкого шага мало, остались [${still.join(", ")}] — пересоздаю сессию`);
        showToast("Не помогло мягко — переподключаю видео целиком…");
        this.sendCmd("reconnect");
      }, SOFT_WAIT_MS);
      return;
    }

    log.info(SCOPE, "медиа-сессия пересоздана");
    // Вердикт «помогло/нет» — по меткам обрыва спустя пару секунд: если
    // мёртвые плитки остались, честно говорим, что кнопка не всесильна.
    this.verdictTimer = setTimeout(() => {
      this.verdictTimer = null;
      this.reconnecting = false;
      this.stage = null;
      this.syncButton();
      const still = this.deadLabels();
      // Итог — в журнал и сразу на диск: это и есть доказательство «работает /
      // не работает» для разбора без повторной игры.
      log.info(
        SCOPE,
        still.length === 0
          ? "итог: все плитки ожили"
          : `итог: не ожили [${still.join(", ")}] — проблема на их стороне`,
      );
      log.flushNow();
      showToast(
        still.length > 0
          ? "Видео пересобрано, но у кого-то поток так и не идёт — проблема на его стороне"
          : "Видео пересобрано",
      );
    }, VERDICT_DELAY_MS);
  }
}

let manager: CameraHealth | null = null;

export const cameraHealthFeature: Feature = {
  id: "camera-health",
  // Фича без мастер-тумблера: обе половины гейтятся своими настройками внутри
  // (та же схема, что у controls-safety с его позициями).
  settingKey: null,

  enable(ctx: FeatureContext) {
    manager = new CameraHealth();
    manager.enable(ctx);
  },

  update(ctx: FeatureContext) {
    manager?.update(ctx);
  },

  disable() {
    manager?.disable();
    manager = null;
  },
};
