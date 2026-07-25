/**
 * Background entry.
 * Работает и как service_worker (Chrome), и как event page background.scripts (Firefox):
 * никаких обращений к window/document, только WebExtensions + WebSocket.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { installErrorCapture } from "@core/errors";
import { onMessage } from "@core/messaging";
import { getSettings, getSetting, onSettingsChanged } from "@core/settings";
import { ObsClient } from "./obs-client";
import { handleGameSearch, handleStopSearch } from "./auto-accept";
import type { ExtMessage, ObsCommandMsg } from "@shared/types";

const obs = new ObsClient();

async function handleObsCommand(cmd: ObsCommandMsg["command"], data: ObsCommandMsg["data"]) {
  switch (cmd) {
    case "connect":
      obs.resetReconnectAttempts();
      return obs.connect(data?.url ?? "", data?.password ?? "");
    case "disconnect":
      obs.disconnect();
      return true;
    case "get_status":
      return obs.getStatus();
    case "set_scene":
      return obs.setCurrentScene(data?.sceneName ?? "");
    case "get_scenes":
      return obs.requestSceneList();
    default:
      throw new Error(`Unknown OBS command: ${cmd}`);
  }
}

onMessage((msg: ExtMessage, sender) => {
  if ("type" in msg && msg.type === "obs_command") {
    return handleObsCommand(msg.command, msg.data)
      .then((data) => ({ success: true, data }))
      .catch((e: Error) => ({ success: false, error: e.message }));
  }
  if ("action" in msg && msg.action === "startSearch") {
    void handleGameSearch(sender.tab?.id);
    return Promise.resolve({ ok: true });
  }
  if ("action" in msg && msg.action === "stopSearch") {
    void handleStopSearch(sender.tab?.id);
    return Promise.resolve({ ok: true });
  }
  return undefined;
});

async function restoreObsConnection(): Promise<void> {
  try {
    const s = await getSettings();
    if (s.obs_enabled && s.obs_host) {
      setTimeout(() => {
        obs.connect(s.obs_host, s.obs_password).catch((e) =>
          log.error("background", "restore OBS failed", e),
        );
      }, 2000);
    }
  } catch (e) {
    log.error("background", "restore error", e);
  }
}

browser.runtime.onStartup.addListener(() => void restoreObsConnection());
browser.runtime.onInstalled.addListener(() => void restoreObsConnection());

// Диагностика: перехват ошибок + гейт персиста логов по настройке.
installErrorCapture("bg");
void getSetting("debug_logging_enabled").then((on) => log.setPersist(on));
onSettingsChanged((patch) => {
  if ("debug_logging_enabled" in patch) log.setPersist(patch.debug_logging_enabled === true);
  // Живая реакция на тумблер OBS: раньше выключение obs_enabled (в т.ч. с
  // другого устройства через sync) не рвало соединение — background смотрел
  // на настройку только при onStartup/onInstalled.
  if ("obs_enabled" in patch) {
    if (patch.obs_enabled === false) obs.disconnect();
    else void restoreObsConnection();
  }
});

log.info("background", "ready");
