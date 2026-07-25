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
  obsPanelFeature,
  twitchPanelFeature,
);

function setupUrlRouter(): void {
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
    if (matchId !== lastMatchId) {
      lastMatchId = matchId;
      void parseMatchOnPage(matchId);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(reconcile);
  };

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const pushStateWrapper: History["pushState"] = function (this: History, ...args): void {
    originalPushState.apply(this, args);
    schedule();
  };
  const replaceStateWrapper: History["replaceState"] = function (this: History, ...args): void {
    originalReplaceState.apply(this, args);
    schedule();
  };
  history.pushState = pushStateWrapper;
  history.replaceState = replaceStateWrapper;
  window.addEventListener("popstate", schedule);

  // В Chromium page и content script живут в разных JS-world: polling страхует
  // вызовы history API сайта, не видимые обёрткам isolated world.
  const fallbackTimer = window.setInterval(schedule, 500);
  const onPageShow = () => schedule();
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    clearInterval(fallbackTimer);
    window.removeEventListener("popstate", schedule);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
    if (history.pushState === pushStateWrapper) history.pushState = originalPushState;
    if (history.replaceState === replaceStateWrapper) history.replaceState = originalReplaceState;
  };
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);

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
setupUrlRouter();
setupNicknameLengthsResponder();
setupDiagnostics();

log.info("content", "booted", navigator.userAgent, location.href);
