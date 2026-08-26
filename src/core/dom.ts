/**
 * DOM-утилиты + один общий MutationObserver на документ.
 * Раньше каждый модуль вешал свой observe(document.body,{subtree:true}) — это давало
 * заметный оверхед на активной игре. Теперь один наблюдатель с подписчиками и debounce.
 */
import { log } from "./log";
import { isGameRoomPath } from "@shared/routes";

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

/**
 * Минимальная пауза между проходами подписчиков.
 *
 * Раньше flush шёл на каждый rAF (до 60 раз/с). В игровой комнате мутации не
 * прекращаются никогда: тикает таймер речи, сайт постоянно меняет style/class
 * на индикаторах звука — а мы подписаны ровно на эти атрибуты. Итог на слабой
 * машине: подписчики (полный проход по плиткам, кликеры auto-start, чистка
 * цветов) съедали главный поток, Vue сайта не успевал применять смену фаз и
 * обрабатывать клики. Жалоба 30.07.2026: «лагает, фазы не переходят, стрелять
 * не мог; удалил расширение — всё ок сразу» — страница ожила БЕЗ перезагрузки,
 * то есть дело было именно в съеденном CPU.
 *
 * 250мс — незаметная для глаза задержка появления наших кнопок/цветов, но
 * в непрерывном потоке мутаций это в ~15 раз меньше работы.
 */
const MIN_FLUSH_INTERVAL_MS = 250;

/** Общий наблюдатель за всем документом с debounce и набором подписчиков. */
class SharedDomObserver {
  private observer: MutationObserver | null = null;
  private subscribers = new Set<DomSubscriber>();
  private pending: MutationRecord[] = [];
  private dropped = 0;
  private scheduled = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastSlowLog = 0;
  private lastFlushAt = 0;
  /** Начало непрерывной серии проходов подряд (шторм); 0 — затишье было. */
  private busySince = 0;
  /** Штормовое предупреждение — раз на страницу (латч). */
  private stormLogged = false;
  private onVisibility: (() => void) | null = null;

  /** Число живых подписчиков — для fixpoint-харнеса («подписка реально
   *  создавалась», ревью 26.08.2026). Не для продакшен-логики. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

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
    // Набор опций — осознанный минимум (закреплён инвариантом в
    // tests/invariants/architecture.test.ts): childList + только атрибуты
    // class/style. characterData НЕ включён намеренно — текстовые тики
    // (таймеры, счётчики готовности) мутируют каждую секунду и затопили бы
    // очередь; подписчики и так пересканируют DOM по батчу childList.
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
      return;
    }
    // Дроссель: не раньше MIN_FLUSH_INTERVAL_MS после прошлого прохода.
    // rAF внутри таймера сохраняет прежнее свойство «работаем в кадре».
    const wait = this.lastFlushAt + MIN_FLUSH_INTERVAL_MS - performance.now();
    if (wait > 0) {
      this.timerId = setTimeout(() => {
        this.timerId = null;
        // Вкладка могла спрятаться, ПОКА дроссель-таймер ждал: rAF в фоне
        // заморожен, а scheduled=true заблокировал бы все будущие планирования
        // — подписчики скрытой вкладки (queue-guard!) умирали до возвращения
        // на экран (перф-аудит 06.08.2026, PERF-10). visibility-обработчик
        // эту гонку не видел: timerId был занят.
        if (document.hidden) this.flush();
        else requestAnimationFrame(() => this.flush());
      }, wait);
    } else {
      requestAnimationFrame(() => this.flush());
    }
  }

  /**
   * Сторож затишья (26.08.2026): вне игровой комнаты DOM обязан затихать.
   * В комнате мутации не прекращаются штатно (таймеры сайта), но на тихих
   * маршрутах (профиль, поиск вне очереди) минутный безостановочный поток
   * проходов — почти наверняка цикл нашего же подписчика «запись → мутация →
   * запись» (класс блокера профильных карточек). Ловим его в ЖИВОМ логе,
   * а не только в тестовом харнесе.
   */
  private trackStorm(startedAt: number, prevFlushAt: number): void {
    const gap = startedAt - prevFlushAt;
    // Отрицательный gap — прыжок часов (сон системы, тестовые часы): серию
    // начинаем заново, иначе busySince остаётся несведённым и сторож глохнет.
    const continuous = prevFlushAt > 0 && gap >= 0 && gap <= MIN_FLUSH_INTERVAL_MS * 4;
    if (!continuous) {
      this.busySince = startedAt;
      return;
    }
    if (this.busySince === 0) this.busySince = prevFlushAt;
    if (
      !this.stormLogged &&
      this.busySince > 0 &&
      startedAt - this.busySince > 60_000 &&
      !isGameRoomPath(location.pathname)
    ) {
      this.stormLogged = true;
      log.warn(
        "dom",
        "поток мутаций не затихает дольше минуты вне комнаты — возможен цикл DOM-подписчика",
      );
    }
  }

  private flush() {
    this.scheduled = false;
    const prevFlushAt = this.lastFlushAt;
    this.lastFlushAt = performance.now();
    this.trackStorm(this.lastFlushAt, prevFlushAt);
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
    this.busySince = 0;
  }
}

export const domObserver = new SharedDomObserver();

/** Подписаться на изменения DOM через общий наблюдатель. */
export function onDomChange(fn: DomSubscriber): () => void {
  return domObserver.subscribe(fn);
}

/**
 * Покрасить текст ника (плитка игрока, список «Участники»). Идемпотентно:
 * style пишется только при смене цвета (маркер data-pn-nick-color), потому
 * что вызывается из подписчиков onDomChange, а безусловная запись style
 * будила бы самого наблюдателя (инвариант AGENTS.md §4 п.1).
 * Пустой color снимает покраску. Градиенты — через background-clip: text.
 */
export function paintNickEl(el: HTMLElement, color: string, owner?: string): void {
  if (
    (el.dataset.pnNickColor || "") === color &&
    (owner === undefined || el.dataset.pnNickFor === owner)
  ) {
    return;
  }
  if (!color) {
    delete el.dataset.pnNickColor;
    delete el.dataset.pnNickFor;
    el.style.removeProperty("color");
    el.style.removeProperty("background");
    el.style.removeProperty("-webkit-background-clip");
    el.style.removeProperty("background-clip");
    return;
  }
  el.dataset.pnNickColor = color;
  // Владелец покраски — для сторожа пересадки (плитку может занять другой игрок).
  if (owner !== undefined) el.dataset.pnNickFor = owner;
  else delete el.dataset.pnNickFor;
  if (color.includes("gradient")) {
    el.style.background = color;
    el.style.setProperty("-webkit-background-clip", "text");
    el.style.setProperty("background-clip", "text");
    el.style.setProperty("color", "transparent");
  } else {
    el.style.removeProperty("background");
    el.style.removeProperty("-webkit-background-clip");
    el.style.removeProperty("background-clip");
    el.style.setProperty("color", color);
  }
}
