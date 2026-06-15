/**
 * Типизированная шина сообщений поверх runtime/tabs.
 * Заменяет россыпь chrome.runtime.onMessage со строковыми `action`/`type`.
 */
import { browser } from "./env";
import { log } from "./log";
import type { ExtMessage } from "@shared/types";

const GAME_TABS = { url: "*://*.polemicagame.com/*" } as const;

/** Отправить сообщение в runtime (background / popup). Ошибки «нет получателя» гасятся. */
export async function sendRuntime<T = unknown>(msg: ExtMessage): Promise<T | undefined> {
  try {
    return (await browser.runtime.sendMessage(msg)) as T;
  } catch (e) {
    log.debug("messaging", "runtime sendMessage no receiver", (e as Error)?.message);
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
