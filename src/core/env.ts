/**
 * Единая точка доступа к WebExtensions API.
 * webextension-polyfill даёт Promise-based `browser.*` в обоих браузерах
 * (в Chrome он маппится на callback-based chrome.*).
 *
 * Везде в коде используем `browser`, импортированный отсюда, а не глобальный chrome.*.
 */
import browser from "webextension-polyfill";

export { browser };

export const isFirefox: boolean =
  typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);
