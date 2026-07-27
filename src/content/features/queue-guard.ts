/**
 * Фича: предупреждение «вернись на вкладку, иначе выкинет из очереди».
 *
 * ПОЧЕМУ ОНА НУЖНА (замер 27.07.2026, docs/queue-timeout-report.md):
 * сервер очереди объявляет pingInterval 25s / pingTimeout 20s, а ping в
 * engine.io v3 шлёт КЛИЕНТ по setTimeout. В фоновой вкладке браузер душит
 * таймеры (дрейф +1s → +16s → +55s), очередной ping не уходит, и сервер
 * закрывает сессию ровно через 45s после последнего — это ~1 мин 40 сек
 * после сворачивания. `reconnection: false` у сайта означает, что возврата
 * в очередь не будет даже когда игрок вернётся на вкладку.
 *
 * Отменить троттлинг расширение не может — только предупредить заранее.
 *
 * ПОЧЕМУ ТАЙМЕР В BACKGROUND: setTimeout в самой фоновой вкладке душат тем
 * же троттлингом, что и ping сайта, — предупреждение опоздало бы к разрыву.
 * chrome.alarms живёт в background и троттлингу вкладки не подвержен.
 */
import { sendRuntime, onMessage } from "@core/messaging";
import { log } from "@core/log";
import type { Feature } from "@core/feature";

const SCOPE = "queue-guard";

/**
 * Блок секундомера идущего поиска. Гейт именно по СЕКУНДОМЕРУ: класс
 * `--search` сайт вешает и на скелетон загрузки кнопки (ветка
 * `isSearchBtnLoading`), где очереди ещё нет, — по одному классу гард
 * взводился бы впустую.
 */
const SEARCH_ACTIVE_SELECTOR = ".p-play__profile-game--search .p-play__profile-game-search-time";

let visibilityListener: (() => void) | null = null;
let pageHideListener: (() => void) | null = null;
let unsubscribeMessages: (() => void) | null = null;
let armed = false;

function isSearchPage(): boolean {
  return location.pathname === "/game-search" || location.pathname.startsWith("/game-search/");
}

function isSearching(): boolean {
  return !!document.querySelector(SEARCH_ACTIVE_SELECTOR);
}

function disarm(reason: string): void {
  if (!armed) return;
  armed = false;
  void sendRuntime({ action: "queueGuardCancel" }).catch(() => {
    /* background спит — будильник и так одноразовый */
  });
  log.debug(SCOPE, "disarmed", reason);
}

function arm(): void {
  if (armed) return;
  armed = true;
  void sendRuntime({ action: "queueGuardArm" }).catch((e) =>
    log.debug(SCOPE, "arm failed", e),
  );
  log.info(SCOPE, "armed: вкладка скрыта во время поиска");
}

export const queueGuardFeature: Feature = {
  id: "queue-guard",
  settingKey: "queue_background_warning_enabled",
  enable() {
    if (!isSearchPage()) return;

    visibilityListener = () => {
      // visibilitychange доставляется сразу и троттлингу не подвержен.
      if (document.hidden) {
        if (isSearching()) arm();
      } else {
        disarm("вкладка снова видна");
      }
    };
    document.addEventListener("visibilitychange", visibilityListener);

    /**
     * Опрос от background в момент срабатывания будильника. Ответ ЭТОЙ
     * вкладки — единственный достоверный источник: сам background судить не
     * может (tab.active истинно и у свёрнутого ОКНА, а его модульное
     * состояние не переживает выгрузку service worker'а). Нет ответа =
     * вкладки нет = уведомление не нужно.
     */
    unsubscribeMessages = onMessage((msg) => {
      if ("action" in msg && msg.action === "queueGuardPing") {
        return Promise.resolve({
          hidden: document.hidden,
          searching: isSearching(),
        });
      }
      return undefined;
    });

    // Уход со страницы/закрытие — снимаем будильник, иначе прилетит
    // уведомление про очередь, из которой игрок уже вышел сам.
    pageHideListener = () => disarm("уход со страницы");
    window.addEventListener("pagehide", pageHideListener);

    // Страница могла открыться уже скрытой (восстановление сессии браузера).
    if (document.hidden && isSearching()) arm();
  },
  disable() {
    if (visibilityListener) {
      document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
    }
    if (pageHideListener) {
      window.removeEventListener("pagehide", pageHideListener);
      pageHideListener = null;
    }
    if (unsubscribeMessages) {
      unsubscribeMessages();
      unsubscribeMessages = null;
    }
    disarm("фича выключена");
  },
};
