/**
 * Типизированная шина сообщений поверх runtime/tabs.
 * Заменяет россыпь chrome.runtime.onMessage со строковыми `action`/`type`.
 */
import { browser } from "./env";
import { log } from "./log";
import type { ExtMessage } from "@shared/types";

const GAME_TABS = { url: "*://*.polemicagame.com/*" } as const;

/**
 * Контекст расширения инвалидирован — вкладка «осиротела».
 *
 * При обновлении расширения браузер НЕ переинжектит content-скрипт в уже
 * открытый документ: старый скрипт продолжает работать, но любая его команда в
 * background с этого момента падает навсегда. Снаружи это выглядит как «всё
 * вдруг перестало работать», лечится только F5 — и до сих пор не оставляло в
 * логе ни следа, потому что ошибку глушил debug (разбор жалобы 02.08.2026).
 */
function isContextInvalidated(): boolean {
  // Канонический признак, а не текст ошибки: при инвалидации `runtime.id`
  // становится undefined. Матчить сообщение нельзя — «Receiving end does not
  // exist» приходит и в обычной ситуации «попап закрыт», и тогда фон писал бы
  // сам себе, что «вкладка осиротела и лечится F5» (ревью 02.08.2026, блокер:
  // строка попадала бы почти в каждый лог и уводила разбор не туда).
  try {
    return !browser.runtime?.id;
  } catch {
    // Доступ к runtime тоже бросает у осиротевшего скрипта.
    return true;
  }
}

/** Про осиротевшую вкладку пишем ОДИН раз: иначе строка засорит весь буфер. */
let orphanReported = false;

/** Отправить сообщение в runtime (background / popup). Ошибки «нет получателя» гасятся. */
export async function sendRuntime<T = unknown>(msg: ExtMessage): Promise<T | undefined> {
  try {
    return (await browser.runtime.sendMessage(msg)) as T;
  } catch (e) {
    const message = (e as Error)?.message || "";
    if (!orphanReported && isContextInvalidated()) {
      orphanReported = true;
      log.info(
        "messaging",
        "страница осиротела после обновления расширения — её код больше не",
        "достучится до фона; всё, что работает через фон (OBS, заметки в",
        "координаторе), тут мертво до перезагрузки страницы (F5)",
      );
    }
    log.debug("messaging", "runtime sendMessage no receiver", message);
    return undefined;
  }
}

/** Отправить сообщение в конкретную вкладку. */
export async function sendToTab<T = unknown>(tabId: number, msg: ExtMessage): Promise<T | undefined> {
  try {
    return (await browser.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    return undefined;
  }
}

/** Отправить сообщение в активную вкладку. */
export async function sendToActiveTab<T = unknown>(msg: ExtMessage): Promise<T | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id != null ? sendToTab<T>(tab.id, msg) : undefined;
}

/**
 * СТРОГАЯ отправка в активную вкладку: бросает, если получателя нет.
 *
 * Обычный sendToTab гасит ошибку и возвращает undefined — для рассылок это
 * правильно, но для КОМАНД («открой менеджер цветов») попап считал их
 * доставленными и закрывался, хотя в старой вкладке (после обновления
 * расширения) content-скрипта уже нет (аудит lifecycle 01.08.2026, №10).
 */
export async function sendToActiveTabStrict<T = unknown>(msg: ExtMessage): Promise<T> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error("no active tab");
  return (await browser.tabs.sendMessage(tab.id, msg)) as T;
}

/** Разослать сообщение во все вкладки игры. */
export async function broadcastToGameTabs(msg: ExtMessage): Promise<void> {
  const tabs = await browser.tabs.query(GAME_TABS);
  await Promise.all(tabs.map((t) => (t.id != null ? sendToTab(t.id, msg) : undefined)));
}

export type MessageHandler = (
  msg: ExtMessage,
  sender: chrome.runtime.MessageSender,
) => unknown | Promise<unknown> | void;

/** Подписаться на входящие сообщения. Возвращает функцию отписки. */
export function onMessage(handler: MessageHandler): () => void {
  const listener = (msg: unknown, sender: chrome.runtime.MessageSender) =>
    handler(msg as ExtMessage, sender);
  browser.runtime.onMessage.addListener(listener as never);
  return () => browser.runtime.onMessage.removeListener(listener as never);
}
