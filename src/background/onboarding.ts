/**
 * Онбординг: как игроку найти расширение (жалоба 06.08.2026 — стримеры не
 * знали, где настройки).
 *
 * Закрепить иконку ЗА пользователя браузер не позволяет — такого API не
 * существует, пин делается только руками через меню-пазл. Максимум честного:
 *  - страница-приветствие при ПЕРВОЙ установке;
 *  - при ОБНОВЛЕНИИ — разовая проверка action.getUserSettings().isOnToolbar
 *    (Chrome 91+, свежие Firefox): не закреплено и ещё не показывали —
 *    показать один раз за жизнь установки; закреплено — молчать навсегда;
 *  - точка на иконке (видна и в меню-пазле) до первого открытия попапа —
 *    попап снимает её и ставит ONBOARDING_SHOWN_KEY.
 * На обновлениях страница никогда не показывается повторно.
 */
import { browser } from "@core/env";
import { log } from "@core/log";

export const ONBOARDING_SHOWN_KEY = "onboarding_shown";

/** Первая ли это установка (а не обновление расширения/браузера). */
export function isFreshInstall(details: { reason?: string } | undefined): boolean {
  return details?.reason === "install";
}

/**
 * Решение при обновлении. Правило «не наглеть»: показ — не чаще одного раза
 * за жизнь установки; API недоступен (isOnToolbar === undefined) — молчим.
 */
export function onboardingUpdateDecision(
  alreadyShown: boolean,
  isOnToolbar: boolean | undefined,
): "show" | "remember-pinned" | "skip" {
  if (alreadyShown) return "skip";
  if (isOnToolbar === false) return "show";
  if (isOnToolbar === true) return "remember-pinned";
  return "skip";
}

export async function showOnboarding(activate: boolean): Promise<void> {
  try {
    await browser.storage.local.set({ [ONBOARDING_SHOWN_KEY]: true });
  } catch (e) {
    log.debug("onboarding", "flag save failed", e);
  }
  try {
    // activate=false на update-пути ОБЯЗАТЕЛЕН: обновление применяется в
    // произвольный момент сессии, и активная вкладка вылезла бы поверх
    // идущего матча — у стримера В ЭФИРЕ (ревью 06.08.2026, блокер).
    // Страница ждёт в фоне; точка на иконке доведёт до неё. При установке
    // activate=true честен: пользователь сам только что нажал «установить».
    await browser.tabs.create({
      url: browser.runtime.getURL("onboarding.html"),
      active: activate,
    });
  } catch (e) {
    log.debug("onboarding", "tab failed", e);
  }
  try {
    await browser.action.setBadgeText({ text: "•" });
    await browser.action.setBadgeBackgroundColor({ color: "#2c5cff" });
  } catch (e) {
    log.debug("onboarding", "badge failed", e);
  }
}

export async function maybeShowOnboardingOnUpdate(): Promise<void> {
  try {
    const st = (await browser.storage.local.get({ [ONBOARDING_SHOWN_KEY]: false })) as Record<
      string,
      unknown
    >;
    const settings = await (
      browser.action as { getUserSettings?: () => Promise<{ isOnToolbar?: boolean }> }
    ).getUserSettings?.();
    const decision = onboardingUpdateDecision(
      st[ONBOARDING_SHOWN_KEY] === true,
      settings?.isOnToolbar,
    );
    if (decision === "show") await showOnboarding(false);
    else if (decision === "remember-pinned") {
      await browser.storage.local.set({ [ONBOARDING_SHOWN_KEY]: true });
    }
  } catch (e) {
    log.debug("onboarding", "update check failed", e);
  }
}

/**
 * Диспетчер onInstalled — здесь, а не в background/index: третий коммит
 * подряд ревью ловило несторожимый call-site при покрытой чистой функции
 * (мутант перестановки веток проходил всю сюиту).
 */
export function handleInstalled(details: { reason?: string } | undefined): Promise<void> {
  if (isFreshInstall(details)) return showOnboarding(true);
  if (details?.reason === "update") return maybeShowOnboardingOnUpdate();
  return Promise.resolve();
}
