/**
 * Background entry.
 * Работает и как service_worker (Chrome), и как event page background.scripts (Firefox):
 * никаких обращений к window/document, только WebExtensions + WebSocket.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { installErrorCapture } from "@core/errors";
import { handleInstalled } from "./onboarding";
import { onMessage, sendToTab } from "@core/messaging";
import { getSettings, getSetting, onSettingsChanged } from "@core/settings";
import { applyNoteOps, mergeNotesViaCoordinator } from "./notes-coordinator";
import {
  OBS_RETRY_BLOCKED_KEY,
  OBS_RETRY_BLOCK_REASON_KEY,
  OBS_RECONNECT_ATTEMPTS_KEY,
  ObsClient,
} from "./obs-client";
import {
  OWNER_TTL_MS,
  decideSceneOwnership,
  type OwnerTabState,
  type SceneOwnerRecord,
} from "./scene-owner";
import type { ExtMessage, ObsCommandMsg } from "@shared/types";

const obs = new ObsClient();
const OBS_WATCHDOG_ALARM = "polemica:obs-watchdog";
/**
 * Будильник «вкладка поиска в фоне». Живёт в background осознанно: setTimeout
 * в самой скрытой вкладке душится тем же троттлингом, что и ping сайта
 * (docs/queue-timeout-report.md), и предупреждение опоздало бы к разрыву.
 * Минимум периода chrome.alarms на НАШЕМ минимуме (Chrome 116) — 1 минута
 * (0.5 появились только в Chrome 120); берём 1 минуту: разрыв наступает
 * примерно на 100-й секунде, значит у игрока остаётся ~40 секунд на реакцию.
 */
const QUEUE_GUARD_ALARM = "polemica:queue-guard";
const QUEUE_GUARD_DELAY_MIN = 1;
/**
 * Насколько опоздавший будильник ещё считаем полезным (см. onAlarm).
 * 90с: по замеру docs/queue-timeout-report.md сервер рвёт сессию на ~126-й
 * секунде, значит после этой границы предупреждать не о чем — а вкладка
 * сразу после пробуждения ещё не обработала WS-close и ответила бы «ищу».
 * Прежние 15с были слишком строгими (загруженная машина опаздывает на
 * десятки секунд), 3 минуты — слишком мягкими.
 */
const STALE_ALARM_CUTOFF_MS = 90_000;
const OBS_MANUAL_DISCONNECT_KEY = "obs_manual_disconnect";
/** Запись начата НАМИ (автозапись игр): только такую имеем право останавливать. */
const OBS_AUTO_RECORD_KEY = "obs_auto_record_started";
/** Длина буфера повторов, которую последний раз выставляли МЫ (секунды). */
const OBS_CLIP_RB_SET_KEY = "obs_clip_rb_set";
/** Последняя попытка редкого режима (бюджет исчерпан). В storage: SW смертен. */
const OBS_DEGRADED_ATTEMPT_KEY = "obs_degraded_attempt_at";
/**
 * Каденс редкого режима: самовосстановление ≤5 минут после того, как стример
 * перезапустил OBS, при ~12 наборах localhost в час вместо прежних 60.
 */
const DEGRADED_RETRY_MS = 5 * 60_000;
let obsQueue: Promise<void> = Promise.resolve();

