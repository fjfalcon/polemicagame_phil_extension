/**
 * Background entry.
 * Работает и как service_worker (Chrome), и как event page background.scripts (Firefox):
 * никаких обращений к window/document, только WebExtensions + WebSocket.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { onMessage } from "@core/messaging";
import { getSettings } from "@core/settings";
import { ObsClient } from "./obs-client";
import { handleGameSearch } from "./auto-accept";
import type { ExtMessage, ObsCommandMsg } from "@shared/types";

const obs = new ObsClient();

async function handleObsCommand(cmd: ObsCommandMsg["command"], data: ObsCommandMsg["data"]) {
  switch (cmd) {
    case "connect":
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

log.info("background", "ready");
