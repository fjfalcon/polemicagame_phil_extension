/**
 * Зонд медиа-комнаты — PAGE-скрипт (мир страницы).
 *
 * Единственная задача: по явной команде расширения пересоздать медиа-сессию
 * комнаты — «F5 только для видео». Чат, журнал и состояние игры не трогаются.
 *
 * Почему это безопасно делать именно так: мы НЕ выдумываем свой путь, а
 * повторяем путь самого сайта. На ошибке «ice failed» его код делает
 *   mediaRoom.disconnect(true) → createMediaRoom() → mediaRoom.connect(gameId)
 * (метод createMediaRoomWithRelay, сверено с живым room/bundle/main.js
 * 14.08.2026). Единственное отличие: мы не включаем forceRelay — маршрут
 * трафика не меняем.
 *
 * `disconnect(true)` — аргумент обязателен: без него сайт останавливает
 * дорожки СВОЕЙ камеры (playerStream), и после переподключения игрок
 * публиковал бы мёртвый поток. Ровно поэтому сайт в relay-пути передаёт true.
 *
 * Имена (mediaRoom/createMediaRoom/connect/$store) — ключи объектов Vue,
 * минификатор их не переименовывает (сверено по бандлу). Если сайт
 * перепишут — зонд ответит honest-отказом, а не сломает страницу: каждый шаг
 * проверяется, всё под try/catch.
 *
 * Команду может подделать и сама страница — но это ничего ей не даёт: она и
 * так владеет своей медиа-сессией.
 *
 * ВАЖНО: файл самодостаточен — в мире страницы нет ни browser.*, ни модулей.
 */

/** Команда content-скрипта. */
export const MEDIA_CMD_SOURCE = "pn-media-cmd";
/** Ответ зонда. */
export const MEDIA_RESULT_SOURCE = "pn-media-result";

interface RoomProxy {
  mediaRoom?: {
    isConnected?: boolean;
    disconnect?: (keepStream: boolean) => void;
    connect?: (gameId: unknown) => void;
  } | null;
  createMediaRoom?: () => void;
  $store?: { state?: { gameId?: unknown } };
}

/** Корневой компонент комнаты. Экспорт — тестовый шов. */
export function findRoomProxy(doc: Document): RoomProxy | null {
  const app = doc.querySelector("#app") as
    | (Element & { __vue_app__?: { _instance?: { proxy?: RoomProxy } } })
    | null;
  return app?.__vue_app__?._instance?.proxy ?? null;
}

/**
 * Пересоздать медиа-сессию. Возвращает причину отказа или null при успехе.
 * Каждый шаг проверен отдельно: «не вышло» обязано быть диагнозом, а не
 * загадкой («vue root не найден» и «медиа не подключено» — разные ответы).
 */
export function reconnectMedia(doc: Document): string | null {
  const proxy = findRoomProxy(doc);
  if (!proxy) return "vue_root_not_found";
  const room = proxy.mediaRoom;
  if (!room || typeof room.disconnect !== "function") return "media_room_not_found";
  if (!room.isConnected) return "media_not_connected";
  if (typeof proxy.createMediaRoom !== "function") return "create_media_room_missing";
  const gameId = proxy.$store?.state?.gameId;
  if (gameId === undefined || gameId === null || gameId === "") return "game_id_missing";

  // Порядок сайта, шаг в шаг (relay-путь, без forceRelay).
  room.disconnect(true);
  proxy.mediaRoom = null;
  proxy.createMediaRoom();
  const fresh = proxy.mediaRoom as RoomProxy["mediaRoom"];
  if (!fresh || typeof fresh.connect !== "function") return "recreate_failed";
  fresh.connect(gameId);
  return null;
}

interface ProbeWindow extends Window {
  __pnMediaProbeInstalled?: boolean;
}

(() => {
  const w = window as ProbeWindow;
  if (w.__pnMediaProbeInstalled) return;
  w.__pnMediaProbeInstalled = true;

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const d = e.data as { source?: string; action?: unknown };
    if (d?.source !== MEDIA_CMD_SOURCE || d.action !== "reconnect") return;
    let reason: string | null;
    try {
      reason = reconnectMedia(document);
    } catch (err) {
      // Ошибка внутри кода сайта — честно наружу, но страницу не роняем.
      reason = `threw:${String(err).slice(0, 120)}`;
    }
    try {
      window.postMessage({ source: MEDIA_RESULT_SOURCE, ok: reason === null, reason }, location.origin);
    } catch {
      /* страница уходит */
    }
  });
})();
