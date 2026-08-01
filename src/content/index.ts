/**
 * Content entry. Поднимает FeatureManager со всеми фичами и парсит данные матча.
 * FeatureManager сам включает/выключает фичи по настройкам (storage.onChanged),
 * поэтому отдельный роутинг сообщений в каждом модуле больше не нужен.
 */
import { log } from "@core/log";
import { installErrorCapture } from "@core/errors";
import { getSetting, onSettingsChanged } from "@core/settings";
import { FeatureManager } from "@core/feature";
import { getMatchId, parseMatchOnPage } from "./match-data";
import { onMessage } from "@core/messaging";
import { browser } from "@core/env";
import { setupNicknameLengthsResponder } from "./nickname-lengths";
import { setupDiagnostics } from "./diag";

import { searchFeature } from "./features/search";
import { autoStartFeature } from "./features/auto-start";
import { playerNotesFeature, syncPlayerNotesRoute } from "./features/player-notes";
import { matchStatsFeature, syncMatchStatsRoute } from "./features/match-stats";
import { tooltipFeature } from "./features/tooltip";
import { roleFakerFeature } from "./features/role-faker";
import { pauseHotkeyFeature } from "./features/pause-hotkey";
import { f5RefreshFeature } from "./features/f5-refresh";
import { roleMarkerFeature } from "./features/role-marker";
import { updateNotifyFeature } from "./features/update-notify";
import { connectionDiagFeature, syncConnectionDiagRoute } from "./features/connection-diag";
import { queueGuardFeature, syncQueueGuardRoute } from "./features/queue-guard";
import { queuePeekFeature } from "./features/queue-peek";
import { queueRequeueFeature } from "./features/queue-requeue";
import { obsPanelFeature } from "./panels/obs-panel";
import { twitchPanelFeature } from "./panels/twitch-panel";

const manager = new FeatureManager().register(
  searchFeature,
  autoStartFeature,
  playerNotesFeature,
  matchStatsFeature,
  tooltipFeature,
  roleFakerFeature,
  pauseHotkeyFeature,
  f5RefreshFeature,
  roleMarkerFeature,
  updateNotifyFeature,
  connectionDiagFeature,
  queueGuardFeature,
  queuePeekFeature,
  queueRequeueFeature,
  obsPanelFeature,
  twitchPanelFeature,
);

function setupUrlRouter(extensionEnabledAtBoot: boolean): void {
  let extensionOn = extensionEnabledAtBoot;
  let lastHref = "";
  let lastMatchId: string | null | undefined;
  let scheduled = false;

  const reconcile = () => {
    scheduled = false;
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;

    const matchId = getMatchId();
    syncPlayerNotesRoute(matchId !== null);
    syncMatchStatsRoute(matchId);
    // Фичи страницы поиска: раньше они решали свою судьбу один раз в
    // enable() и при переходе ВНУТРИ сайта не поднимались до F5 (аудит
    // lifecycle 01.08.2026, находка 16). Функции идемпотентны и симметричны.
    const onSearch =
      location.pathname === "/game-search" || location.pathname.startsWith("/game-search/");
    syncQueueGuardRoute(onSearch);
    syncConnectionDiagRoute(onSearch);
    if (matchId !== lastMatchId) {
      lastMatchId = matchId;
      // Мастер-выключатель: не качаем страницу матча впустую — все
      // потребители gameDataParsed всё равно выключены FeatureManager'ом.
      if (extensionOn) void parseMatchOnPage(matchId);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(reconcile);
  };

  window.addEventListener("popstate", schedule);

  // pushState/replaceState сайта выполняются в другом JS-world, поэтому SPA-переходы
  // отслеживает дешёвое сравнение URL; back/forward дополнительно будит popstate.
  const fallbackTimer = window.setInterval(schedule, 500);
  const onPageShow = () => schedule();
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    clearInterval(fallbackTimer);
    window.removeEventListener("popstate", schedule);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
  };
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);

  onSettingsChanged((patch) => {
    if (!("extension_enabled" in patch)) return;
    extensionOn = patch.extension_enabled !== false;
    if (extensionOn) {
      // Пока расширение было выключено, парсинг пропускался — форсируем
      // полный проход, чтобы открытая страница матча ожила без F5.
      lastHref = "";
      lastMatchId = undefined;
      schedule();
    }
  });

  reconcile();
}

// Диагностика: перехват ошибок + гейт персиста логов по настройке.
installErrorCapture("content");
void getSetting("debug_logging_enabled").then((on) => log.setPersist(on));
onSettingsChanged((patch) => {
  if ("debug_logging_enabled" in patch) log.setPersist(patch.debug_logging_enabled === true);
});
// (pagehide-флеш логов теперь внутри core/log — общий для content и popup.)

void manager.start().catch((e) => log.error("content", "manager start failed", e));
// Роутер стартует после чтения мастер-выключателя: иначе первый reconcile()
// успел бы дёрнуть parseMatchOnPage до того, как мы узнали, что расширение
// выключено. Фичи всё равно инертны до manager.start() — задержка безвредна.
// catch ДО then: иначе синхронный throw из setupUrlRouter (например, из
// enhance при готовом кэше) поставил бы второй роутер поверх живого первого.
void getSetting("extension_enabled")
  .catch((e) => {
    log.error("content", "router boot failed", e);
    return true;
  })
  .then((on) => setupUrlRouter(on));
setupNicknameLengthsResponder();
setupDiagnostics();

/**
 * Ответ на вопрос «на какой версии ты работаешь».
 *
 * Браузер НЕ переинжектит content-скрипт в уже открытый документ после
 * обновления расширения: игра продолжает работать на старом коде, и понять
 * это со стороны попапа было нельзя (аудит lifecycle 01.08.2026, находка 3).
 * Баннер поверх игры мы намеренно НЕ показываем — сообщение появляется
 * только в попапе, когда пользователь сам его открыл.
 */
onMessage((msg) => {
  if ("type" in msg && msg.type === "getContentVersion") {
    return Promise.resolve({ version: browser.runtime.getManifest().version });
  }
  return undefined;
});

// Только origin+pathname: query/fragment могут нести приглашения и ключи, а
// лог выгружается в файл для поддержки (аудит безопасности 01.08.2026, №13).
log.info("content", "booted", navigator.userAgent, location.origin + location.pathname);
