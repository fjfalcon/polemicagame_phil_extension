/**
 * DOM-утилиты + один общий MutationObserver на документ.
 * Раньше каждый модуль вешал свой observe(document.body,{subtree:true}) — это давало
 * заметный оверхед на активной игре. Теперь один наблюдатель с подписчиками и debounce.
 */
import { log } from "./log";

/** Надёжный клик: нативный .click() + синтетическое событие как запасной путь. */
export function safeClick(el: Element): boolean {
  try {
    (el as HTMLElement).click();
    return true;
  } catch {
    try {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
      );
      return true;
    } catch (e) {
      log.warn("dom", "safeClick failed", e);
      return false;
    }
  }
}

/** Виден ли элемент (display/visibility/размеры). */
export function isVisible(el: Element): boolean {
  const s = getComputedStyle(el as HTMLElement);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

type DomSubscriber = (mutations: MutationRecord[]) => void;

/**
 * Максимум накопленных записей между проходами. Подписчики всё равно
 * пересканируют DOM, поэтому терять «хвост» безопасно — а вот держать
 * ссылки на сотни тысяч узлов (фоновая вкладка) уже нет.
 */
const MAX_PENDING = 4000;

/** Общий наблюдатель за всем документом с debounce и набором подписчиков. */
class SharedDomObserver {
  private observer: MutationObserver | null = null;
  private subscribers = new Set<DomSubscriber>();
  private pending: MutationRecord[] = [];
  private dropped = 0;
  private scheduled = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastSlowLog = 0;
  private onVisibility: (() => void) | null = null;

  subscribe(fn: DomSubscriber): () => void {
    this.subscribers.add(fn);
    this.ensureStarted();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  private ensureStarted() {
    if (this.observer) return;
    this.observer = new MutationObserver((muts) => {
      const room = MAX_PENDING - this.pending.length;
      if (room > 0) {
        // Без spread: `push(...muts)` на большой пачке даёт RangeError.
        for (let i = 0; i < muts.length && i < room; i++) this.pending.push(muts[i]);
      }
      if (muts.length > room) this.dropped += muts.length - Math.max(room, 0);
      this.schedule();
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // Если вкладку свернули после того, как rAF уже был запланирован, он
    // никогда не вызовется — подхватываем проход таймером.
    this.onVisibility = () => {
      if (document.hidden && this.scheduled && !this.timerId) {
        this.timerId = setTimeout(() => {
          this.timerId = null;
          this.flush();
        }, 500);
      }
    };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /**
   * В фоновой вкладке requestAnimationFrame не вызывается вовсе — раньше
   * мутации копились без разбора до возвращения на вкладку. Там переходим
   * на таймер, чтобы буфер регулярно опустошался.
   */
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    if (typeof document !== "undefined" && document.hidden) {
      this.timerId = setTimeout(() => {
        this.timerId = null;
        this.flush();
      }, 500);
    } else {
      requestAnimationFrame(() => this.flush());
    }
  }

  private flush() {
    this.scheduled = false;
    const batch = this.pending;
    this.pending = [];
    if (this.dropped) {
      log.warn("dom", `dropped ${this.dropped} mutation records (buffer cap)`);
      this.dropped = 0;
    }
    const started = performance.now();
    for (const fn of this.subscribers) {
      try {
        fn(batch);
      } catch (e) {
        log.error("dom", "subscriber threw", e);
      }
    }
    // Watchdog: тяжёлый проход по DOM — кандидат в «сайт сходит с ума».
    // Не чаще раза в 5 секунд: иначе сам watchdog забивает лог и storage.
    const dur = performance.now() - started;
    if (dur > 50 && started - this.lastSlowLog > 5000) {
      this.lastSlowLog = started;
      log.warn(
        "dom",
        `slow flush ${Math.round(dur)}ms, subs=${this.subscribers.size}, muts=${batch.length}`,
      );
    }
  }

  private stop() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.onVisibility) {
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.onVisibility = null;
    }
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.scheduled = false;
    this.pending = [];
    this.dropped = 0;
  }
}

export const domObserver = new SharedDomObserver();

/** Подписаться на изменения DOM через общий наблюдатель. */
export function onDomChange(fn: DomSubscriber): () => void {
  return domObserver.subscribe(fn);
}
