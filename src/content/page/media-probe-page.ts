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
    updateStreams?: () => void;
  } | null;
  createMediaRoom?: () => void;
  $store?: { state?: { gameId?: unknown } };
}

/**
 * Корневой компонент комнаты. Экспорт — тестовый шов.
 *
 * МАРШРУТОВ НЕСКОЛЬКО, и это не перестраховка: сайт собран на compat-сборке
 * Vue, чей mount НЕ заполняет `_instance` (сверено по живому бандлу: mount
 * пишет только `_container` и `__vue_app__`) — на реальной игре 14.08.2026
 * путь через `_instance` дал vue_root_not_found. Рабочий маршрут — через
 * `_vnode.component` контейнера (его пишет сам рендер Vue). `__vue__` —
 * страховка на случай, если компат-слой вернёт Vue2-поведение.
 */
interface VueContainer extends Element {
  __vue_app__?: {
    _instance?: { proxy?: RoomProxy } | null;
    _container?: { _vnode?: { component?: { proxy?: RoomProxy } | null } | null } | null;
  };
  _vnode?: { component?: { proxy?: RoomProxy } | null } | null;
  __vue__?: RoomProxy;
}

interface VueInstance {
  proxy?: RoomProxy | null;
  subTree?: VueVNode | null;
}
interface VueVNode {
  component?: VueInstance | null;
  children?: unknown;
}

/**
 * Похож ли компонент на комнату: у неё в data есть mediaRoom (пусть даже
 * null до подключения), а в methods — createMediaRoom. Проверка по `in`, а
 * не по значению: до старта медиа mediaRoom === null, и это НАША цель тоже.
 */
function looksLikeRoom(p: RoomProxy | null | undefined): p is RoomProxy {
  return !!p && typeof p === "object" && "mediaRoom" in p && "createMediaRoom" in p;
}

/** Потолок обхода: страховка от патологического дерева, не тонкая настройка. */
const WALK_LIMIT = 3000;

export function findRoomProxy(doc: Document): RoomProxy | null {
  const app = doc.querySelector("#app") as VueContainer | null;
  if (!app) return null;
  const root: VueInstance | null =
    app.__vue_app__?._instance ??
    app._vnode?.component ??
    app.__vue_app__?._container?._vnode?.component ??
    null;
  if (!root) return looksLikeRoom(app.__vue__) ? app.__vue__ : null;

  // ОБХОД ДЕРЕВА обязателен: на живой игре 14.08.2026 корневой компонент
  // оказался обёрткой без mediaRoom (media_room_not_found) — комната лежит
  // где-то под ним. Свойства subTree/component/proxy — рантайм-объекты Vue,
  // минификатор их не переименовывает (сверено по бандлу).
  const queue: VueInstance[] = [root];
  let visited = 0;
  const pushVNode = (vnode: VueVNode | null | undefined): void => {
    if (!vnode || typeof vnode !== "object") return;
    if (vnode.component) {
      queue.push(vnode.component);
      return;
    }
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) pushVNode(child as VueVNode);
    }
  };
  while (queue.length > 0 && visited < WALK_LIMIT) {
    const inst = queue.shift();
    visited++;
    if (!inst) continue;
    if (looksLikeRoom(inst.proxy)) return inst.proxy;
    pushVNode(inst.subTree);
  }
  return null;
}

/**
 * МЯГКИЙ шаг: mediaRoom.updateStreams() — публичный метод сайта. Для каждого
 * игрока он дожимает ОТЛОЖЕННУЮ подписку (события медиасервера, пропущенные
 * из-за гонки с состоянием комнаты, лежат в карте до этого вызова) и заново
 * раздаёт потоки по плиткам. Ничего не разрывает: у остальных игроков картинка
 * даже не мигнёт. Это максимально близкое к «обновить одного игрока», что
 * достижимо снаружи, — сами подписки заперты в замыкании.
 */
export function refreshStreams(doc: Document): string | null {
  const proxy = findRoomProxy(doc);
  if (!proxy) return "vue_root_not_found";
  const room = proxy.mediaRoom;
  if (!room) return "media_room_not_found";
  if (!room.isConnected) return "media_not_connected";
  if (typeof room.updateStreams !== "function") return "update_streams_missing";
  room.updateStreams();
  return null;
}

/**
 * ЖЁСТКИЙ шаг: пересоздать медиа-сессию. Возвращает причину отказа или null.
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
    if (d?.source !== MEDIA_CMD_SOURCE) return;
    if (d.action !== "reconnect" && d.action !== "refresh") return;
    let reason: string | null;
    try {
      reason = d.action === "refresh" ? refreshStreams(document) : reconnectMedia(document);
    } catch (err) {
      // Ошибка внутри кода сайта — честно наружу, но страницу не роняем.
      reason = `threw:${String(err).slice(0, 120)}`;
    }
    try {
      // action в ответе обязателен: content различает по нему шаги лесенки.
      window.postMessage(
        { source: MEDIA_RESULT_SOURCE, ok: reason === null, reason, action: d.action },
        location.origin,
      );
    } catch {
      /* страница уходит */
    }
  });
})();
