// @vitest-environment jsdom
/**
 * Зонд медиа-комнаты («F5 только для видео»).
 *
 * Зонд дёргает ЖИВОЙ медиа-слой сайта, поэтому сторожим не «функции
 * вызвались», а порядок и аргументы штатного пути сайта: неправильный
 * аргумент disconnect убивает дорожки собственной камеры игрока, а
 * неправильный порядок оставляет комнату без медиа вовсе.
 */
import { describe, expect, test, vi } from "vitest";

import { findRoomProxy, reconnectMedia, refreshStreams } from "@content/page/media-probe-page";

function appWithProxy(proxy: unknown): void {
  document.body.innerHTML = `<div id="app"></div>`;
  (document.querySelector("#app") as Element & { __vue_app__?: unknown }).__vue_app__ = {
    _instance: { proxy },
  };
}

function workingProxy() {
  const calls: string[] = [];
  const freshRoom = {
    isConnected: false,
    connect: vi.fn((id: unknown) => calls.push(`connect:${String(id)}`)),
    disconnect: vi.fn(),
  };
  const proxy = {
    mediaRoom: {
      isConnected: true,
      disconnect: vi.fn((keep: boolean) => calls.push(`disconnect:${String(keep)}`)),
      connect: vi.fn(),
    },
    createMediaRoom: vi.fn(() => {
      calls.push("create");
      proxy.mediaRoom = freshRoom;
    }),
    $store: { state: { gameId: 42 } },
  };
  return { proxy, calls, freshRoom };
}

describe("штатный путь сайта, шаг в шаг", () => {
  test("disconnect(true) → createMediaRoom → connect(gameId) на НОВОЙ комнате", () => {
    const { proxy, calls, freshRoom } = workingProxy();
    appWithProxy(proxy);
    expect(reconnectMedia(document)).toBeNull();
    // Порядок — это и есть контракт: так делает сам сайт на «ice failed».
    expect(calls).toEqual(["disconnect:true", "create", "connect:42"]);
    expect(freshRoom.connect).toHaveBeenCalledWith(42);
  });

  test("disconnect обязан получить true — иначе гаснет СВОЯ камера", () => {
    // Без аргумента сайт останавливает дорожки playerStream, и после
    // переподключения игрок публиковал бы мёртвый поток. Это главный способ
    // навредить, поэтому проверяется отдельно от «порядок верный».
    const { proxy } = workingProxy();
    appWithProxy(proxy);
    const old = proxy.mediaRoom;
    reconnectMedia(document);
    expect(old.disconnect).toHaveBeenCalledWith(true);
  });
});

describe("честные отказы вместо поломки страницы", () => {
  test("нет #app или Vue — диагноз, а не исключение", () => {
    document.body.innerHTML = "<div>ничего</div>";
    expect(reconnectMedia(document)).toBe("vue_root_not_found");
    document.body.innerHTML = `<div id="app"></div>`;
    expect(reconnectMedia(document), "app без __vue_app__").toBe("vue_root_not_found");
  });

  test("медиа ещё не поднято — переподключать нечего", () => {
    const { proxy } = workingProxy();
    proxy.mediaRoom.isConnected = false;
    appWithProxy(proxy);
    expect(reconnectMedia(document)).toBe("media_not_connected");
    expect(proxy.createMediaRoom).not.toHaveBeenCalled();
  });

  test("нет gameId — не дёргаем disconnect ВООБЩЕ", () => {
    // Порвать соединение и не суметь поднять новое — хуже, чем не делать
    // ничего: проверки обязаны идти ДО первого разрушающего шага.
    const { proxy } = workingProxy();
    proxy.$store = { state: { gameId: undefined } } as never;
    appWithProxy(proxy);
    expect(reconnectMedia(document)).toBe("game_id_missing");
    expect(proxy.mediaRoom.disconnect).not.toHaveBeenCalled();
  });

  test("createMediaRoom не пересоздал комнату — признаёмся", () => {
    const { proxy } = workingProxy();
    proxy.createMediaRoom = vi.fn(() => {
      proxy.mediaRoom = null as never;
    });
    appWithProxy(proxy);
    expect(reconnectMedia(document)).toBe("recreate_failed");
  });

  test("мягкий шаг зовёт updateStreams и НИЧЕГО не рвёт", () => {
    // Смысл мягкого шага именно в бескровности: дожать отложенные подписки,
    // не трогая соединения, — у остальных игроков картинка не мигает.
    const { proxy } = workingProxy();
    (proxy.mediaRoom as { updateStreams?: () => void }).updateStreams = vi.fn();
    appWithProxy(proxy);
    expect(refreshStreams(document)).toBeNull();
    expect((proxy.mediaRoom as { updateStreams: () => void }).updateStreams).toHaveBeenCalled();
    expect(proxy.mediaRoom.disconnect).not.toHaveBeenCalled();
    expect(proxy.createMediaRoom).not.toHaveBeenCalled();
  });

  test("мягкий шаг без updateStreams — честный отказ", () => {
    const { proxy } = workingProxy();
    appWithProxy(proxy);
    expect(refreshStreams(document)).toBe("update_streams_missing");
  });

  test("findRoomProxy достаёт proxy из #app", () => {
    const { proxy } = workingProxy();
    appWithProxy(proxy);
    expect(findRoomProxy(document)).toBe(proxy);
  });
});
