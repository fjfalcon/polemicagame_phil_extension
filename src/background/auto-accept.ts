/**
 * Автопринятие найденной игры: инжектит самодостаточную функцию во вкладку,
 * которая ищет и жмёт кнопку принятия (по тексту), затем наблюдает DOM 10 с.
 * Порт прежнего handleGameSearch на browser.scripting.
 */
import { browser } from "@core/env";
import { log } from "@core/log";

/** Функция выполняется В КОНТЕКСТЕ СТРАНИЦЫ — не может ссылаться на модули расширения. */
function injectedAutoAccept(): void {
  const TEXTS = ["начать игру", "готов", "подтвердить", "принять", "старт", "join", "ready"];
  const SELECTORS = [
    "button.button-comp.outline",
    "button.button.preset-1",
    ".button-comp.outline",
    ".button.preset-1",
    '[class*="button"][class*="primary"]',
    '[class*="button"][class*="accept"]',
    "button",
  ];

  const clickAccept = (): boolean => {
    for (const sel of SELECTORS) {
      for (const btn of Array.from(document.querySelectorAll(sel))) {
        const t = (btn.textContent || "").trim().toLowerCase();
        if (TEXTS.some((x) => t.includes(x))) {
          try {
            (btn as HTMLElement).click();
            return true;
          } catch {
            btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
          }
        }
      }
    }
    return false;
  };

  if (!clickAccept()) {
    const interval = setInterval(() => {
      if (clickAccept()) clearInterval(interval);
    }, 100);
    setTimeout(() => clearInterval(interval), 10_000);
  }
  const observer = new MutationObserver(() => clickAccept());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  setTimeout(() => observer.disconnect(), 10_000);
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
