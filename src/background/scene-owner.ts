/**
 * Кто из вкладок игры управляет автосценой OBS.
 *
 * Сцена в OBS одна на профиль, а вкладок игры может быть несколько — и каждая
 * независимо определяет фазу и шлёт set_scene: вторая вкладка (чужая игра,
 * открытая посмотреть) перебивала сцену активной трансляции (аудит lifecycle
 * 01.08.2026, находка 6).
 *
 * Решение вынесено из background отдельной ЧИСТОЙ функцией: у него четыре
 * входа (запись владения, живость вкладки, её маршрут, ручной ли клик) и
 * шесть исходов, а проверить их внутри модуля с сокетами, будильниками и
 * слушателями нечем. Жалоба «автосмена сцен перестала работать» разбиралась
 * вслепую именно поэтому (02.08.2026).
 */

/** Запись о владельце в storage.local. */
export interface SceneOwnerRecord {
  tabId?: number;
  ts?: number;
}

/**
 * Что ответила вкладка-владелец. Спрашиваем ЕЁ САМУ, а не браузер: `tabs.get`
 * успешен и для выгруженной вкладки, и для той, чей content-скрипт осиротел
 * после обновления расширения, и не отдаёт url без разрешения `tabs`.
 */
export type OwnerTabState =
  /** Не ответила: вкладки нет, она выгружена или её скрипт мёртв. */
  | { kind: "gone" }
  /** Ответила «да, автосцену веду я». */
  | { kind: "in-game" }
  /** Ответила «нет»: ушла с игры, авто-режим выключен, панели нет. */
  | { kind: "left-game" };

export interface OwnershipDecision {
  /** Пропустить команду смены сцены. */
  allow: boolean;
  /** Записать владение за вкладкой-просителем. */
  claim: boolean;
  /** Почему так решили — идёт в лог. */
  reason:
    | "manual"
    | "no-owner"
    | "same-tab"
    | "owner-alive"
    | "owner-gone"
    | "owner-left-game"
    | "owner-stale";
}

/**
 * Фолбэк-таймаут владения. НЕ 90 секунд: автосцена шлётся только на СМЕНЕ
 * фазы, а дневная фаза со всеми речами длится минуты — короткий TTL отдавал бы
 * владение соседней вкладке в середине игры и возвращал пинг-понг сцен (ревью
 * пакета D). Главный признак владения — ЖИВОСТЬ вкладки; таймаут нужен лишь
 * на случай, когда вкладку проверить не удалось.
 */
export const OWNER_TTL_MS = 20 * 60_000;

export function decideSceneOwnership(input: {
  current: SceneOwnerRecord | null;
  tabId: number;
  /** Клик пользователя в панели — он явно управляет сценой из этой вкладки. */
  manual: boolean;
  now: number;
  /**
   * Ответ вкладки-владельца или `null` — «не спрашивали» (решение принимается
   * раньше). Именно null, а не заглушка «свободно»: с заглушкой любая
   * перестановка проверок ниже молча раздала бы владение (ревью 02.08.2026).
   */
  ownerTab: OwnerTabState | null;
}): OwnershipDecision {
  const { current, tabId, manual, now, ownerTab } = input;
  // Ручной клик проходит ВСЕГДА и забирает владение: раньше он молча
  // игнорировался у не-владельца (ревью пакета D, блокер).
  if (manual) return { allow: true, claim: true, reason: "manual" };
  if (!current || typeof current.tabId !== "number") {
    return { allow: true, claim: true, reason: "no-owner" };
  }
  if (current.tabId === tabId) return { allow: true, claim: true, reason: "same-tab" };

  const stale = typeof current.ts !== "number" || now - current.ts > OWNER_TTL_MS;
  if (stale) return { allow: true, claim: true, reason: "owner-stale" };
  // Владельца не спрашивали — значит решать по нему нечего: НЕ раздаём сцену.
  if (!ownerTab) return { allow: false, claim: false, reason: "owner-alive" };
  if (ownerTab.kind === "gone") return { allow: true, claim: true, reason: "owner-gone" };
  // Вкладка ответила «не веду»: ушла с игры, матч доигран, авто-режим выключен.
  // Держать за ней сцену нельзя — иначе автосмена в НАСТОЯЩЕЙ игровой вкладке
  // молчит до конца TTL (самый частый бытовой случай).
  if (ownerTab.kind === "left-game") {
    return { allow: true, claim: true, reason: "owner-left-game" };
  }
  return { allow: false, claim: false, reason: "owner-alive" };
}
