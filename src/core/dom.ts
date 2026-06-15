/**
 * DOM-утилиты + один общий MutationObserver на документ.
 * Раньше каждый модуль вешал свой observe(document.body,{subtree:true}) — это давало
 * заметный оверхед на активной игре. Теперь один наблюдатель с подписчиками и debounce.
 */
import { log } from "./log";

/** Дождаться появления элемента по селектору (или null по таймауту). */
export function waitForSelector<T extends Element = Element>(
  selector: string,
  { timeout = 8000, root = document as ParentNode } = {},
): Promise<T | null> {
  const existing = root.querySelector<T>(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = root.querySelector<T>(selector);
      if (el) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeout);
  });
}

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

/** Общий наблюдатель за всем документом с debounce и набором подписчиков. */
class SharedDomObserver {
  private observer: MutationObserver | null = null;
  private subscribers = new Set<DomSubscriber>();
  private pending: MutationRecord[] = [];
  private rafScheduled = false;

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
      this.pending.push(...muts);
      if (this.rafScheduled) return;
      this.rafScheduled = true;
      requestAnimationFrame(() => this.flush());
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }

  private flush() {
    this.rafScheduled = false;
    const batch = this.pending;
    this.pending = [];
    for (const fn of this.subscribers) {
      try {
        fn(batch);
      } catch (e) {
        log.error("dom", "subscriber threw", e);
      }
    }
  }

  private stop() {
    this.observer?.disconnect();
    this.observer = null;
    this.pending = [];
  }
}

export const domObserver = new SharedDomObserver();

/** Подписаться на изменения DOM через общий наблюдатель. */
export function onDomChange(fn: DomSubscriber): () => void {
  return domObserver.subscribe(fn);
}