function enqueueObs<T>(task: () => Promise<T> | T): Promise<T> {
  const result = obsQueue.then(task, task);
  obsQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Очередь операций записи/клипов. Отдельная от enqueueObs (та возит
 * 10-20-секундные connect/probe — запись к началу игры не должна их ждать),
 * но сериализует record/replay МЕЖДУ СОБОЙ: на переходе «комната → поиск →
 * комната» stop и start иначе интерливились, и новая игра оставалась без
 * записи при тосте «сохранена» (adversarial 26.08.2026, OBS-4/7).
 */
let recordQueue: Promise<unknown> = Promise.resolve();
function enqueueRecord<T>(task: () => Promise<T> | T): Promise<T> {
  const result = recordQueue.then(task, task);
  recordQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Сколько вкладок СЕЙЧАС в игровой комнате — спрашиваем сами вкладки
 * (инвариант §4 п.10: правду о вкладке знает только она; url-паттерн
 * считал живой discarded-вкладку и не видел комнату на голом /game —
 * adversarial 26.08.2026, OBS-5). Не ответившая вкладка комнатой не
 * считается: осиротевший content-скрипт запись не остановит никогда.
 */
async function countRoomTabs(excludeTabId?: number): Promise<number> {
  const tabs = await browser.tabs.query({ url: "*://*.polemicagame.com/*" });
  const answers = await Promise.all(
    tabs
      .filter((t) => t.id != null && t.id !== excludeTabId)
      .map((t) => sendToTab<{ inRoom?: boolean }>(t.id as number, { type: "obs_room_probe" })),
  );
  return answers.filter((a) => a?.inRoom === true).length;
}

/**
 * Сверка автозаписи — доостанавливает осиротевшую: вкладку закрыли/браузер
 * упал, record_stop не пришёл, запись писала бы диск до ручного вмешательства
 * (adversarial 26.08.2026, OBS-1/2/3). Зовётся минутным watchdog'ом и на
 * буте воркера. Только СТОП-сторона: автостарт отсюда перезапускал бы запись,
 * которую стример только что остановил руками.
 */
async function reconcileAutoRecord(): Promise<void> {
  await enqueueRecord(async () => {
    const st = (await browser.storage.local.get({ [OBS_AUTO_RECORD_KEY]: false })) as Record<
      string,
      unknown
    >;
    if (st[OBS_AUTO_RECORD_KEY] !== true) return;
    if (!obs.getStatus().connected) return; // без связи судить не о чем
    if (!(await obs.isRecording())) {
      // Запись уже не идёт (стример остановил сам / OBS перезапущен) —
      // протухший флаг обязан уйти, иначе однажды остановит ЧУЖУЮ запись.
      await browser.storage.local.remove(OBS_AUTO_RECORD_KEY);
      log.info("background", "автозапись: флаг протух (записи нет) — снят");
      return;
    }
    if ((await countRoomTabs()) > 0) return; // игра ещё идёт где-то
    const path = await obs.stopRecord();
    await browser.storage.local.remove(OBS_AUTO_RECORD_KEY);
    log.info("background", "автозапись: осиротевшая запись остановлена", path ?? "");
  }).catch((e) => log.warn("background", "сверка автозаписи не удалась", e));
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
      // Отключаем осознанно — и говорим почему. Раньше ранние return молчали,
      // а `disconnect()` отвязывает onclose, поэтому даже строки о закрытии не
      // было: в файле просто переставало что-либо происходить (OC-2).
      if (obs.hasConnectionActivity()) {
        const reason = !s.extension_enabled
          ? "расширение выключено"
          : suspended
            ? "пользователь нажал «Отключиться»"
            : !s.obs_enabled
              ? "интеграция с OBS выключена"
              : "не задан адрес OBS";
        log.info("background", "OBS отключён:", reason);
        obs.disconnect();
      }
    }
    return;
  }

  if (obs.isConnectedTo(s.obs_host, s.obs_password)) {
    await setObsWatchdog(true);
    if (!probe) return;
    // Живой heartbeat уже проверил канал — минутная alarm-проба поверх него
    // была 4-й GetVersion-пробой в минуту при бюджете ≤3 (PERF-8). Watchdog
    // пробует сам только когда heartbeat протух (воркер спал, интервал молчит).
    if (obs.hasFreshHeartbeat()) return;
    if (await obs.verifyConnection()) return;
    // Проба не прошла — соединение сейчас заменят. Без этой строки в файле
    // появлялось новое «подключено» без всякой причины (OC-3).
    log.warn("background", "проверка живости OBS не прошла — переподключаемся");
  }
  // Блок реконнекта (неверный пароль/версия): без соединения будить SW
  // каждую минуту бессмысленно — гасим watchdog, а не ставим его до проверки.
  if (obs.isAutoReconnectBlocked() || (!ignorePersistedBlock && (await isAutoReconnectBlocked()))) {
    const stored = (await browser.storage.local.get({ [OBS_RETRY_BLOCK_REASON_KEY]: null })) as Record<
      string,
      unknown
    >;
    const reason = stored[OBS_RETRY_BLOCK_REASON_KEY];
    // Состояние «само не починится»: watchdog гасим, и без строки это
    // выглядит как «расширение просто перестало подключаться» (OC-2).
    log.warn(
      "background",
      "подключение к OBS не выполняется: автоповторы заблокированы, причина:",
      reason === "protocol"
        ? "несовместимая версия obs-websocket"
        : reason === "auth"
          ? "OBS отверг аутентификацию"
          : // Блокировка могла достаться с версий до 9.0, где причина не
            // записывалась: называть её аутентификацией — уводить разбор.
            "причина не записана (блокировка с прежней версии)",
    );
    await setObsWatchdog(false);
    return;
  }
  // Бюджет попыток — ОБЩИЙ: исчерпанные 10 ретраев глушат плотную цепочку
  // attemptReconnect и переводят watchdog в РЕДКИЙ режим — одна попытка в
  // DEGRADED_RETRY_MS, а не каждую минуту (перф-аудит 06.08.2026, PERF-8).
  // Полная остановка была бы регрессом самовосстановления: OBS упал посреди
  // эфира → 10 попыток сгорают за ~2 минуты → стример перезапускает OBS —
  // и без редкого режима подключение не вернулось бы до ручных действий
  // (контрольное ревью 07.08.2026, блокер). Плотный режим возвращают ручное
  // «Подключиться», правка настроек OBS, onStartup, onInstalled — как и
  // раньше. Блокировка по паролю (4008/4009) проверена выше и священна.
  if (await obs.isAttemptBudgetExhausted()) {
    const st = (await browser.storage.local.get({ [OBS_DEGRADED_ATTEMPT_KEY]: 0 })) as Record<
      string,
      unknown
    >;
    const lastAt = typeof st[OBS_DEGRADED_ATTEMPT_KEY] === "number" ? (st[OBS_DEGRADED_ATTEMPT_KEY] as number) : 0;
    const now = Date.now();
    if (now - lastAt < DEGRADED_RETRY_MS) {
      // Будильник ЖИВ (иначе редкому режиму не от чего просыпаться), но
      // набирать OBS в этот тик рано.
      await setObsWatchdog(true);
      return;
    }
    await browser.storage.local.set({ [OBS_DEGRADED_ATTEMPT_KEY]: now });
    log.info(
      "background",
      "бюджет плотных попыток OBS исчерпан — пробуем в редком режиме (раз в",
      `${Math.round(DEGRADED_RETRY_MS / 60_000)} мин)`,
    );
    await setObsWatchdog(true);
    await obs.connect(s.obs_host, s.obs_password);
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

/**
 * Владелец автосцены OBS.
 *
 * Сцена в OBS одна на профиль, а вкладок игры может быть несколько — и
 * каждая независимо определяла фазу и слала set_scene: вторая вкладка
 * (например, чужая игра, открытая посмотреть) перебивала сцену активной
 * трансляции (аудит lifecycle 01.08.2026, находка 6). Владение хранится в
 * storage.local, поэтому переживает выгрузку service worker; отдаётся
 * первой вкладке, попросившей сцену, и переходит к другой, если владелец
 * умолк дольше OWNER_TTL_MS (закрыл вкладку, ушёл со страницы) или его
 * вкладки больше не существует.
 */
const OBS_SCENE_OWNER_KEY = "obs_scene_owner";

/**
 * Ведёт ли вкладка-владелец автосцену ПРЯМО СЕЙЧАС — спрашиваем у неё самой.
 *
 * Судить по `tabs.get` нельзя (ревью 02.08.2026, блокер): разрешения `tabs` у
 * нас нет, поэтому `tab.url` приходит ТОЛЬКО для вкладок polemicagame.com — то
 * есть у вкладки, ушедшей на другой сайт, url пустой, и проверка по нему
 * работала бы наоборот. Кроме того, `tabs.get` успешен и для выгруженной
 * вкладки, и для вкладки, чей content-скрипт осиротел после обновления
 * расширения. Опрос самой вкладки закрывает всё это разом (§4.10).
 */
/** Сколько ждём ответа владельца. Молчание = «владения нет». */
const OWNER_PING_TIMEOUT_MS = 1500;

async function inspectOwnerTab(ownerTabId: number): Promise<OwnerTabState> {
  // С таймаутом: sendToTab ловит отказ, но не ЗАВИСАНИЕ. Живая, но занятая
  // вкладка иначе подвесила бы set_scene просящей вкладки навсегда — тихая
  // заморозка автосмены (ревью 02.08.2026). «Нет ответа» здесь безопасно:
  // настоящий владелец переспросит на следующей смене фазы.
  const answer = await Promise.race([
    sendToTab<{ owning?: boolean }>(ownerTabId, { type: "obs_scene_owner_ping" }),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), OWNER_PING_TIMEOUT_MS)),
  ]);
  // Ответа нет — вкладки нет, она выгружена или её скрипт мёртв.
  if (!answer) return { kind: "gone" };
  return answer.owning ? { kind: "in-game" } : { kind: "left-game" };
}

