/**
 * Content entry. Поднимает FeatureManager со всеми фичами и парсит данные матча.
 * FeatureManager сам включает/выключает фичи по настройкам (storage.onChanged),
 * поэтому отдельный роутинг сообщений в каждом модуле больше не нужен.
 */
import { log } from "@core/log";
import { FeatureManager } from "@core/feature";
import { parseMatchOnPage } from "./match-data";
import { setupNicknameLengthsResponder } from "./nickname-lengths";
import { setupDiagnostics } from "./diag";

import { searchFeature } from "./features/search";
import { autoStartFeature } from "./features/auto-start";
import { playerNotesFeature } from "./features/player-notes";
import { matchStatsFeature } from "./features/match-stats";
import { tooltipFeature } from "./features/tooltip";
import { roleFakerFeature } from "./features/role-faker";
import { pauseHotkeyFeature } from "./features/pause-hotkey";
import { cameraRotateFeature } from "./features/camera-rotate";
import { f5RefreshFeature } from "./features/f5-refresh";
import { playerVolumeFeature } from "./features/player-volume";
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
  cameraRotateFeature,
  f5RefreshFeature,
  playerVolumeFeature,
  updateNotifyFeature,
  obsPanelFeature,
  twitchPanelFeature,
);

void manager.start();
void parseMatchOnPage();
setupNicknameLengthsResponder();
setupDiagnostics();

log.info("content", "booted");
