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
import { OBS_RETRY_BLOCKED_KEY, ObsClient } from "./obs-client";
import { handleGameSearch, handleStopSearch } from "./auto-accept";
import type { ExtMessage, ObsCommandMsg } from "@shared/types";

const obs = new ObsClient();
const OBS_WATCHDOG_ALARM = "polemica:obs-watchdog";
const OBS_MANUAL_DISCONNECT_KEY = "obs_manual_disconnect";
let obsQueue: Promise<void> = Promise.resolve();

function enqueueObs<T>(task: () => Promise<T> | T): Promise<T> {
  const result = obsQueue.then(task, task);
  obsQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function setManualDisconnect(value: boolean): Promise<void> {
  await browser.storage.local.set({ [OBS_MANUAL_DISCONNECT_KEY]: value });
}

async function isManuallyDisconnected(): Promise<boolean> {
  const stored = await browser.storage.local.get({ [OBS_MANUAL_DISCONNECT_KEY]: false });
  return stored[OBS_MANUAL_DISCONNECT_KEY] === true;
}

async function isAutoReconnectBlocked(): Promise<boolean> {
  const stored = await browser.storage.local.get({ [OBS_RETRY_BLOCKED_KEY]: false });
  return stored[OBS_RETRY_BLOCKED_KEY] === true;
}

async function setObsWatchdog(enabled: boolean): Promise<void> {
  if (!enabled) {
    await browser.alarms.clear(OBS_WATCHDOG_ALARM);
    return;
  }
  const alarm = await browser.alarms.get(OBS_WATCHDOG_ALARM);
  if (!alarm) await browser.alarms.create(OBS_WATCHDOG_ALARM, { periodInMinutes: 1 });
}

async function reconcileObsConnection(probe = false, ignorePersistedBlock = false): Promise<void> {
  const s = await getSettings();
  const suspended = await isManuallyDisconnected();
  if (!s.obs_enabled || !s.obs_host || suspended) {
    try {
      await setObsWatchdog(false);
    } finally {
      if (obs.hasConnectionActivity()) obs.disconnect();
    }
    return;
  }

  await setObsWatchdog(true);
  if (obs.isConnectedTo(s.obs_host, s.obs_password)) {
    if (!probe || (await obs.verifyConnection())) return;
  }
  if (obs.isAutoReconnectBlocked()) return;
  if (!ignorePersistedBlock && (await isAutoReconnectBlocked())) return;
  await obs.connect(s.obs_host, s.obs_password);
}

async function handleObsCommand(cmd: ObsCommandMsg["command"], data: ObsCommandMsg["data"]) {
  return enqueueObs(async () => {
    switch (cmd) {
      case "connect":
        await setManualDisconnect(false);
        await obs.allowAutoReconnect();
        await setObsWatchdog(true);
        obs.resetReconnectAttempts();
        return obs.connect(data?.url ?? "", data?.password ?? "");
      case "disconnect":
        try {
          await Promise.all([setManualDisconnect(true), setObsWatchdog(false)]);
        } finally {
          obs.disconnect();
        }
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
  });
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

function restoreObsConnection(probe = false): void {
  void enqueueObs(() => reconcileObsConnection(probe)).catch((e) =>
    log.error("background", "restore OBS failed", e),
  );
}

/**
 * Разовые миграции при обновлении расширения.
 *  1. Попапы ≤8.1.22 писали twitch_floating_panel_enabled=false в sync при
 *     КАЖДОМ сохранении настроек (настройка тогда никем не читалась). В 8.1.23
 *     тумблер ожил — и панель чата молча пропала бы у всех её пользователей.
 *     Один раз возвращаем true; дальше значением управляет пользователь.
 *  2. Legacy-попап хранил пароль OBS в storage.sync ОТКРЫТЫМ ТЕКСТОМ; фикс
 *     LOCAL_KEYS закрыл только новые записи — старый пароль синкается в облако
 *     у всех пользователей той эпохи до сих пор. Удаляем вместе с прочими
 *     ключами-сиротами удалённых фич. (playerNotes/notes/tagCustomColors в
 *     sync НЕ трогаем — это мост миграции заметок для вторых устройств.)
 */
async function runUpgradeMigrations(): Promise<void> {
  try {
    const { pn_twitch_panel_restored_v1: done } = (await browser.storage.local.get(
      "pn_twitch_panel_restored_v1",
    )) as { pn_twitch_panel_restored_v1?: boolean };
    if (!done) {
      await browser.storage.sync.set({ twitch_floating_panel_enabled: true });
      await browser.storage.local.set({ pn_twitch_panel_restored_v1: true });
    }
    await browser.storage.sync.remove([
      "obs_password",
      "version",
      "remember_player_volume_enabled",
      "spotify_playlist_url",
      "player_type",
      "modulesDisabled",
    ]);
    await browser.storage.local.remove(["savedAvatarUrl", "playerVolumes"]);
  } catch (e) {
    log.error("background", "migrations failed", e);
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OBS_WATCHDOG_ALARM) restoreObsConnection(true);
});
browser.runtime.onStartup.addListener(() => restoreObsConnection());
browser.runtime.onInstalled.addListener(() => {
  void runUpgradeMigrations();
  restoreObsConnection();
});

// Диагностика: перехват ошибок + гейт персиста логов по настройке.
installErrorCapture("bg");
void getSetting("debug_logging_enabled").then((on) => log.setPersist(on));
onSettingsChanged((patch) => {
  if ("debug_logging_enabled" in patch) log.setPersist(patch.debug_logging_enabled === true);
  // Живая реакция на тумблер OBS: раньше выключение obs_enabled (в т.ч. с
  // другого устройства через sync) не рвало соединение — background смотрел
  // на настройку только при onStartup/onInstalled.
  if ("obs_enabled" in patch || "obs_host" in patch || "obs_password" in patch) {
    void enqueueObs(async () => {
      if (patch.obs_enabled === false) {
        try {
          await Promise.all([
            setManualDisconnect(false),
            obs.allowAutoReconnect(),
            setObsWatchdog(false),
          ]);
        } finally {
          obs.disconnect();
        }
        return;
      }
      if (patch.obs_enabled === true) {
        await setManualDisconnect(false);
        await obs.allowAutoReconnect();
      }
      if ("obs_host" in patch || "obs_password" in patch) await obs.allowAutoReconnect();
      await reconcileObsConnection(false, true);
    }).catch((e) => log.error("background", "OBS settings update failed", e));
  }
});

// Выполняется при каждом новом incarnation service worker, а не только при старте браузера.
restoreObsConnection();

log.info("background", "ready");