/**
 * Очередь решений о владении. Между чтением записи и её перезаписью теперь
 * стоит МЕЖПРОЦЕССНЫЙ пинг (десятки мс вместо микросекунд): без сериализации
 * две вкладки, сменившие фазу одновременно, прочитали бы одного владельца,
 * обе получили бы «свободно» и обе переключили бы сцену — тот самый пинг-понг,
 * ради которого владение и вводилось (ревью 02.08.2026).
 *
 * Очередь СВОЯ, не obsQueue: смешивать с подключением к OBS нельзя — его probe
 * держит очередь до 10-20 секунд, и сцена переключалась бы с таким опозданием.
 */
let ownerQueue: Promise<unknown> = Promise.resolve();

function enqueueOwner<T>(task: () => Promise<T>): Promise<T> {
  const result = ownerQueue.then(task, task);
  ownerQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function claimSceneOwnership(tabId: number | undefined, manual = false): Promise<boolean> {
  // Команда не от вкладки (попап) — ручное действие пользователя.
  if (tabId == null) return true;
  return enqueueOwner(() => decideAndClaim(tabId, manual));
}

async function decideAndClaim(tabId: number, manual: boolean): Promise<boolean> {
  try {
    const st = (await browser.storage.local.get({ [OBS_SCENE_OWNER_KEY]: null })) as Record<
      string,
      unknown
    >;
    const cur = st[OBS_SCENE_OWNER_KEY] as SceneOwnerRecord | null;
    const now = Date.now();
    // Опрашиваем владельца ТОЛЬКО когда от его ответа что-то зависит: чужая
    // живая запись и не ручной клик. Иначе передаём null — «не спрашивали».
    const stale = !cur || typeof cur.ts !== "number" || now - cur.ts > OWNER_TTL_MS;
    const needTab =
      !manual && !stale && cur && typeof cur.tabId === "number" && cur.tabId !== tabId;
    const ownerTab: OwnerTabState | null = needTab
      ? await inspectOwnerTab(cur.tabId as number)
      : null;
    const decision = decideSceneOwnership({ current: cur, tabId, manual, now, ownerTab });
    if (!decision.allow) {
      // info, а не debug: в файл лога пишется только info, и разобрать жалобу
      // «автосмена сцен перестала работать» было нечем (02.08.2026).
      log.info(
        "background",
        "смена сцены пропущена: автосценой владеет другая вкладка",
        `owner=${cur?.tabId}`,
        `asked=${tabId}`,
      );
      return false;
    }
    if (decision.reason === "owner-left-game" || decision.reason === "owner-stale") {
      log.info(
        "background",
        "владение автосценой перешло к этой вкладке:",
        decision.reason === "owner-left-game" ? "прежний владелец ушёл с игры" : "прежний умолк",
        tabId,
      );
    }
    if (decision.claim) {
      await browser.storage.local.set({ [OBS_SCENE_OWNER_KEY]: { tabId, ts: now } });
    }
    return true;
  } catch (e) {
    // Хранилище недоступно — не блокируем автоматику.
    log.debug("background", "scene ownership check failed", e);
    return true;
  }
}

// Владелец закрыл вкладку — освобождаем владение сразу, не дожидаясь TTL:
// иначе сцена не обновится до следующей смены фазы в другой вкладке.
browser.tabs.onRemoved.addListener((closedId) => {
  void (async () => {
    try {
      const st = (await browser.storage.local.get({ [OBS_SCENE_OWNER_KEY]: null })) as Record<
        string,
        unknown
      >;
      const cur = st[OBS_SCENE_OWNER_KEY] as { tabId?: number } | null;
      if (cur && cur.tabId === closedId) {
        await browser.storage.local.remove(OBS_SCENE_OWNER_KEY);
        log.debug("background", "scene ownership released (owner tab closed)");
      }
    } catch {
      /* не критично: владение протухнет по TTL */
    }
  })();
});

async function handleObsQuery(
  cmd: ObsCommandMsg["command"],
  data: ObsCommandMsg["data"],
  tabId?: number,
) {
  // Лёгкие операции НЕ сериализуются с reconcile/connect: probe watchdog'а
  // держит очередь до 10-20с, и get_status попапа / set_scene автомода
  // стояли бы за ним — «сцена переключилась через 15 секунд после фазы».
  switch (cmd) {
    case "get_status":
      return obs.getStatus();
    case "set_scene": {
      // Только владелец автосцены; ручной клик проходит всегда.
      if (!(await claimSceneOwnership(tabId, data?.manual === true))) {
        // ЯВНЫЙ отказ, а не false: иначе content принимал его за успех и
        // подсвечивал сцену, которой в OBS нет (ревью пакета D, блокер).
        return { ignored: "not_owner" };
      }
      return obs.setCurrentScene(data?.sceneName ?? "");
    }
    case "get_scenes":
      return obs.requestSceneList();
    // ── запись и клипы (стримерский пакет 26.08.2026). Свой конвейер
    // enqueueRecord: сериализует record/replay между собой (гонки stop/start
    // на смене маршрута), но не ждёт длинные connect/probe из enqueueObs.
    case "record_start":
      return enqueueRecord(async () => {
        if (!obs.getStatus().connected) throw new Error("OBS не подключён");
        if (await obs.isRecording()) {
          // Запись уже идёт. НАША (флаг стоит — например, F5 посреди игры
          // или комната→комната) — просто продолжается. Чужая (флага нет —
          // стример пишет сам) — не присваиваем и не трогаем.
          return { already: true };
        }
        await obs.startRecord();
        await browser.storage.local.set({ [OBS_AUTO_RECORD_KEY]: true });
        return { started: true };
      });
    case "record_stop":
      return enqueueRecord(async () => {
        const st = (await browser.storage.local.get({ [OBS_AUTO_RECORD_KEY]: false })) as Record<
          string,
          unknown
        >;
        // Останавливаем ТОЛЬКО начатое нами: ручную запись стримера не трогаем.
        if (st[OBS_AUTO_RECORD_KEY] !== true) return { ignored: "not_ours" };
        if (!obs.getStatus().connected) throw new Error("OBS не подключён");
        if (!(await obs.isRecording())) {
          // Стример остановил сам — флаг протух, чистим.
          await browser.storage.local.remove(OBS_AUTO_RECORD_KEY);
          return { ignored: "not_active" };
        }
        // Другая вкладка ещё в комнате (стример смотрит две игры) — её игра
        // пишется тем же файлом. Комнатность спрашиваем у самих вкладок
        // (§4.10), а не по url-паттерну.
        if ((await countRoomTabs(tabId)) > 0) return { ignored: "other_room_tabs" };
        const path = await obs.stopRecord();
        // Флаг — ПОСЛЕ подтверждённой остановки: упавший stopRecord не должен
        // осиротить живую запись (adversarial 26.08.2026, OBS-1).
        await browser.storage.local.remove(OBS_AUTO_RECORD_KEY);
        return { stopped: true, path };
      });
    case "replay_save":
      return enqueueRecord(async () => {
        if (!obs.getStatus().connected) throw new Error("OBS не подключён");
        if (!(await obs.isReplayBufferActive())) {
          throw new Error(
            "Буфер повторов не запущен — включите Replay Buffer в настройках вывода OBS",
          );
        }
        await obs.saveReplayBuffer();
        return { saved: true };
      });
    case "replay_setup":
      return enqueueRecord(async () => {
        if (!obs.getStatus().connected) throw new Error("OBS не подключён");
        const seconds = Math.max(5, Math.min(3600, Math.round(data?.seconds ?? 60)));
        // Длину буфера пишем ТОЛЬКО когда её сменили в настройках расширения
        // (сравнение с тем, что писали МЫ в прошлый раз, а не с текущим
        // значением OBS): бут вкладки не должен молча перетирать длину,
        // выставленную стримером руками, и рестартовать буфер, теряя хвост
        // эфира (adversarial 26.08.2026, OBS-6).
        const prev = (await browser.storage.local.get({ [OBS_CLIP_RB_SET_KEY]: null })) as Record<
          string,
          unknown
        >;
        const changed = prev[OBS_CLIP_RB_SET_KEY] !== seconds;
        if (changed) {
          const mode = await obs.getProfileParameter("Output", "Mode");
          const category = mode === "Advanced" ? "AdvOut" : "SimpleOutput";
          await obs.setProfileParameter(category, "RecRBTime", String(seconds));
          await browser.storage.local.set({ [OBS_CLIP_RB_SET_KEY]: seconds });
        }
        const active = await obs.isReplayBufferActive();
        if (active && changed) {
          // Новая длина применяется только перезапуском буфера.
          await obs.stopReplayBuffer();
          await obs.startReplayBuffer();
        } else if (!active) {
          // Буфер выключен в настройках OBS — StartReplayBuffer скажет об этом.
          await obs.startReplayBuffer();
        }
        return { seconds, restarted: active && changed };
      });
    default:
      return handleObsCommand(cmd, data);
  }
}

onMessage((msg: ExtMessage, sender) => {
  if ("type" in msg && msg.type === "obs_command") {
    return handleObsQuery(msg.command, msg.data, sender.tab?.id)
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
  // Запись заметок идёт ТОЛЬКО отсюда: одна очередь на браузер (см.
  // notes-coordinator). Возвращаем промис, чтобы воркер не уснул на полпути.
  if ("type" in msg && msg.type === "notes_apply_ops") {
    return applyNoteOps(msg.ops);
  }
  if ("type" in msg && msg.type === "notes_merge") {
    return mergeNotesViaCoordinator(msg.incoming, msg.approvedReplaced);
  }
  // Возвращаем ПРОМИС операции, а не void: иначе service worker может уснуть
  // раньше, чем будильник реально создан/снят.
  if ("action" in msg && msg.action === "queueGuardArm") {
    // Честный ответ вместо безусловного ok. Раньше без id вкладки
    // armQueueGuard молча ничего не делал, а вкладке возвращалось {ok:true} —
    // она считала предупреждение взведённым и больше не пробовала. Ложное
    // свидетельство в логе хуже тишины (аудит наблюдаемости, QG-1).
    return armQueueGuard(sender.tab?.id).then((ok) =>
      ok ? { ok: true } : { ok: false, reason: "нет id вкладки" },
    );
  }
  // Сторож postgame-search: страница поиска спрашивает, держит ли КАКАЯ-ТО
  // другая вкладка живой матч игрока. Спрашиваем сами вкладки (инвариант
  // §4 п.10: достоверность состояния вкладки знает только она), а не
  // модульное состояние — SW мог только что проснуться.
  if ("type" in msg && msg.type === "postgame_live_query") {
    return probeLiveMatchTabs(sender.tab?.id);
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
 * Опрос игровых вкладок: держит ли какая-то из них ЖИВОЙ матч (не зритель,
 * не экран победы). Вкладка отправителя исключается: она на странице поиска.
 * Ошибки доставки (выгруженная/осиротевшая вкладка) sendToTab гасит в
 * undefined — это честное «не знаю», и оно НЕ считается живым матчем:
 * сторож дополнительный, отказ канала не должен блокировать явное действие
 * игрока (fail-open согласован ревью 07.08.2026).
 */
async function probeLiveMatchTabs(excludeTabId: number | undefined): Promise<{ live: boolean }> {
  // Паттерн шире /game (ловит и /game-search): лишние вкладки честно ответят
  // live:false — фильтр по маршруту делает сам контент-скрипт.
  const tabs = await browser.tabs.query({ url: "*://*.polemicagame.com/game*" });
  const answers = await Promise.all(
    tabs
      .filter((t) => t.id != null && t.id !== excludeTabId)
      .map((t) => sendToTab<{ live?: boolean }>(t.id as number, { type: "postgame_live_probe" })),
  );
  return { live: answers.some((a) => a?.live === true) };
}

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

async function armQueueGuard(tabId: number | undefined): Promise<boolean> {
  // Без id вкладки предупреждение некому адресовать и нечем проверить.
  if (tabId === undefined) return false;
  const name = queueGuardAlarmName(tabId);
  try {
    await browser.alarms.clear(name);
    await browser.alarms.create(name, { delayInMinutes: QUEUE_GUARD_DELAY_MIN });
    return true;
  } catch (e) {
    log.warn("background", "будильник очереди не создан", e);
    return false;
  }
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
    // Раньше тишина: «уведомления не было» не отличалось от сломанного
    // messaging (аудит наблюдаемости 02.08.2026, QG-2).
    log.info("background", "уведомление об очереди не показано: вкладка не ответила");
    return;
  }
  if (!reply?.hidden || !reply.searching) {
    log.info(
      "background",
      "уведомление об очереди не нужно:",
      !reply?.hidden ? "вкладка снова на экране" : "поиск уже не идёт",
    );
    return;
  }

  try {
    await browser.notifications.create(queueGuardAlarmName(tabId), {
      type: "basic",
      iconUrl: browser.runtime.getURL("icon128.png"),
      title: "Очередь поиска вот-вот оборвётся",
      message:
        "Вкладка Polemica скрыта — примерно через полминуты сервер выкинет вас из очереди. " +
        "Верните вкладку на экран, чтобы остаться в поиске.",
    });
    log.info("background", "уведомление об очереди создано");
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

/**
 * Когда последний reconcile через restoreObsConnection ЗАВЕРШИЛСЯ.
 * Свежий service worker, разбуженный watchdog-будильником, выполняет restore
 * дважды — при загрузке модуля и в onAlarm — то есть до двух connect-попыток
 * за одно пробуждение (перф-аудит 06.08.2026, PERF-8: «one reconcile/wake»).
 * Дедупликация только для alarm-пробы (probe=true): явные restore
 * (onInstalled после сброса блокировки, загрузка модуля) идут всегда.
 * Окно меньше периода будильника (1 мин), поэтому штатные минутные пробы
 * живого воркера не задевает.
 */
let lastReconcileAt = 0;
const WAKE_RECONCILE_DEDUPE_MS = 30_000;

function restoreObsConnection(probe = false): void {
  void enqueueObs(async () => {
    // Дедуп «одна сверка на пробуждение» — для ЛЮБОГО пути (PERF26-12):
    // top-level инкарнации + onStartup ставили ДВЕ сверки подряд, и при
    // недоступном хосте очередь держалась до 20 секунд двумя connect'ами.
    if (Date.now() - lastReconcileAt < WAKE_RECONCILE_DEDUPE_MS) return;
    try {
      await reconcileObsConnection(probe);
    } finally {
      lastReconcileAt = Date.now();
    }
  }).catch((e) => log.error("background", "restore OBS failed", e));
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
      // Пишем ТОЛЬКО если значения в sync ещё нет: local-флаг живёт на
      // устройстве, поэтому новая установка на втором компьютере считала
      // «миграция не делалась» и возвращала панель тому, кто её осознанно
      // выключил на первом (аудит lifecycle 01.08.2026, находка 15).
      const existing = (await browser.storage.sync.get("twitch_floating_panel_enabled")) as {
        twitch_floating_panel_enabled?: boolean;
      };
      if (existing.twitch_floating_panel_enabled === undefined) {
        await browser.storage.sync.set({ twitch_floating_panel_enabled: true });
      }
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
  if (alarm.name === OBS_WATCHDOG_ALARM) {
    restoreObsConnection(true);
    // Осиротевшая автозапись (вкладку закрыли без record_stop, краш) —
    // доостанавливается здесь, в пределах минуты.
    void reconcileAutoRecord();
  }
  if (tabIdFromAlarmName(alarm.name) !== null) {
    // Просроченный будильник (крышку ноутбука закрыли на два часа) стреляет
    // сразу на пробуждении, когда WS-close ещё не долетел и на странице пока
    // виден секундомер — вкладка честно ответит «ищу», и мы соврали бы про
    // очередь, которой давно нет.
    //
    // Порог поднят с 15с (см. STALE_ALARM_CUTOFF_MS): загруженная машина
    // задерживает минутный будильник на десятки секунд, очередь при этом жива
    // и предупреждение ещё полезно, а content уже держит armed=true и нового
    // будильника не закажет (аудит lifecycle 01.08.2026, находка 12).
    if (Date.now() - alarm.scheduledTime > STALE_ALARM_CUTOFF_MS) {
      log.info(
        "background",
        "просроченный будильник очереди пропущен, опоздание",
        `${Math.round((Date.now() - alarm.scheduledTime) / 1000)} с`,
      );
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
  // Автозапись со вчера (браузер закрыли посреди игры): reconcile снимет
  // протухший флаг или доостановит запись, когда OBS подключится, — не
  // раньше сверки соединения выше, обе идут своими очередями.
  void reconcileAutoRecord();
  void clearStaleQueueGuards();
});
browser.runtime.onInstalled.addListener((details) => {
  void handleInstalled(details);
  void runUpgradeMigrations();
  // Обновление могло привезти исправление ПРОТОКОЛА OBS: держать блокировку
  // 4010/4011 после апдейта бессмысленно — она снималась только перезапуском
  // браузера (аудит lifecycle 01.08.2026, находка 13). Блокировку по паролю
  // (4008/4009) не трогаем: креды апдейт не чинит.
  void (async () => {
    try {
      const st = (await browser.storage.local.get({
        [OBS_RETRY_BLOCKED_KEY]: false,
        [OBS_RETRY_BLOCK_REASON_KEY]: null,
      })) as Record<string, unknown>;
      if (st[OBS_RETRY_BLOCKED_KEY] === true && st[OBS_RETRY_BLOCK_REASON_KEY] === "protocol") {
        await browser.storage.local.set({
          [OBS_RETRY_BLOCKED_KEY]: false,
          [OBS_RETRY_BLOCK_REASON_KEY]: null,
          [OBS_RECONNECT_ATTEMPTS_KEY]: 0,
        });
        log.info("background", "protocol retry block cleared by update");
      }
    } catch (e) {
      log.debug("background", "retry block reset failed", e);
    }
    // Установка/обновление — легитимная точка сброса ОБЩЕГО бюджета попыток:
    // раньше reconcile не смотрел на счётчик и restore после апдейта пробовал
    // подключиться всегда — сохраняем этот контракт (PERF-8). Блокировку по
    // паролю (4008/4009) сброс счётчика не снимает — она проверяется раньше.
    obs.resetReconnectAttempts();
    restoreObsConnection();
  })();
  void clearStaleQueueGuards();
});

// Диагностика: перехват ошибок + гейт персиста логов по настройке.
installErrorCapture("bg");
void getSetting("debug_logging_enabled").then((on) => log.setPersist(on));
/**
 * Последние известные background'у значения настроек OBS.
 *
 * Страховка к фиксу находки 5: фильтр old/new в onSettingsChanged помогает
 * только если Firefox присылает oldValue. Если он пришлёт «прицепом»
 * неизменившийся `obs_enabled: true` без oldValue, фильтр его пропустит — и
 * без этой сверки background снова принял бы его за намеренное включение и
 * отменил ручное отключение. Здесь переход считается только при РЕАЛЬНОЙ
 * смене значения относительно того, что background уже видел.
 */
const lastObsIntent: { enabled?: boolean; host?: string; password?: string; master?: boolean } = {};
/**
 * Готовность снимка. storage.onChanged — одно из событий, которыми браузер
 * БУДИТ уснувший фоновый скрипт: слушатель отработает синхронно, когда
 * getSettings() ещё в полёте, и пустой снимок (`undefined`) выглядел бы как
 * «значение изменилось» — ровно в том сценарии, ради которого страховка и
 * вводилась (ревью аудита lifecycle). Поэтому переходы считаются ТОЛЬКО
 * после await этого промиса, внутри очереди OBS.
 */
const obsIntentReady = getSettings()
  .then((s) => {
    lastObsIntent.enabled = s.obs_enabled;
    lastObsIntent.host = s.obs_host;
    lastObsIntent.password = s.obs_password;
    lastObsIntent.master = s.extension_enabled;
  })
  .catch((e) => log.error("background", "OBS intent snapshot failed", e));

onSettingsChanged((patch) => {
  if ("debug_logging_enabled" in patch) log.setPersist(patch.debug_logging_enabled === true);
  // Живая реакция на тумблер OBS: раньше выключение obs_enabled (в т.ч. с
  // другого устройства через sync) не рвало соединение — background смотрел
  // на настройку только при onStartup/onInstalled.
  const touchesObs =
    "obs_enabled" in patch ||
    "obs_host" in patch ||
    "obs_password" in patch ||
    "extension_enabled" in patch;

  if (touchesObs) {
    void enqueueObs(async () => {
      // Снимок гарантированно заполнен: см. obsIntentReady.
      await obsIntentReady;
      const enabledChanged =
        "obs_enabled" in patch && patch.obs_enabled !== lastObsIntent.enabled;
      const masterChanged =
        "extension_enabled" in patch && patch.extension_enabled !== lastObsIntent.master;
      const hostChanged = "obs_host" in patch && patch.obs_host !== lastObsIntent.host;
      const passwordChanged =
        "obs_password" in patch && patch.obs_password !== lastObsIntent.password;
      if ("obs_enabled" in patch) lastObsIntent.enabled = patch.obs_enabled;
      if ("extension_enabled" in patch) lastObsIntent.master = patch.extension_enabled;
      if ("obs_host" in patch) lastObsIntent.host = patch.obs_host;
      if ("obs_password" in patch) lastObsIntent.password = patch.obs_password;
      // Ни одного РЕАЛЬНОГО перехода — событие «прицепное» (Firefox шлёт все
      // ключи области), делать нечего.
      if (!enabledChanged && !masterChanged && !hostChanged && !passwordChanged) return;
      // Мастер-выключатель рвёт OBS так же, как выключение obs_enabled.
      if (
        (enabledChanged && patch.obs_enabled === false) ||
        (masterChanged && patch.extension_enabled === false)
      ) {
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
      if (
        (enabledChanged && patch.obs_enabled === true) ||
        (masterChanged && patch.extension_enabled === true)
      ) {
        await setManualDisconnect(false);
        await obs.allowAutoReconnect();
      }
      if (hostChanged || passwordChanged) {
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
