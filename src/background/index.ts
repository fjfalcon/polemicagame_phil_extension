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
import type { ExtMessage, ObsCommandMsg } from "@shared/types";

const obs = new ObsClient();
const OBS_WATCHDOG_ALARM = "polemica:obs-watchdog";
/**
 * Будильник «вкладка поиска в фоне». Живёт в background осознанно: setTimeout
 * в самой скрытой вкладке душится тем же троттлингом, что и ping сайта
 * (docs/queue-timeout-report.md), и предупреждение опоздало бы к разрыву.
 * Минимум chrome.alarms — 0.5 минуты; берём 1 минуту: разрыв наступает
 * примерно на 100-й секунде, значит у игрока остаётся ~40 секунд на реакцию.
 */
const QUEUE_GUARD_ALARM = "polemica:queue-guard";
const QUEUE_GUARD_DELAY_MIN = 1;
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
  if (!s.extension_enabled || !s.obs_enabled || !s.obs_host || suspended) {
    try {
      await setObsWatchdog(false);
    } finally {
      if (obs.hasConnectionActivity()) obs.disconnect();
    }
    return;
  }

  if (obs.isConnectedTo(s.obs_host, s.obs_password)) {
    await setObsWatchdog(true);
    if (!probe || (await obs.verifyConnection())) return;
  }
  // Блок реконнекта (неверный пароль/версия): без соединения будить SW
  // каждую минуту бессмысленно — гасим watchdog, а не ставим его до проверки.
  if (obs.isAutoReconnectBlocked() || (!ignorePersistedBlock && (await isAutoReconnectBlocked()))) {
    await setObsWatchdog(false);
    return;
  }
  await setObsWatchdog(true);
  await obs.connect(s.obs_host, s.obs_password);
}

async function handleObsCommand(cmd: ObsCommandMsg["command"], data: ObsCommandMsg["data"]) {
  return enqueueObs(async () => {
    switch (cmd) {
      case "connect":
        if (!(await getSetting("extension_enabled"))) {
          throw new Error("Расширение выключено (тумблер в шапке настроек)");
        }
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
      default:
        throw new Error(`Unknown OBS command: ${cmd}`);
    }
  });
}

async function handleObsQuery(cmd: ObsCommandMsg["command"], data: ObsCommandMsg["data"]) {
  // Лёгкие операции НЕ сериализуются с reconcile/connect: probe watchdog'а
  // держит очередь до 10-20с, и get_status попапа / set_scene автомода
  // стояли бы за ним — «сцена переключилась через 15 секунд после фазы».
  switch (cmd) {
    case "get_status":
      return obs.getStatus();
    case "set_scene":
      return obs.setCurrentScene(data?.sceneName ?? "");
    case "get_scenes":
      return obs.requestSceneList();
    default:
      return handleObsCommand(cmd, data);
  }
}

onMessage((msg: ExtMessage, sender) => {
  if ("type" in msg && msg.type === "obs_command") {
    return handleObsQuery(msg.command, msg.data)
      .then((data) => ({ success: true, data }))
      .catch((e: Error) => ({ success: false, error: e.message }));
  }
  // startSearch/stopSearch: дублирующий background-инжект автопринятия удалён
  // в 9.0.2 (аудит устойчивости 01.08.2026, находка 13) — он был мёртв:
  // искал <button>, тогда как карточка принятия у сайта <div>, и жил 10
  // секунд при поиске, который длится минуты. Автопринятие делает
  // content-скрипт (auto-start). Сообщения приходить ещё могут (старая
  // вкладка до перезагрузки) — отвечаем и ничего не делаем.
  if ("action" in msg && (msg.action === "startSearch" || msg.action === "stopSearch")) {
    return Promise.resolve({ ok: true });
  }
  // Возвращаем ПРОМИС операции, а не void: иначе service worker может уснуть
  // раньше, чем будильник реально создан/снят.
  if ("action" in msg && msg.action === "queueGuardArm") {
    return armQueueGuard(sender.tab?.id).then(() => ({ ok: true }));
  }
  if ("action" in msg && msg.action === "queueGuardCancel") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return Promise.resolve({ ok: false });
    const name = queueGuardAlarmName(tabId);
    // Гасим и уже показанную карточку: игрок вернулся сам, висящее
    // уведомление только мешает (и по клику потом дёрнет фокус вкладки).
    return Promise.all([
      browser.alarms.clear(name),
      browser.notifications?.clear?.(name)?.catch?.(() => undefined),
    ]).then(() => ({ ok: true }));
  }
  return undefined;
});

/**
 * id вкладки кодируется В ИМЕНИ будильника и уведомления, а не в модульной
 * переменной: service worker умирает через ~30с бездействия, то есть ЗАДОЛГО
 * до срабатывания на 60-й секунде, и любое состояние в памяти к этому моменту
 * потеряно. Имя будильника выгрузку переживает.
 */
function queueGuardAlarmName(tabId: number): string {
  return `${QUEUE_GUARD_ALARM}:${tabId}`;
}

function tabIdFromAlarmName(name: string): number | null {
  if (!name.startsWith(`${QUEUE_GUARD_ALARM}:`)) return null;
  const id = Number.parseInt(name.slice(QUEUE_GUARD_ALARM.length + 1), 10);
  return Number.isFinite(id) ? id : null;
}

async function armQueueGuard(tabId: number | undefined): Promise<void> {
  // Без id вкладки предупреждение некому адресовать и нечем проверить.
  if (tabId === undefined) return;
  const name = queueGuardAlarmName(tabId);
  await browser.alarms.clear(name);
  await browser.alarms.create(name, { delayInMinutes: QUEUE_GUARD_DELAY_MIN });
}

