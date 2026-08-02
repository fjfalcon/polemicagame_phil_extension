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
import { onDomChange } from "@core/dom";
import { sendRuntime, onMessage } from "@core/messaging";
import { log } from "@core/log";
import { SITE } from "@core/selectors";
import type { Feature } from "@core/feature";

const SCOPE = "queue-guard";

/** Секундомер идущего поиска — см. SITE.searchInProgress (общий с queue-peek). */
const SEARCH_ACTIVE_SELECTOR = SITE.searchInProgress;

let visibilityListener: (() => void) | null = null;
let pageHideListener: (() => void) | null = null;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeDom: (() => void) | null = null;
let armed = false;

function isSearchPage(): boolean {
  return location.pathname === "/game-search" || location.pathname.startsWith("/game-search/");
}

function isSearching(): boolean {
  return !!document.querySelector(SEARCH_ACTIVE_SELECTOR);
}

function disarm(reason: string): void {
  // Счётчик попыток обнуляем и при снятии, и когда взводить уже нечего:
  // следующий эпизод поиска обязан получить свежий бюджет.
  armAttempts = 0;
  armFailureLogged = false;
  if (!armed) return;
  armed = false;
  void sendRuntime({ action: "queueGuardCancel" }).catch(() => {
    /* background спит — будильник и так одноразовый */
  });
  // Переход состояния: без него «уведомления не было» не отличалось от
  // «оно было снято по делу» (QG-2).
  log.info(SCOPE, "предупреждение о фоновой очереди снято:", reason);
}

/**
 * Сколько раз пробуем взвести будильник, прежде чем сдаться до смены
 * видимости. Без потолка отказ превращался в поток `warn` со скоростью
 * мутаций: `arm()` зовётся из onDomChange, секундомер очереди перерисовывается
 * раз в секунду, а реальные отказы (осиротевшая после обновления вкладка)
 * стойкие — цикл сам не заканчивался (ревью 02.08.2026).
 */
const MAX_ARM_ATTEMPTS = 3;
let armAttempts = 0;
let armFailureLogged = false;

function arm(): void {
  if (armed) return;
  if (armAttempts >= MAX_ARM_ATTEMPTS) return;
  armAttempts++;
  // Латч ставим ДО ответа (иначе на каждый тик уйдёт новый запрос), но
  // «взведено» объявляем только по подтверждению фона: раньше строка
  // утверждала успех, которого могло не быть — sendRuntime гасит отказ и
  // возвращает undefined (аудит наблюдаемости 02.08.2026, QG-1).
  armed = true;
  void sendRuntime<{ ok?: boolean; reason?: string }>({ action: "queueGuardArm" })
    .then((res) => {
      if (res?.ok) {
        armFailureLogged = false;
        log.info(SCOPE, "предупреждение о фоновой очереди взведено: будильник подтверждён");
        return;
      }
      armed = false;
      // По фронту: строка нужна один раз на эпизод, а не на каждую попытку.
      if (!armFailureLogged) {
        armFailureLogged = true;
        log.warn(
          SCOPE,
          "предупреждение о фоновой очереди НЕ взведено:",
          res?.reason ?? "фон не ответил",
          `— попыток ${armAttempts}/${MAX_ARM_ATTEMPTS}, игрока о разрыве очереди не предупредим`,
        );
      }
    })
    .catch((e) => log.debug(SCOPE, "arm failed", e));
}

/** Две независимые оси: фича включена настройкой И мы на нужном маршруте. */
let featureEnabled = false;
let onRoute = false;
/** Ресурсы реально подняты (идемпотентность). */
let routeActive = false;

/**
 * Ресурсы живут только при конъюнкции осей. Без гейта по настройке роутер
 * поднимал бы фичу в обход тумблера и мастер-выключателя (ревью пакета C).
 */
function applyQueueGuardState(): void {
  const want = featureEnabled && onRoute;
  if (want === routeActive) return;
  routeActive = want;
  if (want) setupQueueGuard();
  else teardownQueueGuard("фича выключена или ушли со страницы поиска");
}

/**
 * Поднять/снять ресурсы по маршруту.
 *
 * enable() раньше делал ранний return вне /game-search, а FeatureManager всё
 * равно считал фичу активной: зайдя на поиск переходом ВНУТРИ сайта (без
 * перезагрузки), игрок оставался без предупреждения о вылете из очереди до
 * F5 (аудит lifecycle 01.08.2026, находка 16). Теперь маршрут сверяет
 * единый роутер content/index.ts, а функция идемпотентна в обе стороны.
 */
export function syncQueueGuardRoute(active: boolean): void {
  onRoute = active;
  applyQueueGuardState();
}

function setupQueueGuard(): void {
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
     * Подтверждение поиска приходит АСИНХРОННО: сайт сначала шлёт
     * start_game_search и только по ответу on_start_game_search рисует
     * секундомер. Игрок, нажавший «Играть» и сразу ушедший на другую
     * вкладку, попадал в дыру — visibilitychange уже случился, секундомера
     * ещё не было, и будильник не взводился (аудит устойчивости 01.08.2026,
     * находка 11). Следим за появлением/исчезновением секундомера, пока
     * вкладка скрыта.
     */
    unsubscribeDom = onDomChange(() => {
      if (!document.hidden) return;
      if (isSearching()) arm();
      else disarm("поиск закончился в скрытой вкладке");
    });

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
}

function teardownQueueGuard(reason: string): void {
  disarm(reason);
  unsubscribeDom?.();
  unsubscribeDom = null;
  if (visibilityListener) {
    document.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }
  if (pageHideListener) {
    window.removeEventListener("pagehide", pageHideListener);
    pageHideListener = null;
  }
  unsubscribeMessages?.();
  unsubscribeMessages = null;
}

export const queueGuardFeature: Feature = {
  id: "queue-guard",
  settingKey: "queue_background_warning_enabled",
  enable() {
    featureEnabled = true;
    onRoute = isSearchPage();
    applyQueueGuardState();
  },
  disable() {
    featureEnabled = false;
    applyQueueGuardState();
    unsubscribeDom?.();
    unsubscribeDom = null;
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
