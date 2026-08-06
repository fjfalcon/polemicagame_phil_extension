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

export async function showOnboarding(): Promise<void> {
  try {
    await browser.storage.local.set({ [ONBOARDING_SHOWN_KEY]: true });
  } catch (e) {
    log.debug("onboarding", "flag save failed", e);
  }
  try {
    await browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") });
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
    if (decision === "show") await showOnboarding();
    else if (decision === "remember-pinned") {
      await browser.storage.local.set({ [ONBOARDING_SHOWN_KEY]: true });
    }
  } catch (e) {
    log.debug("onboarding", "update check failed", e);
  }
}