async function fireQueueGuardNotification(alarmName: string): Promise<void> {
  const tabId = tabIdFromAlarmName(alarmName);
  if (tabId === null) return;
  // Настройки перечитываем на момент срабатывания: их могли выключить, пока
  // будильник тикал (в т.ч. мастер-выключатель).
  const [enabled, extensionOn] = await Promise.all([
    getSetting("queue_background_warning_enabled"),
    getSetting("extension_enabled"),
  ]);
  if (!enabled || !extensionOn) return;

  // Спрашиваем саму вкладку. tab.active тут врёт: у свёрнутого ОКНА вкладка
  // остаётся active, и проверка глушила бы предупреждение ровно в главном
  // сценарии. Нет ответа (вкладку закрыли, страница ушла, расширение
  // выключено) — молчим.
  let reply: { hidden?: boolean; searching?: boolean } | undefined;
  try {
    reply = await browser.tabs.sendMessage(tabId, { action: "queueGuardPing" });
  } catch {
    return;
  }
  if (!reply?.hidden || !reply.searching) return;

  try {
    await browser.notifications.create(queueGuardAlarmName(tabId), {
      type: "basic",
      iconUrl: browser.runtime.getURL("icon128.png"),
      title: "Очередь поиска вот-вот оборвётся",
      message:
        "Вкладка Polemica скрыта — примерно через полминуты сервер выкинет вас из очереди. " +
        "Верните вкладку на экран, чтобы остаться в поиске.",
    });
  } catch (e) {
    log.error("background", "queue guard notification failed", e);
  }
}

browser.notifications?.onClicked?.addListener?.((id) => {
  const tabId = tabIdFromAlarmName(id);
  if (tabId === null) return;
  void browser.notifications.clear(id);
  // Клик = «верни меня в очередь»: показываем вкладку и поднимаем её окно.
  void browser.tabs
    .update(tabId, { active: true })
    .then((tab) =>
      tab?.windowId != null ? browser.windows.update(tab.windowId, { focused: true }) : undefined,
    )
    .catch((e) => log.debug("background", "focus queue tab failed", e));
});

/**
 * Просроченные будильники гарда переживают перезапуск браузера и выстрелили бы
 * уведомлением про очередь, которой давно нет (закрыли крышку ноутбука —
 * проснулись через два часа).
 */
async function clearStaleQueueGuards(): Promise<void> {
  try {
    const alarms = await browser.alarms.getAll();
    await Promise.all(
      alarms
        .filter((a) => tabIdFromAlarmName(a.name) !== null)
        .map((a) => browser.alarms.clear(a.name)),
    );
  } catch (e) {
    log.debug("background", "clear stale queue guards failed", e);
  }
}

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
  if (tabIdFromAlarmName(alarm.name) !== null) {
    // Просроченный будильник (крышку ноутбука закрыли на два часа) стреляет
    // сразу на пробуждении, когда WS-close ещё не долетел и на странице пока
    // виден секундомер — вкладка честно ответит «ищу», и мы соврали бы про
    // очередь, которой давно нет. Опаздавшие срабатывания игнорируем.
    if (Date.now() - alarm.scheduledTime > 15_000) {
      void browser.alarms.clear(alarm.name);
      return;
    }
    void fireQueueGuardNotification(alarm.name);
  }
});
browser.runtime.onStartup.addListener(() => {
  // Старт браузера сбрасывает persisted-блоки: пользователь мог исправить
  // пароль/версию НА СТОРОНЕ OBS — без сброса расширение никогда не
  // подключилось бы само (флаги переживают перезапуск). Ручное «Отключиться»
  // тоже считаем сессионным намерением — прежний контракт onStartup
  // всегда переподключался.
  void enqueueObs(async () => {
    await setManualDisconnect(false);
    await obs.allowAutoReconnect();
    await reconcileObsConnection();
  }).catch((e) => log.error("background", "startup OBS restore failed", e));
  void clearStaleQueueGuards();
});
browser.runtime.onInstalled.addListener(() => {
  void runUpgradeMigrations();
  restoreObsConnection();
  void clearStaleQueueGuards();
});

// Диагностика: перехват ошибок + гейт персиста логов по настройке.
installErrorCapture("bg");
void getSetting("debug_logging_enabled").then((on) => log.setPersist(on));
onSettingsChanged((patch) => {
  if ("debug_logging_enabled" in patch) log.setPersist(patch.debug_logging_enabled === true);
  // Живая реакция на тумблер OBS: раньше выключение obs_enabled (в т.ч. с
  // другого устройства через sync) не рвало соединение — background смотрел
  // на настройку только при onStartup/onInstalled.
  if (
    "obs_enabled" in patch ||
    "obs_host" in patch ||
    "obs_password" in patch ||
    "extension_enabled" in patch
  ) {
    void enqueueObs(async () => {
      // Мастер-выключатель рвёт OBS так же, как выключение obs_enabled.
      if (patch.obs_enabled === false || patch.extension_enabled === false) {
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
      if (patch.obs_enabled === true || patch.extension_enabled === true) {
        await setManualDisconnect(false);
        await obs.allowAutoReconnect();
      }
      if ("obs_host" in patch || "obs_password" in patch) {
        // Правка кредов снимает и ручную паузу: пользователь исправил пароль
        // и ждёт подключения — held manual-disconnect тут только мешает.
        await obs.allowAutoReconnect();
        await setManualDisconnect(false);
      }
      await reconcileObsConnection(false, true);
    }).catch((e) => log.error("background", "OBS settings update failed", e));
  }
});

// Выполняется при каждом новом incarnation service worker, а не только при старте браузера.
restoreObsConnection();

log.info("background", "ready");
