/**
 * Автопринятие найденной игры: инжектит самодостаточную функцию во вкладку,
 * которая ищет и жмёт кнопку принятия (по тексту), затем наблюдает DOM 10 с.
 * Порт прежнего handleGameSearch на browser.scripting.
 *
 * Дублирует автопринятие content-скрипта как страховка на случай, когда тот
 * ещё не загрузился. Поэтому правила безопасности здесь те же, что в
 * auto-start.ts: точное совпадение текста (подстрока «готов» ловила «Не готов»,
 * «принять» — «принять правила»), не больше 3 кликов на элемент, и один
 * экземпляр на вкладку (раньше каждый клик по «Поиску» вешал новый интервал
 * 100 мс + MutationObserver без дросселя на 10 секунд — они складывались).
 */
import { browser } from "@core/env";
import { log } from "@core/log";

/** Функция выполняется В КОНТЕКСТЕ СТРАНИЦЫ — не может ссылаться на модули расширения. */
function injectedAutoAccept(): void {
  // Повторный инжект, пока жив предыдущий — выходим сразу.
  const w = window as unknown as { __pnAutoAcceptUntil?: number };
  const now = Date.now();
  if (w.__pnAutoAcceptUntil && w.__pnAutoAcceptUntil > now) return;
  const DEADLINE = now + 10_000;
  w.__pnAutoAcceptUntil = DEADLINE;

  const TEXTS = ["начать игру", "готов", "подтвердить", "принять игру", "join", "ready"];
  const SELECTORS = [
    "button.button-comp.outline",
    "button.button.preset-1",
    ".button-comp.outline",
    ".button.preset-1",
    '[class*="button"][class*="primary"]',
    '[class*="button"][class*="accept"]',
    "button",
  ];
  const clicks = new WeakMap<Element, number>();

  const clickAccept = (): boolean => {
    for (const sel of SELECTORS) {
      for (const btn of Array.from(document.querySelectorAll(sel))) {
        const t = (btn.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (!TEXTS.includes(t)) continue;
        const r = (btn as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const used = clicks.get(btn) ?? 0;
        if (used >= 3) continue;
        clicks.set(btn, used + 1);
        try {
          (btn as HTMLElement).click();
          return true;
        } catch {
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
      }
    }
    return false;
  };

  if (!clickAccept()) {
    // Один канал повторов вместо интервала 100 мс + необузданного observer'а:
    // проверка раз в 300 мс до дедлайна.
    const interval = setInterval(() => {
      if (Date.now() > DEADLINE || clickAccept()) {
        clearInterval(interval);
        w.__pnAutoAcceptUntil = 0;
      }
    }, 300);
  } else {
    w.__pnAutoAcceptUntil = 0;
  }
}

export async function handleGameSearch(tabId: number | undefined): Promise<void> {
  if (tabId == null) return;
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func: injectedAutoAccept,
    });
  } catch (e) {
    log.error("auto-accept", "injection failed", e);
  }
}
