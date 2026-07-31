/**
 * Единая точка доступа к WebExtensions API.
 * webextension-polyfill даёт Promise-based `browser.*` в обоих браузерах
 * (в Chrome он маппится на callback-based chrome.*).
 *
 * Везде в коде используем `browser`, импортированный отсюда, а не глобальный chrome.*.
 */
import browser from "webextension-polyfill";

export { browser };

/**
 * Установлено ли расширение из магазина (Chrome Web Store и его зеркала в
 * Яндекс.Браузере/Opera/Edge). Стор при раздаче добавляет в манифест
 * update_url — у распакованной версии и у нашего самоподписанного Firefox-xpi
 * его нет. Для стора обновления доставляет сам браузер, поэтому проверка
 * обновлений должна вести себя иначе (см. update-notify и попап).
 *
 * ВНИМАНИЕ: если когда-нибудь выйдем в каталог AMO (listed), такие установки
 * тоже будут без update_url — Firefox обновляет их сам, и этот детект их
 * ошибочно посчитает самораздачей. Понадобится отдельный признак.
 */
export function isStoreInstall(): boolean {
  try {
    return Boolean(
      (browser.runtime.getManifest() as { update_url?: string }).update_url,
    );
  } catch {
    return false;
  }
}
