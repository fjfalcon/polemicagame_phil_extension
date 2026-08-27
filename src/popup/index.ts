/**
 * Popup entry. Порт прежнего popup.js в TS-архитектуру.
 *
 * Ключевые отличия от оригинала:
 *  • Нет chrome.scripting.executeScript — длина ников запрашивается у content
 *    через sendToActiveTab({type:"getNicknameLengths"}); кнопка активации делает
 *    reload вкладки (единый content.js грузится сам, FeatureManager реагирует на storage).
 *  • Чтение/запись настроек идёт через core/settings (getSettings/setSettings).
 *  • OBS-команды — sendRuntime({type:"obs_command", ...}); события — onMessage.
 *  • chrome.* → browser.*, console.* → log.*.
 */
import { browser, isStoreInstall } from "@core/env";
import { log } from "@core/log";
import * as wsLog from "@core/ws-log";
import { installErrorCapture } from "@core/errors";
import {
  getSetting,
  getSettings,
  setSettings,
  onSettingsChanged,
  DEFAULT_SETTINGS,
} from "@core/settings";
import {
  formatMetrics as formatDiagMetrics,
  formatSettings as formatDiagSettings,
  section as diagSection,
  storageMetrics as diagStorageMetrics,
} from "@core/diag-snapshot";
import { formatKeyCode, isModifierCode } from "@core/keyboard";
// Список углов — общий с content-скриптом (см. shared/nick-plate).
import { PLATE_POSITIONS } from "@shared/nick-plate";
import { readControlPosition } from "@shared/controls-layout";
import { CUSTOM_THEME, readButtonColor } from "@shared/button-theme";
import { readLastGamesCount } from "@shared/last-games";
import { escapeHtml } from "@core/escape";
import {
  loadNotes,
  saveNotes,
  MAX_OWN_NOTE_TEXT,
  mergeNotes,
  isSafeTag,
  TAGS_KEY,
  MAX_IMPORT_ENTRIES,
} from "@core/notes-store";
import { classifyMergeResponse, runCoordinatorImport, runImportFallback } from "./import-fallback";
import { sanitizeObsHost } from "@shared/safe-endpoint";

/** Сколько игр с метками ролей принимаем из чужого файла (у фичи лимит 50). */
/**
 * Потолок игр в метках ролей ПОСЛЕ слияния (ревью 27.08.2026): раньше
 * лимит считал только НОВЫЕ игры, и 50 существующих + 50 из файла давали
 * 100 до следующей штатной подрезки. Значение совпадает с MAX_GAMES
 * роль-маркера (src/content/features/role-marker.ts).
 */
const MAX_IMPORT_ROLE_GAMES = 50;
/** Потолок меток в одной игре: за столом 10–12 человек, не десятки тысяч. */
const MAX_IMPORT_MARKS_PER_GAME = 40;
/** Совокупный потолок байт импорта меток — квота общая с заметками (SEC26-6). */
const MAX_IMPORT_ROLE_BYTES = 100_000;

/** Потолок размера файла бэкапа (наши 200 заметок ≈ 40 КБ). */
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** Настройки, включающие действия за игрока и сетевые подключения. */
const OPERATIONAL_KEYS = [
  "auto_accept_enabled",
  "requeue_after_lobby_fail_enabled",
  "postgame_requeue_enabled",
  "queue_peek_enabled",
  "queue_peek_auto",
  "obs_enabled",
  "obs_auto_mode_enabled",
  "twitch_chat_enabled",
  "enable_role_faker",
  "disable_webcam_clicks",
  // SEC26-8/2 (26.08.2026): авто-действия и сетевые/OBS-операции, которые
  // чужой бэкап не должен включать без явного согласия.
  "skip_start_screen_enabled",
  "obs_auto_record_enabled",
  "obs_clip_enabled",
  "ws_full_log_enabled",
] as const;

const OPERATIONAL_LABELS: Record<string, string> = {
  auto_accept_enabled: "автопринятие игры",
  requeue_after_lobby_fail_enabled: "автовозврат в поиск после развала лобби",
  postgame_requeue_enabled: "кнопка «В поиск» после игры (выход из игры и клик «Играть»)",
  queue_peek_enabled: "заход в очередь для просмотра, кто в поиске",
  queue_peek_auto: "автоматический заход в очередь",
  obs_enabled: "подключение к OBS",
  obs_auto_mode_enabled: "автопереключение сцен OBS",
  twitch_chat_enabled: "подключение к чату Twitch",
  enable_role_faker: "подмена роли",
  disable_webcam_clicks: "блокировка кликов по камерам",
  skip_start_screen_enabled: "автоклик стартового экрана игры",
  obs_auto_record_enabled: "автозапись игр в OBS",
  obs_clip_enabled: "клипы OBS (настройка и запуск Replay Buffer)",
  ws_full_log_enabled: "полный лог общения с сервером (пишет чат и роли на диск)",
};
import type { NotesMap } from "@core/notes-store";
import {
  sendRuntime,
  sendToActiveTab,
  sendToActiveTabStrict,
  broadcastToGameTabs,
  onMessage,
} from "@core/messaging";
import type {
  Settings,
  NotesResultMsg,
  NoteFrameWidth,
  ObsScene,
  ObsEventMsg,
  TwitchStatusMsg,
  ExtMessage,
} from "@shared/types";
import type { NickLengths } from "../content/nickname-lengths";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const SCOPE = "popup";

document.addEventListener("DOMContentLoaded", () => {
  installErrorCapture("popup");

  // Онбординг: попап открыт — настройки найдены. Снимаем точку с иконки и
  // больше никогда не навязываем страницу-приветствие (см. background,
  // ONBOARDING_SHOWN_KEY; жалоба 06.08.2026 «стримеры не находят настройки»).
  try {
    void browser.action?.setBadgeText?.({ text: "" });
  } catch {
    /* старые браузеры без action в попапе */
  }
  void browser.storage.local.set({ onboarding_shown: true }).catch(() => undefined);

  // Настройка «вести логи» управляет и попапом тоже. Раньше он её не читал, и
  // у выключившего логирование ошибки попапа всё равно оседали в хранилище —
  // тумблер врал (аудит наблюдаемости 02.08.2026, LOG-4).
  void getSetting("debug_logging_enabled").then((on) => log.setPersist(on));

  // ───────────────────────── Версия в шапке ─────────────────────────
  const verEl = $("popup_version");
  if (verEl) verEl.textContent = `v${browser.runtime.getManifest().version}`;

  // ───────────────────────── Логи: скачать / очистить ─────────────────────────
  /**
   * Диагностический снимок состояния для шапки экспорта (26.08.2026):
   * настройки (без секретов), метрики хранилища (без содержимого), статус
   * OBS, состояние вкладок сайта. Каждая секция падает поодиночке — снимок
   * не имеет права сломать экспорт лога.
   */
  const collectDiagSnapshot = async (): Promise<string> => {
    const parts: string[] = [];
    try {
      parts.push(diagSection("Настройки", formatDiagSettings(await getSettings())));
    } catch (e) {
      parts.push(diagSection("Настройки", [`<не собрались: ${(e as Error).message}>`]));
    }
    try {
      const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
      parts.push(diagSection("Хранилище (local)", formatDiagMetrics(diagStorageMetrics(all))));
    } catch (e) {
      parts.push(diagSection("Хранилище (local)", [`<не собралось: ${(e as Error).message}>`]));
    }
    try {
      const st = (await sendOBSCommand("get_status")) as {
        connected?: boolean;
        scenes?: unknown[];
        currentScene?: string | null;
      };
      parts.push(
        diagSection("OBS", [
          `подключён: ${st?.connected ? "да" : "нет"}`,
          `сцен: ${st?.scenes?.length ?? 0}, текущая: ${st?.currentScene ?? "—"}`,
        ]),
      );
    } catch (e) {
      parts.push(diagSection("OBS", [`статус недоступен: ${(e as Error).message}`]));
    }
    try {
      const tabs = await browser.tabs.query({ url: "*://*.polemicagame.com/*" });
      const answers = await Promise.all(
        tabs.map(async (t) => {
          if (t.id == null) return null;
          try {
            const r = (await browser.tabs.sendMessage(t.id, { type: "diag_state" })) as {
              path?: string;
              active?: string[];
            } | null;
            return r ? `${r.path}: ${r.active?.join(", ") || "<ничего>"}` : `вкладка ${t.id}: не ответила`;
          } catch {
            return `вкладка ${t.id}: не ответила (осиротела?)`;
          }
        }),
      );
      parts.push(diagSection("Вкладки сайта (активные фичи)", answers.filter(Boolean) as string[]));
    } catch (e) {
      parts.push(diagSection("Вкладки сайта (активные фичи)", [`<не собрались: ${(e as Error).message}>`]));
    }
    return parts.join("\n") + "\n";
  };

  $("download_logs")?.addEventListener("click", async () => {
    const entries = await log.collectAll();
    const complete = log.isComplete();
    const snapshot = await collectDiagSnapshot();
    const head = [
      `Polemica Notes ${browser.runtime.getManifest().version}`,
      `UA: ${navigator.userAgent}`,
      `exported: ${new Date().toISOString()}`,
      `entries: ${entries.length}`,
      // Шапка должна отвечать на вопрос «можно ли верить этому файлу» до того,
      // как по нему начнут делать выводы (аудит наблюдаемости, LOG-1).
      `complete: ${complete ? "yes" : "NO — часть записей потеряна, storage.local отказал"}`,
      "",
      snapshot,
    ].join("\n");
    const body = entries
      .map((e) => `${new Date(e.t).toISOString()} [${e.c}/${e.l}] ${e.s}: ${e.m}`)
      .join("\n");
    const blob = new Blob([head + body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polemica-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    if (complete) {
      showPopupToast(`Логов: ${entries.length}`);
    } else {
      showPopupToast(
        `Логов: ${entries.length}. Журнал НЕПОЛНЫЙ — хранилище браузера отказало, ` +
          "часть записей потеряна",
        "error",
        8000,
      );
    }
  });
  $("clear_logs")?.addEventListener("click", async () => {
    await log.clearAll();
    showPopupToast("Логи очищены");
  });

  // ─────────────── Полный лог общения с сервером: скачать / очистить ───────────────
  // Отдельный файл, а не раздел обычного журнала: кадров за игру тысячи, и в
  // общем логе они утопили бы записи о наших собственных решениях.
  $("download_ws_log")?.addEventListener("click", async () => {
    // Сначала просим живые вкладки дописать хвост (ревью 27.08.2026): до
    // пяти секунд кадров лежали только в их памяти и в файл не попадали.
    let silentTabs = 0;
    try {
      const tabs = await browser.tabs.query({ url: "*://*.polemicagame.com/*" });
      // Таймаут на вкладку (ревью 27.08.2026): одна зависшая вкладка не
      // должна блокировать скачивание навсегда.
      const withTimeout = <T>(p: Promise<T>): Promise<T | undefined> =>
        Promise.race([
          p.catch(() => undefined),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
        ]);
      const answers = await Promise.all(
        tabs
          .filter((t) => t.id != null)
          .map((t) =>
            withTimeout(
              browser.tabs.sendMessage(t.id as number, { type: "ws_log_flush" }) as Promise<unknown>,
            ),
          ),
      );
      // Молчание вкладки — не «ок»: её хвост в файл не попадёт, и об этом
      // честнее сказать, чем выдать неполный лог за полный (ревью 27.08).
      silentTabs = answers.filter((a) => (a as { ok?: boolean } | undefined)?.ok !== true).length;
    } catch {
      /* вкладок нет — собираем что есть на диске */
    }
    // Заодно уборка: попап — единственное место, куда человек приходит сам,
    // и удобный момент вернуть браузеру место.
    await wsLog.sweepStorage();
    // Уборка могла отметить потери — ждём их записи, иначе файл соберётся
    // раньше собственного признака неполноты (ревью 27.08.2026).
    await wsLog.lossSettled();
    const { frames, dropped, readFailed } = await wsLog.collectAll();
    if (readFailed) {
      // Пустота из-за отказа ЧТЕНИЯ — не «лог не включали» (ревью 27.08, п.3).
      showPopupToast(
        "Не удалось прочитать сохранённый лог — хранилище браузера отказало",
        "error",
        8000,
      );
      return;
    }
    if (frames.length === 0 && dropped > 0) {
      // Кадры не записались, но потеря зафиксирована — обвинять пользователя
      // «лог пуст, включи настройку» здесь нельзя (adversarial 27.08, №2).
      showPopupToast(
        `Кадры не сохранились: ${dropped} отброшено при перегрузке хранилища. Освободите место и повторите`,
        "error",
        8000,
      );
      return;
    }
    if (frames.length === 0) {
      // Пустой файл только собьёт с толку: причина почти всегда одна —
      // настройку не включили либо включили уже после игры.
      showPopupToast(
        "Полный лог пуст. Включи «Полный лог общения с сервером», обнови страницу игры и сыграй — записывается только после этого",
        "error",
        8000,
      );
      return;
    }
    const blob = new Blob([wsLog.formatFrames(frames, dropped)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polemica-ws-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    const tail = [
      dropped > 0 ? `отброшено при перегрузке: ${dropped}` : "",
      silentTabs > 0 ? `вкладок не ответило: ${silentTabs} (их хвост мог не попасть)` : "",
    ].filter(Boolean);
    showPopupToast(
      tail.length ? `Кадров: ${frames.length} (${tail.join("; ")})` : `Кадров: ${frames.length}`,
      tail.length ? "error" : undefined,
      tail.length ? 8000 : undefined,
    );
  });
  $("clear_ws_log")?.addEventListener("click", async () => {
    // ПОРЯДОК: сначала reset контентов — их resetBuffer поднимает поколение
    // и убивает висящие в очереди записи; потом чистим диск. Обратный
    // порядок оставлял окно воскрешения куском, долетевшим после remove
    // (adversarial 27.08, №8).
    try {
      const tabs = await browser.tabs.query({ url: "*://*.polemicagame.com/*" });
      await Promise.all(
        tabs
          .filter((t) => t.id != null)
          .map((t) =>
            browser.tabs.sendMessage(t.id as number, { type: "ws_log_reset" }).catch(() => undefined),
          ),
      );
    } catch {
      /* вкладок нет — чистить больше нечего */
    }
    const cleared = await wsLog.clearAll();
    showPopupToast(
      cleared
        ? "Полный лог очищен"
        : "Хранилище отказало: на диске лог остался, буферы вкладок сброшены",
      cleared ? undefined : "error",
    );
  });

  // ───────────────────────── Проверка обновления вручную ─────────────────────────
  // Плановая проверка ходит на GitHub раз в час и между запросами отвечает из
  // кэша — сразу после выхода релиза баннера на странице ещё нет. Кнопка
  // спрашивает GitHub немедленно и заодно сбрасывает кэш, чтобы контент-скрипт
  // показал баннер на следующей же странице.
  //
  // Для установки из стора (isStoreInstall) GitHub — только «что вообще вышло»:
  // релиз появляется там раньше, чем стор его одобрит, и ставить zip поверх
  // сторовой версии нельзя. Поэтому дополнительно спрашиваем сам браузер
  // (runtime.requestUpdateCheck) — он знает, раздаёт ли стор новую версию,
  // и при положительном ответе сам её скачивает.
  const requestStoreUpdate = async (): Promise<{ status: string; version?: string }> => {
    try {
      const rt = browser.runtime as unknown as {
        requestUpdateCheck?: () => Promise<unknown>;
      };
      if (typeof rt.requestUpdateCheck !== "function") return { status: "unavailable" };
      const raw = await rt.requestUpdateCheck();
      // Chrome ≥110 отдаёт {status, version}; полифилл поверх старого
      // callback-API мог отдать пару [status, {version}].
      if (Array.isArray(raw)) {
        const [status, details] = raw as [unknown, { version?: string } | undefined];
        return { status: String(status || ""), version: details?.version };
      }
      const obj = (raw || {}) as { status?: string; version?: string };
      return { status: String(obj.status || ""), version: obj.version };
    } catch (e) {
      log.debug(SCOPE, "requestUpdateCheck failed", e);
      return { status: "error" };
    }
  };
  // Сторовую установку обновляет браузер, и баннера о версиях у неё больше
  // нет (решение владельца 09.08.2026). Тумблер, который ничего не включает,
  // — обещание впустую: убираем его и объясняем, почему.
  if (isStoreInstall()) {
    const row = $("update_notify_row");
    if (row) row.style.display = "none";
    const note = $("store_update_note");
    if (note) note.style.display = "";
  }

  const checkUpdateBtn = $<HTMLButtonElement>("check_update_now");
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener("click", async () => {
      const current = browser.runtime.getManifest().version;
      checkUpdateBtn.disabled = true;
      checkUpdateBtn.textContent = "Проверяю…";
      try {
        // Сторовый опрос НЕ зависит от GitHub и идёт первым: при упавшем
        // GitHub (сеть, анонимный лимит API) стор всё равно может уже
        // раздавать обновление — молчать об этом нельзя.
        const store = isStoreInstall() ? await requestStoreUpdate() : null;

        let latest = "";
        let releaseUrl = "";
        try {
          const res = await fetch(
            "https://api.github.com/repos/fjfalcon/polemicagame_phil_extension/releases/latest",
            { headers: { Accept: "application/vnd.github+json" } },
          );
          if (!res.ok) throw new Error(`GitHub ${res.status}`);
          const data = (await res.json()) as { tag_name?: string; html_url?: string };
          latest = String(data.tag_name || "").replace(/^v/, "");
          if (!latest) throw new Error("пустой тег");
          releaseUrl = String(data.html_url || "");

          // Свежий ответ кладём в общий кэш: баннер на странице появится
          // сразу, а «не напоминать» для новой версии сбрасываем — она ещё
          // не показана.
          await browser.storage.local.set({
            pn_update_last_check: Date.now(),
            pn_update_latest: latest,
          });
        } catch (e) {
          // Для self-канала без GitHub проверить нечем — это фатально.
          if (!store) throw e;
          log.debug(SCOPE, "GitHub недоступен при сторовой проверке", e);
        }

        const cmp = (a: string, b: string): number => {
          const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
          const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
          }
          return 0;
        };
        const newer = latest !== "" && cmp(latest, current) > 0;

        if (store) {
          if (store.status === "update_available") {
            showPopupToast(
              `Стор уже раздаёт версию ${store.version || latest || "новее вашей"} — браузер скачает и применит её сам (быстрее всего — перезапустить браузер)`,
            );
          } else if (newer) {
            // Без утверждения «стор ещё не одобрил»: при статусе throttled
            // (кнопку понажимали несколько раз) версия может быть уже одобрена.
            showPopupToast(
              `Версия ${latest} вышла (у вас ${current}) — стор доставит её автоматически`,
            );
          } else if (latest) {
            showPopupToast(`У вас последняя версия (${current})`);
          } else {
            showPopupToast("Не удалось проверить обновление", "error");
          }
        } else if (newer) {
          showPopupToast(`Доступна версия ${latest} (у вас ${current}) — открываю страницу релиза`);
          void browser.tabs.create({ url: releaseUrl || `https://github.com/fjfalcon/polemicagame_phil_extension/releases/latest` });
        } else {
          showPopupToast(`У вас последняя версия (${current})`);
        }
      } catch (e) {
        log.error(SCOPE, "manual update check failed", e);
        showPopupToast("Не удалось проверить обновление", "error");
      } finally {
        checkUpdateBtn.disabled = false;
        checkUpdateBtn.textContent = "Проверить";
      }
    });
  }

  /**
   * Проверка «вкладка игры работает на актуальной версии».
   *
   * После обновления расширения открытая игра продолжает исполнять СТАРЫЙ
   * content-скрипт (браузер не переинжектит его в загруженный документ) —
   * новые фиксы там не работают, а понять это было нельзя (аудит lifecycle
   * 01.08.2026, находка 3). Проверяем тихо, при открытии попапа, и
   * сообщаем только если версии реально разошлись. Баннер поверх игры не
   * показываем — это мешало бы прямо во время матча.
   */
  void (async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.includes("polemicagame.com")) return;
      const res = (await browser.tabs.sendMessage(tab.id, { type: "getContentVersion" })) as
        | { version?: string }
        | undefined;
      const mine = browser.runtime.getManifest().version;
      if (res?.version && res.version !== mine) {
        // Обычный тост, не ошибка: всё работает, просто на старом коде.
        showPopupToast(
          `Вкладка игры работает на версии ${res.version}, а расширение уже ${mine} — обнови вкладку (F5), чтобы заработали новые исправления`,
          "success",
          12000,
        );
      }
    } catch {
      // Нет получателя — это тоже «старая вкладка», но там уже сработает
      // честная ошибка при первой же команде (см. sendToActiveTabStrict).
    }
  })();

  // ───────────────────────── Вкладки ─────────────────────────
  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".panel"));
  const TAB_LS = "polemica:popupTab";
  const activateTab = (name: string) => {
    const exists = tabs.some((t) => t.dataset.tab === name);
    const target = exists ? name : "game";
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === target));
    panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === target));
    try {
      localStorage.setItem(TAB_LS, target);
    } catch {
      /* ignore */
    }
  };
  tabs.forEach((t) =>
    t.addEventListener("click", () => activateTab(t.dataset.tab || "game")),
  );
  try {
    const saved = localStorage.getItem(TAB_LS);
    if (saved) activateTab(saved);
  } catch {
    /* ignore */
  }

  // ───────────────────────── Тосты ─────────────────────────
  let popupToastTimer: ReturnType<typeof setTimeout> | null = null;
  function showPopupToast(message: string, type: "success" | "error" = "success", timeoutMs = 8000) {
    const notification = $("notification");
    if (!notification) {
      alert(message);
      return;
    }
    notification.textContent = message;
    notification.style.background =
      type === "success" ? "rgba(73, 191, 165, 0.12)" : "rgba(239, 68, 68, 0.12)";
    notification.style.color = type === "success" ? "#49BFA5" : "#ef4444";
    notification.classList.add("show");
    if (popupToastTimer) clearTimeout(popupToastTimer);
    popupToastTimer = setTimeout(() => notification.classList.remove("show"), timeoutMs);
  }

  /**
   * Подтверждение ВНУТРИ попапа.
   *
   * Нативный confirm() здесь использовать нельзя: он забирает фокус, а попап
   * расширения при потере фокуса закрывается (Firefox) — обработчик импорта
   * умирал молча посреди работы, без записи и без сообщения (ревью аудита
   * безопасности 01.08.2026). Оверлей живёт в самом попапе и фокус не отдаёт.
   */
  function popupConfirm(text: string, okLabel = "Продолжить"): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;" +
        "align-items:center;justify-content:center;padding:12px;";
      const box = document.createElement("div");
      box.style.cssText =
        "background:#1e1f26;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;" +
        "padding:14px;max-width:320px;font:12px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);";
      const msg = document.createElement("div");
      msg.textContent = text;
      msg.style.cssText = "white-space:pre-line;margin-bottom:12px;";
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
      const mk = (label: string, primary: boolean) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
          `padding:5px 12px;border-radius:8px;cursor:pointer;font:600 12px system-ui,sans-serif;` +
          (primary
            ? "background:#3b82f6;color:#fff;border:none;"
            : "background:transparent;color:#fff;border:1px solid rgba(255,255,255,.25);");
        return b;
      };
      const okBtn = mk(okLabel, true);
      const cancelBtn = mk("Отмена", false);
      const done = (v: boolean) => {
        overlay.remove();
        resolve(v);
      };
      okBtn.addEventListener("click", () => done(true));
      cancelBtn.addEventListener("click", () => done(false));
      row.append(cancelBtn, okBtn);
      box.append(msg, row);
      overlay.append(box);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  // ───────────────────────── Модалка длины ников ─────────────────────────
  const nicklenOverlay = $("nicklen_overlay");
  const nicklenBody = $("nicklen_modal_body");
  const nicklenClose = $("nicklen_close");
  function openNicklenModal(message: string) {
    if (!nicklenOverlay || !nicklenBody) {
      showPopupToast(message, "success", 12000);
      return;
    }
    nicklenBody.textContent = message;
    nicklenOverlay.style.display = "flex";
    requestAnimationFrame(() => nicklenOverlay.classList.add("show"));
  }
  function closeNicklenModal() {
    if (!nicklenOverlay) return;
    nicklenOverlay.classList.remove("show");
    setTimeout(() => {
      nicklenOverlay.style.display = "none";
    }, 170);
  }
  if (nicklenClose) nicklenClose.addEventListener("click", closeNicklenModal);
  if (nicklenOverlay)
    nicklenOverlay.addEventListener("click", (e) => {
      if (e.target === nicklenOverlay) closeNicklenModal();
    });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNicklenModal();
  });

  // (Блок «Кнопка активации» удалён: элемента activate_script в popup.html
  // не существовало — обработчик был мёртвым кодом.)

  // ───────────────────────── Кнопка «Символы в никах» ─────────────────────────
  // Раньше: executeScript(func) собирал ники прямо со страницы.
  // Теперь: запрашиваем у content через sendToActiveTab({type:"getNicknameLengths"}).
  const nicknameLengthsBtn = $<HTMLButtonElement>("show_nickname_lengths");
  if (nicknameLengthsBtn)
    nicknameLengthsBtn.addEventListener("click", async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url || !tab.url.includes("polemicagame.com")) {
          showPopupToast("Открой polemicagame.com и страницу игры", "error");
          return;
        }

        const data = await sendToActiveTab<NickLengths>({ type: "getNicknameLengths" });
        if (!data?.players || data.players.length === 0) {
          showPopupToast("Не нашёл игроков на странице", "error");
          return;
        }

        const lines: string[] = [];
        lines.push("Кол-во символов в никнеймах:");
        lines.push(`Всего: ${data.total}`);
        for (const p of data.players) {
          lines.push(`${p.number}) ${p.name} — ${p.length}`);
        }
        openNicklenModal(lines.join("\n"));
      } catch {
        showPopupToast("Не удалось получить ники со страницы", "error");
      }
    });

  // ───────────────────────── Кнопка «Цвета ников» ─────────────────────────
  // Менеджер живёт на странице игры (просьба владельца: настройки цветов —
  // в игре); попап только просит активную вкладку открыть диалог.
  const nickColorsBtn = $<HTMLButtonElement>("open_nick_colors");
  if (nickColorsBtn)
    nickColorsBtn.addEventListener("click", async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url || !tab.url.includes("polemicagame.com")) {
          showPopupToast("Открой вкладку polemicagame.com", "error");
          return;
        }
        // СТРОГАЯ отправка: обычная гасит «нет получателя», и попап
        // закрывался, ничего не открыв (после обновления расширения в старой
        // вкладке контент-скрипта уже нет) — аудит lifecycle 01.08.2026, №10.
        await sendToActiveTabStrict({ type: "openNickColors" });
        window.close(); // попап закрываем — диалог уже на странице
      } catch {
        showPopupToast(
          "Страница не отвечает — обнови вкладку игры (F5) и попробуй снова",
          "error",
        );
      }
    });

  // ───────────────────────── Бэкап заметок (экспорт/импорт) ─────────────────────────
  const exportBtn = $<HTMLButtonElement>("export_notes");
  const importBtn = $<HTMLButtonElement>("import_notes");
  const importFile = $<HTMLInputElement>("import_notes_file");

  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      try {
        const { notes, loadFailed } = await loadNotes();
        if (loadFailed) {
          showPopupToast("Не удалось прочитать заметки — попробуйте позже", "error");
          return;
        }
        const count = Object.keys(notes).length;
        // Настройки выгружаем ВСЕГДА, даже без заметок: у пользователей
        // storage обнуляется при каждом переезде расширения (см. AGENTS.md
        // §2б — ID распакованного Chrome-расширения зависит от пути папки, а
        // временное дополнение Firefox стирается при закрытии браузера), и
        // бэкап «только заметок» их от перенастройки не спасал.
        const settings = await getSettings();
        // Пароль OBS в файл НЕ кладём: бэкап уезжает в облака и мессенджеры.
        const { obs_password: _pw, ...safeSettings } = settings;
        // Палитра своих цветов и локальные мьюты — тоже устойчивые данные
        // пользователя; без них обещание «импорт вернёт всё как было» врало
        // (аудит безопасности 01.08.2026, находка 7).
        const extra = (await browser.storage.local.get({
          [TAGS_KEY]: [],
          pn_muted_players: [],
          // Метки ролей — тоже устойчивый ввод пользователя (история до 50
          // игр); без них обещание «импорт вернёт всё как было» врало
          // (аудит lifecycle 01.08.2026, находка 17).
          roleMarks: {},
        })) as Record<string, unknown>;
        const payload = {
          app: "polemica-notes",
          type: "notes-backup",
          version: browser.runtime.getManifest().version,
          exportedAt: new Date().toISOString(),
          settings: safeSettings,
          notes,
          customTags: Array.isArray(extra[TAGS_KEY]) ? extra[TAGS_KEY] : [],
          mutedPlayers: Array.isArray(extra.pn_muted_players) ? extra.pn_muted_players : [],
          roleMarks:
            extra.roleMarks && typeof extra.roleMarks === "object" ? extra.roleMarks : {},
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `polemica-notes-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showPopupToast(
          count ? `Экспортировано: заметок ${count} + настройки` : "Экспортированы настройки",
        );
      } catch (e) {
        log.error(SCOPE, "export failed", e);
        showPopupToast("Не удалось выгрузить заметки", "error");
      }
    });
  }

  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      try {
        // Размер проверяем ДО чтения: присланный «бэкап» на сотни мегабайт
        // подвешивал попап и мог выесть квоту storage.local, после чего
        // переставали сохраняться и заметки (аудит безопасности, №5).
        if (file.size > MAX_BACKUP_BYTES) {
          showPopupToast(
            `Файл слишком большой (${(file.size / 1048576).toFixed(1)} МБ, максимум ${
              MAX_BACKUP_BYTES / 1048576
            } МБ)`,
            "error",
          );
          return;
        }
        const data = JSON.parse(await file.text());
        const incoming = (data?.notes ?? (data?.app ? {} : data)) as NotesMap;
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
          throw new Error("bad format");
        }
        if (Object.keys(incoming).length > MAX_IMPORT_ENTRIES) {
          showPopupToast(
            `В файле слишком много записей (${Object.keys(incoming).length}, максимум ${MAX_IMPORT_ENTRIES})`,
            "error",
          );
          return;
        }

        // ── настройки из бэкапа (8.1.56) ──
        // Берём ТОЛЬКО известные ключи и только с совпадающим типом: файл
        // мог прийти от другого человека, из будущей версии или быть правлен
        // руками. obs_password не импортируем — его там и нет.
        //
        // ПОРЯДОК: патч настроек ГОТОВИМ здесь, но ПРИМЕНЯЕМ после заметок —
        // раньше настройки успевали включиться (автопринятие, автовозврат в
        // очередь, OBS), а затем импорт заметок падал по квоте, и откатывать
        // было нечего (аудит безопасности 01.08.2026, находка 6).
        const rawSettings = data?.settings;
        const settingsPatch: Record<string, unknown> = {};
        if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
          for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
            if (key === "obs_password" || !(key in rawSettings)) continue;
            const value = (rawSettings as Record<string, unknown>)[key];
            if (typeof value !== typeof def) continue;
            if (typeof value === "string" && value.length > 200) continue;
            settingsPatch[key] = value;
          }
          // Флаги, включающие ДЕЙСТВИЯ за игрока и сетевые подключения, не
          // должны приезжать из чужого файла молча.
          const risky = OPERATIONAL_KEYS.filter((k) => settingsPatch[k] === true);
          if (risky.length) {
            const ok = await popupConfirm(
              `В файле включены действия, которые расширение будет выполнять за вас:\n\n` +
                risky.map((k) => `• ${OPERATIONAL_LABELS[k] ?? k}`).join("\n") +
                `\n\nВключить их?`,
              "Включить",
            );
            if (!ok) for (const k of risky) delete settingsPatch[k];
          }
          // Санитайзер obs_host живёт НА ГРАНИЦЕ settings (setSettings /
          // getSettings, ревью 27.08.2026) — здесь дублировать не нужно.
          // Смена адреса OBS = другой сервер: старый пароль ему не отдаём.
          if (
            typeof settingsPatch.obs_host === "string" &&
            // Сравниваем НОРМАЛИЗОВАННЫЕ адреса: косметическая разница в
            // файле («/» или ?query) стирала пароль как «смену сервера»
            // (adversarial 27.08, №5).
            sanitizeObsHost(settingsPatch.obs_host) !== lastKnown?.obs_host
          ) {
            settingsPatch.obs_password = "";
          }
        }

        const applySettings = async (): Promise<number> => {
          if (!Object.keys(settingsPatch).length) return 0;
          try {
            // Пара «адрес+пароль» НЕ едет общим setSettings (ревью
            // 27.08.2026): частичный отказ local при успешном sync давал
            // «новый адрес + старый пароль» ещё до всякой транзакции.
            const endpointFromFile = {
              host: typeof settingsPatch.obs_host === "string" ? settingsPatch.obs_host : undefined,
              password:
                typeof settingsPatch.obs_password === "string"
                  ? settingsPatch.obs_password
                  : undefined,
            };
            const endpointInFile =
              endpointFromFile.host !== undefined || endpointFromFile.password !== undefined;
            delete (settingsPatch as Record<string, unknown>).obs_host;
            delete (settingsPatch as Record<string, unknown>).obs_password;
            await setSettings(settingsPatch as Partial<Settings>);
            if (endpointInFile) {
              const tx = await sendRuntime<{ ok?: boolean }>({
                type: "obs_endpoint_set",
                host: String(endpointFromFile.host ?? lastKnown?.obs_host ?? ""),
                password: String(endpointFromFile.password ?? ""),
              });
              if (!tx || tx.ok !== true) {
                showPopupToast(
                  "Настройки OBS из файла не применились — проверьте адрес и пароль вручную",
                  "error",
                );
              }
            }
            const applied = await getSettings();
            lastKnown = applied;
            reflectPatch(applied);
            const { obs_password: _pw, ...safe } = applied;
            void broadcastToGameTabs({ type: "updateNotesSettings", settings: safe });
            return Object.keys(settingsPatch).length;
          } catch (e) {
            log.error(SCOPE, "settings import failed", e);
            showPopupToast("Настройки из файла восстановить не удалось", "error");
            return 0;
          }
        };

        // Палитра и мьюты (см. экспорт): восстанавливаем объединением, чтобы
        // импорт не стирал то, что уже есть у пользователя.
        const applyExtras = async (): Promise<{ marksTruncated: boolean; failed: boolean }> => {
          let marksTruncated = false;
          const tags = Array.isArray(data?.customTags)
            ? (data.customTags as unknown[]).filter(isSafeTag)
            : [];
          const muted = Array.isArray(data?.mutedPlayers)
            ? (data.mutedPlayers as unknown[]).filter(
                (m): m is string => typeof m === "string" && m.length > 0 && m.length <= 200,
              )
            : [];
          const hasMarks =
            !!data?.roleMarks && typeof data.roleMarks === "object" && !Array.isArray(data.roleMarks);
          if (!tags.length && !muted.length && !hasMarks) return { marksTruncated, failed: false };
          try {
            const cur = (await browser.storage.local.get({
              [TAGS_KEY]: [],
              pn_muted_players: [],
              roleMarks: {},
            })) as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            if (tags.length) {
              const curTags = Array.isArray(cur[TAGS_KEY]) ? (cur[TAGS_KEY] as string[]) : [];
              patch[TAGS_KEY] = [...new Set([...curTags, ...tags])].slice(0, 100);
            }
            if (muted.length) {
              const curMuted = Array.isArray(cur.pn_muted_players)
                ? (cur.pn_muted_players as string[])
                : [];
              patch.pn_muted_players = [...new Set([...curMuted, ...muted])].slice(0, 1000);
            }
            // Метки ролей: слияние по играм, существующие записи в приоритете
            // (импорт не должен затирать метки текущей сессии).
            const incomingMarks = data?.roleMarks;
            if (incomingMarks && typeof incomingMarks === "object" && !Array.isArray(incomingMarks)) {
              const curMarks =
                cur.roleMarks && typeof cur.roleMarks === "object"
                  ? (cur.roleMarks as Record<string, unknown>)
                  : {};
              const merged: Record<string, unknown> = { ...curMarks };
              // Лимит игр: MAX_GAMES роль-маркера подрезает хранилище только
              // при следующей записи метки, а присланный файл мог влить
              // тысячи ключей в storage.local, квота которого общая с
              // заметками (ревью аудита lifecycle, находка 3).
              let addedGames = 0;
              // Агрегатные потолки (SEC26-6): пер-ключевые лимиты не мешали
              // одной «игре» нести десятки тысяч записей и съесть остаток
              // квоты, общей с заметками.
              let addedBytes = 0;
              for (const [game, marks] of Object.entries(incomingMarks as Record<string, unknown>)) {
                // Потолок ФАЙЛА: сколько игр берём из бэкапа за раз. Общий
                // предел держит подрезка ниже — той же логикой, что runtime
                // (adversarial 27.08: «итог >= 50» вливал НОЛЬ у активного
                // игрока, у которого runtime и так держит ровно 50).
                if (addedGames >= MAX_IMPORT_ROLE_GAMES) {
                  marksTruncated = true;
                  break;
                }
                if (addedBytes >= MAX_IMPORT_ROLE_BYTES) break;
                if (typeof game !== "string" || game.length > 200) continue;
                if (!marks || typeof marks !== "object" || Array.isArray(marks)) continue;
                if (game in merged) continue;
                // Значения — только строки-идентификаторы ролей.
                const clean: Record<string, string> = {};
                let perGame = 0;
                for (const [player, role] of Object.entries(marks as Record<string, unknown>)) {
                  if (perGame >= MAX_IMPORT_MARKS_PER_GAME || addedBytes >= MAX_IMPORT_ROLE_BYTES) {
                    marksTruncated = true;
                    break;
                  }
                  if (typeof player !== "string" || player.length > 200) continue;
                  if (typeof role !== "string" || role.length > 40) continue;
                  clean[player] = role;
                  perGame++;
                  addedBytes += player.length + role.length;
                }
                // Пустая игра слот не занимает (adversarial 27.08, №9).
                if (perGame === 0) continue;
                merged[game] = clean;
                addedGames++;
              }
              // Общая подрезка — как в role-marker.writeNow: самые старые
              // ключи уходят первыми, свежие (в т.ч. импортированные) живут.
              const allKeys = Object.keys(merged);
              if (allKeys.length > MAX_IMPORT_ROLE_GAMES) {
                for (const k of allKeys.slice(0, allKeys.length - MAX_IMPORT_ROLE_GAMES)) {
                  delete merged[k];
                }
              }

              patch.roleMarks = merged;
            }
            await browser.storage.local.set(patch);
          } catch (e) {
            log.error(SCOPE, "extras import failed", e);
            // Тост обязан сказать правду: палитра/мьюты/метки не сохранены
            // (ревью 27.08.2026 — раньше провал был виден только в логе).
            return { marksTruncated, failed: true };
          }
          return { marksTruncated, failed: false };
        };

        if (Object.keys(incoming).length === 0) {
          const restoredSettings = await applySettings();
          const extras = await applyExtras();
          const cut =
            (extras.marksTruncated ? " (часть меток ролей не поместилась в потолок 50 игр)" : "") +
            (extras.failed ? " — палитра/мьюты/метки НЕ сохранены" : "");
          showPopupToast(
            restoredSettings
              ? `Восстановлено настроек: ${restoredSettings}. Заметок в файле нет${cut}`
              : "В файле нет заметок",
            restoredSettings ? "success" : "error",
          );
          return;
        }

        // Предварительный расчёт: сколько записей добавится/обновится —
        // нужен для подтверждения ДО фактической записи. Сама запись идёт
        // через координатор в background (одна очередь на браузер), иначе
        // импорт затирал правку, сделанную в игровой вкладке в те же
        // секунды (аудит lifecycle 01.08.2026, находка 2).
        const { notes, loadFailed } = await loadNotes();
        if (loadFailed) {
          // Мерж в непрочитанную (пустую) карту с последующей записью стёр бы
          // все существующие заметки, заменив их содержимым файла.
          showPopupToast("Не удалось прочитать текущие заметки — импорт отменён", "error");
          return;
        }
        // Потолок СВОЕЙ заметки: round-trip собственного бэкапа не должен
        // резать хвост (ревью 27.08.2026, п.1). Обрезку считаем и скажем.
        const preview = mergeNotes(notes, incoming, { maxText: MAX_OWN_NOTE_TEXT });
        const { added, replaced } = preview;
        if (!added && !replaced) {
          const onlyExtras = await applySettings();
          await applyExtras();
          // Даже когда «всё уже есть», обрезка/пропуск записей обязаны быть
          // видны: молчаливая потеря — тот же класс (adversarial 27.08, №10).
          const quietLoss =
            (preview.truncated > 0 ? ` — обрезано по длине: ${preview.truncated}` : "") +
            (preview.skipped > 0 ? ` — пропущено негодных записей: ${preview.skipped}` : "");
          showPopupToast(
            (onlyExtras
              ? `Все заметки из файла уже есть; настроек: ${onlyExtras}`
              : "Все заметки из файла уже есть") + quietLoss,
            quietLoss ? "error" : undefined,
          );
          return;
        }
        // Замена существующих заметок — необратимая правка чужим файлом:
        // спрашиваем, как только импорт что-то перезаписывает (находка 5).
        if (replaced) {
          const ok = await popupConfirm(
            // «изменит», а не «обновит более свежими»: слияние ещё и дополняет
            // существующие записи полями из файла (цвет, метка, ник), даже
            // когда сама заметка в файле старее.
            `Импорт изменит ${replaced} существующих заметок данными из файла ` +
              `(добавит ${added} новых).\n\nПродолжить?`,
            "Импортировать",
          );
          if (!ok) {
            showPopupToast("Импорт отменён");
            return;
          }
        }
        // Петля согласия координаторного пути — в import-fallback.ts, под
        // тестами и с общим MAX_CONFIRMS (adversarial 26.08.2026, №1).
        const coord = await runCoordinatorImport(replaced, {
          merge: (approvedReplaced) =>
            sendRuntime<NotesResultMsg>({
              type: "notes_merge",
              incoming: incoming as Record<string, unknown>,
              approvedReplaced,
            }),
          confirmMore: (fresh, approved) =>
            popupConfirm(
              `Пока вы подтверждали, заметки менялись: импорт теперь изменит ` +
                `${fresh} существующих (было ${approved}).\n\nПродолжить?`,
              "Импортировать",
            ),
        });
        if (coord.status === "cancelled") {
          showPopupToast("Импорт отменён");
          return;
        }
        if (coord.status === "unstable") {
          showPopupToast(
            "Заметки прямо сейчас активно меняются — импорт отменён, повторите позже",
            "error",
          );
          return;
        }
        let applied = coord.applied;
        // Fail-closed классификация ответа (import-fallback.ts, под тестами):
        // фолбэк — ТОЛЬКО на мёртвый фон; malformed — отказ, не прямая запись.
        const verdict = classifyMergeResponse(applied);
        if (verdict === "read_failed") {
          showPopupToast("Не удалось прочитать текущие заметки — импорт отменён", "error");
          return;
        }
        if (verdict === "refused") {
          showPopupToast("Не удалось сохранить заметки — импорт не применён", "error");
          return;
        }
        let fallbackCounts: { added: number; replaced: number; truncated: number } | null = null;
        if (verdict === "dead") {
          // Фолбэк на прямую запись — фон не ответил (спящий воркер).
          applied = undefined;
          const result = await runImportFallback(incoming as NotesMap, coord.approved, {
            loadNotes,
            saveNotes,
            confirmMore: (fresh, approved) =>
              popupConfirm(
                `Пока вы подтверждали, заметки менялись: импорт теперь изменит ` +
                  `${fresh} существующих (было ${approved}).\n\nПродолжить?`,
                "Импортировать",
              ),
          });
          if (result.status === "read_failed") {
            showPopupToast("Не удалось прочитать текущие заметки — импорт отменён", "error");
            return;
          }
          if (result.status === "cancelled") {
            showPopupToast("Импорт отменён");
            return;
          }
          if (result.status === "unstable") {
            showPopupToast(
              "Заметки прямо сейчас активно меняются — импорт отменён, повторите позже",
              "error",
            );
            return;
          }
          if (result.status === "save_failed") {
            showPopupToast("Не удалось сохранить заметки", "error");
            return;
          }
          fallbackCounts = {
            added: result.added,
            replaced: result.replaced,
            truncated: result.truncated,
          };
        }
        // Настройки применяем ПОСЛЕ успешной записи заметок (находка 6).
        const restoredSettings = await applySettings();
        const extras = await applyExtras();
        // Авторитетные цифры — от координатора: он считал их на свежей карте
        // (в игровой вкладке могли править заметки в эти же секунды).
        const addedFinal = applied?.added ?? fallbackCounts?.added ?? added;
        const replacedFinal = applied?.replaced ?? fallbackCounts?.replaced ?? replaced;
        const notesMsg = replacedFinal
          ? `Добавлено: ${addedFinal}, обновлено: ${replacedFinal}`
          : `Импортировано заметок: ${addedFinal}`;
        // Честность берём с ТОГО пути, который реально писал (фолбэк или
        // координатор), а не с предварительного расчёта (adversarial HIGH-1).
        // Авторитет — тот путь, который РЕАЛЬНО писал: координатор или
        // фолбэк. preview только предсказывал (ревью 27.08.2026).
        const truncatedFinal = applied?.truncated ?? fallbackCounts?.truncated ?? preview.truncated;
        const skippedFinal = applied?.skipped ?? preview.skipped;
        const cutNotes =
          (truncatedFinal > 0 ? ` — ВНИМАНИЕ: ${truncatedFinal} заметок обрезано по длине` : "") +
          // Выброшенная запись хуже обрезанной — о ней тоже говорим (№11).
          (skippedFinal > 0 ? ` — пропущено негодных записей: ${skippedFinal}` : "");
        const cutMain =
          (extras.marksTruncated ? " (часть меток ролей не поместилась в потолок 50 игр)" : "") +
          (extras.failed ? " — палитра/мьюты/метки НЕ сохранены" : "");
        showPopupToast(
          (restoredSettings ? `${notesMsg}; настроек: ${restoredSettings}` : notesMsg) +
            cutNotes +
            cutMain,
          extras.failed || truncatedFinal > 0 || skippedFinal > 0 ? "error" : undefined,
        );
      } catch (e) {
        log.error(SCOPE, "import failed", e);
        showPopupToast("Не удалось импортировать файл", "error");
      } finally {
        importFile.value = "";
      }
    });
  }

  // Последние известные сцены OBS. Списки сцен заполняются только после
  // подключения к OBS; без этого saveSettings читал пустые <select> и стирал
  // выбор пользователя при любом переключении тумблера.
  let knownDayScene = "";
  let knownNightScene = "";

  // ───────────────────────── Захват клавиши паузы ─────────────────────────
  let pauseHotkeyCode = "F8";
  const pauseCaptureBtn = $<HTMLButtonElement>("pause_hotkey_capture");
  const renderPauseKey = () => {
    if (pauseCaptureBtn) pauseCaptureBtn.textContent = formatKeyCode(pauseHotkeyCode);
  };
  if (pauseCaptureBtn) {
    pauseCaptureBtn.addEventListener("click", () => {
      pauseCaptureBtn.textContent = "Нажми клавишу…";
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (isModifierCode(e.code)) return; // ждём не-модификатор
        window.removeEventListener("keydown", onKey, true);
        pauseHotkeyCode = e.code;
        renderPauseKey();
        saveSettings();
      };
      window.addEventListener("keydown", onKey, true);
    });
  }

  // ───────────────────────── Захват клавиш ролей (F/E/D) ─────────────────────────
  let roleFakeCode = "KeyF";
  let roleResetCode = "KeyE";
  let roleHideCode = "KeyD";
  let rolePeekCode = "KeyV";
  let outcryCode = "KeyC";
  let clipCode = "F9";
  // Свой цвет кнопок: живёт в замыкании, как хоткеи — <input type=color>
  // больше нет, а source of truth для сохранения нужен один.
  let currentButtonColor = "#ffd54f";
  let reflectButtonColor: (hex: string) => void = () => {};
  const roleKeyRenders: Array<() => void> = [];
  const setupRoleKey = (id: string, get: () => string, set: (c: string) => void) => {
    const btn = $<HTMLButtonElement>(id);
    if (!btn) return;
    const render = () => (btn.textContent = formatKeyCode(get()));
    render();
    roleKeyRenders.push(render);
    btn.addEventListener("click", () => {
      btn.textContent = "Нажми…";
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (isModifierCode(e.code)) return;
        window.removeEventListener("keydown", onKey, true);
        set(e.code);
        render();
        saveSettings();
      };
      window.addEventListener("keydown", onKey, true);
    });
  };
  setupRoleKey("hotkey_role_fake", () => roleFakeCode, (c) => (roleFakeCode = c));
  setupRoleKey("hotkey_role_reset", () => roleResetCode, (c) => (roleResetCode = c));
  setupRoleKey("hotkey_role_hide", () => roleHideCode, (c) => (roleHideCode = c));
  setupRoleKey("hotkey_role_peek", () => rolePeekCode, (c) => (rolePeekCode = c));
  // Тот же механизм захвата клавиши, что и у ролевых: живёт в замыкании, а не
  // в input.value, иначе чужое изменение откатывалось бы первым же тумблером.
  setupRoleKey("outcry_hotkey_code", () => outcryCode, (c) => (outcryCode = c));
  setupRoleKey("obs_clip_hotkey_code", () => clipCode, (c) => (clipCode = c));

  // ───────────────────────── Загрузка настроек в контролы ─────────────────────────
  /**
   * Последнее известное состояние storage. Раньше popup был «слепым писателем»:
   * не подписывался на изменения и при любом клике писал ВЕСЬ объект из своего
   * (устаревшего) DOM — закрытая крестиком панель воскресала от любого тумблера,
   * а изменения с другого устройства откатывались. Теперь пишем только дифф.
   */
  let lastKnown: Settings | null = null;

  /** Мастер-выключатель: визуально тушим всё, кроме шапки (контролы остаются кликабельны — бэкап заметок должен работать и при выключенном расширении). */
  const applyExtOff = (enabled: boolean) => {
    document.body.classList.toggle("ext-off", !enabled);
  };

  const reflectPatch = (patch: Partial<Settings>) => {
    for (const [key, value] of Object.entries(patch)) {
      const el = $<HTMLInputElement>(key);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = value === true;
      // obs_host из чужого патча (грязный sync второго устройства) не должен
      // даже РИСОВАТЬСЯ с кредами (adversarial 27.08, №6).
      else if (typeof value === "string") {
        el.value = key === "obs_host" ? sanitizeObsHost(value) : value;
      }
    }
    // Зависимые блоки видимости.
    if ("extension_enabled" in patch) applyExtOff(patch.extension_enabled !== false);
    // Тему могли сменить с другого устройства — строка своего цвета обязана
    // появиться/исчезнуть вместе с ней.
    if ("stats_button_theme" in patch) syncCustomColorRow();
    if ("role_marker_enabled" in patch) syncRoleMarkerIconsRow();
    if (typeof patch.stats_button_color === "string") {
      reflectButtonColor(readButtonColor(patch.stats_button_color));
    }
    if ("obs_enabled" in patch) {
      const s = $("obs_settings");
      if (s) s.style.display = patch.obs_enabled ? "block" : "none";
    }
    if ("obs_auto_mode_enabled" in patch) {
      const s = $("obs_auto_settings");
      if (s) s.style.display = patch.obs_auto_mode_enabled ? "block" : "none";
    }
    if ("twitch_chat_enabled" in patch) {
      const s = $("twitch_settings");
      if (s) s.style.display = patch.twitch_chat_enabled ? "block" : "none";
    }
    if ("obs_day_scene" in patch) knownDayScene = patch.obs_day_scene || "";
    if ("obs_night_scene" in patch) knownNightScene = patch.obs_night_scene || "";
    // Хоткеи живут в замыканиях, а не в input.value — без этого чужое
    // изменение хоткея откатывалось следующим же кликом по любому тумблеру.
    if (typeof patch.pause_hotkey_code === "string") {
      pauseHotkeyCode = patch.pause_hotkey_code;
      renderPauseKey();
    }
    if (typeof patch.hotkey_role_fake === "string") roleFakeCode = patch.hotkey_role_fake;
    if (typeof patch.hotkey_role_reset === "string") roleResetCode = patch.hotkey_role_reset;
    if (typeof patch.hotkey_role_hide === "string") roleHideCode = patch.hotkey_role_hide;
    if (typeof patch.hotkey_role_peek === "string") rolePeekCode = patch.hotkey_role_peek;
    if (typeof patch.outcry_hotkey_code === "string") outcryCode = patch.outcry_hotkey_code;
    if (typeof patch.obs_clip_hotkey_code === "string") clipCode = patch.obs_clip_hotkey_code;
    if (
      patch.hotkey_role_fake ||
      patch.hotkey_role_reset ||
      patch.hotkey_role_hide ||
      patch.hotkey_role_peek ||
      patch.outcry_hotkey_code ||
      patch.obs_clip_hotkey_code
    ) {
      roleKeyRenders.forEach((r) => r());
    }
  };

  // Точечные писатели из content (закрытие панели крестиком) и другие
  // устройства теперь видны попапу сразу.
  onSettingsChanged((patch) => {
    // Тумблер логирования применяем сразу, в том числе когда его переключили
    // прямо здесь: иначе попап продолжал бы писать в хранилище (LOG-4).
    if ("debug_logging_enabled" in patch) {
      log.setPersist(patch.debug_logging_enabled === true);
    }
    if (!lastKnown) return;
    lastKnown = { ...lastKnown, ...patch };
    reflectPatch(patch);
  });

  void getSettings().then((items) => {
    lastKnown = items;
    pauseHotkeyCode = items.pause_hotkey_code || "F8";
    renderPauseKey();
    roleFakeCode = items.hotkey_role_fake || "KeyF";
    roleResetCode = items.hotkey_role_reset || "KeyE";
    roleHideCode = items.hotkey_role_hide || "KeyD";
    rolePeekCode = items.hotkey_role_peek || "KeyV";
    outcryCode = items.outcry_hotkey_code || "KeyC";
    clipCode = items.obs_clip_hotkey_code || "F9";
    roleKeyRenders.forEach((r) => r());
    const set = (id: string, val: boolean) => {
      const el = $<HTMLInputElement>(id);
      // Строго === true — тем же правилом фичи включает FeatureManager.
      // Truthy-мусор из хранилища (строка "true" и т.п.) рисовал галочку при
      // выключенной фиче: попап врал «всё включено», а кнопок не было
      // (жалоба 25.08.2026). Со снятой галочкой пользователь щёлкает тумблер
      // и записывает честный boolean — хранилище самолечится.
      if (el) el.checked = val === true;
    };

    set("extension_enabled", items.extension_enabled);
    applyExtOff(items.extension_enabled);
    set("show_mmr", items.show_mmr);
    set("show_games", items.show_games);
    set("show_id", items.show_id);
    set("show_winrate", items.show_winrate);
    set("show_kills", items.show_kills);
    set("show_roles", items.show_roles);
    set("enable_role_faker", items.enable_role_faker);
    set("skip_start_screen_enabled", items.skip_start_screen_enabled);
    set("queue_background_warning_enabled", items.queue_background_warning_enabled);
    set("requeue_after_lobby_fail_enabled", items.requeue_after_lobby_fail_enabled);
    set("postgame_requeue_enabled", items.postgame_requeue_enabled);
    set("postgame_skip_confirm_enabled", items.postgame_skip_confirm_enabled);
    set("queue_peek_enabled", items.queue_peek_enabled);
    set("queue_peek_auto", items.queue_peek_auto);
    set("queue_peek_standard", items.queue_peek_standard);
    set("queue_peek_polite", items.queue_peek_polite);
    set("queue_peek_prime", items.queue_peek_prime);
    set("pause_hotkey_enabled", items.pause_hotkey_enabled);
    set("statistics_enabled", items.statistics_enabled);
    set("session_stats_enabled", items.session_stats_enabled);
    set("match_page_stats_enabled", items.match_page_stats_enabled);

    const sbt = $<HTMLSelectElement>("stats_button_theme");
    if (sbt) sbt.value = items.stats_button_theme || "default";
    reflectButtonColor(readButtonColor(items.stats_button_color));
    syncCustomColorRow();
    const msv = $<HTMLSelectElement>("match_stats_view");
    if (msv) msv.value = items.match_stats_view || "hints";

    set("auto_hide_roles_enabled", items.auto_hide_roles_enabled);
    const rpase = $<HTMLInputElement>("role_phase_auto_switch_enabled");
    if (rpase) {
      rpase.checked = items.auto_hide_roles_enabled ? items.role_phase_auto_switch_enabled : false;
      rpase.disabled = !items.auto_hide_roles_enabled;
    }
    set("disable_webcam_clicks", items.disable_webcam_clicks);
    set("auto_accept_enabled", items.auto_accept_enabled);
    set("camera_rotate_enabled", items.camera_rotate_enabled);
    set("camera_reload_enabled", items.camera_reload_enabled);
    set("stream_lost_icon_enabled", items.stream_lost_icon_enabled);
    set("player_mute_enabled", items.player_mute_enabled);
    set("nick_colors_enabled", items.nick_colors_enabled);
    const nfw = $<HTMLSelectElement>("note_frame_width");
    if (nfw) {
      // Нормализация: импорт бэкапа проверяет только typeof, и мусорная
      // строка в storage оставила бы селект пустым (selectedIndex −1).
      const v = items.note_frame_width;
      nfw.value = v === "thin" || v === "medium" ? v : "thick";
    }
    set("btn_stats_enabled", items.btn_stats_enabled);
    set("btn_note_enabled", items.btn_note_enabled);
    set("btn_last_games_enabled", items.btn_last_games_enabled);
    set("btn_crossover_enabled", items.btn_crossover_enabled);
    set("btn_hide_video_enabled", items.btn_hide_video_enabled);
    const lgc = $<HTMLSelectElement>("last_games_count");
    // Нормализация: мусор в storage иначе оставил бы селект пустым.
    if (lgc) lgc.value = readLastGamesCount(items.last_games_count);
    set("last_games_first_killed", items.last_games_first_killed);
    set("note_indicator_enabled", items.note_indicator_enabled);
    set("role_marker_enabled", items.role_marker_enabled);
    set("role_marker_icons_enabled", items.role_marker_icons_enabled);
    syncRoleMarkerIconsRow();
    set("compact_nicknames_enabled", items.compact_nicknames_enabled);
    const npp = $<HTMLSelectElement>("nick_plate_position");
    // Нормализация: мусор в storage иначе оставил бы селект пустым.
    if (npp) {
      npp.value = (PLATE_POSITIONS as readonly string[]).includes(items.nick_plate_position)
        ? items.nick_plate_position
        : "default";
    }
    set("ws_full_log_enabled", items.ws_full_log_enabled);
    set("safe_controls_layout_enabled", items.safe_controls_layout_enabled);
    for (const kind of ["finish", "outcry", "guess"] as const) {
      const sel = $<HTMLSelectElement>(`ctl_pos_${kind}`);
      // Мусор из storage не должен оставлять селект пустым — нормализуем.
      if (sel) sel.value = readControlPosition(kind, (items as unknown as Record<string, unknown>)[`ctl_pos_${kind}`]);
    }
    set("outcry_hotkey_enabled", items.outcry_hotkey_enabled);
    set("obs_auto_record_enabled", items.obs_auto_record_enabled);
    set("obs_clip_enabled", items.obs_clip_enabled);
    set("profile_mmr_chart_enabled", items.profile_mmr_chart_enabled);
    const clipMin = $<HTMLSelectElement>("obs_clip_minutes");
    if (clipMin) clipMin.value = String(items.obs_clip_minutes || 1);
    set("hotkey_hints_enabled", items.hotkey_hints_enabled);
    set("f5_refresh_fix_enabled", items.f5_refresh_fix_enabled);
    set("update_check_enabled", items.update_check_enabled);
    set("debug_logging_enabled", items.debug_logging_enabled);
    set("connection_diag_enabled", items.connection_diag_enabled);

    // OBS
    const obsEnabled = $<HTMLInputElement>("obs_enabled");
    const obsHost = $<HTMLInputElement>("obs_host");
    const obsPassword = $<HTMLInputElement>("obs_password");
    const obsSettings = $("obs_settings");
    if (obsEnabled) {
      obsEnabled.checked = items.obs_enabled;
      if (obsSettings) obsSettings.style.display = items.obs_enabled ? "block" : "none";
    }
    if (obsHost) obsHost.value = items.obs_host;
    if (obsPassword) obsPassword.value = items.obs_password;

    set("obs_floating_panel_enabled", items.obs_floating_panel_enabled);

    knownDayScene = items.obs_day_scene || "";
    knownNightScene = items.obs_night_scene || "";

    const obsAutoModeEnabled = $<HTMLInputElement>("obs_auto_mode_enabled");
    const obsAutoSettings = $("obs_auto_settings");
    if (obsAutoModeEnabled) {
      obsAutoModeEnabled.checked = items.obs_auto_mode_enabled;
      if (obsAutoSettings)
        obsAutoSettings.style.display = items.obs_auto_mode_enabled ? "block" : "none";
    }

    // Twitch
    const twitchEnabled = $<HTMLInputElement>("twitch_chat_enabled");
    const twitchChannelName = $<HTMLInputElement>("twitch_channel_name");
    const twitchSettings = $("twitch_settings");
    if (twitchEnabled) {
      twitchEnabled.checked = items.twitch_chat_enabled;
      if (twitchSettings) twitchSettings.style.display = items.twitch_chat_enabled ? "block" : "none";
    }
    if (twitchChannelName) twitchChannelName.value = items.twitch_channel_name;
    set("twitch_floating_panel_enabled", items.twitch_floating_panel_enabled);
    set("twitch_chat_everywhere", items.twitch_chat_everywhere);
    if (items.twitch_chat_enabled) {
      // Тихий пробник: попап, открытый с чужой вкладки (YouTube и т.п.),
      // не должен рисовать «⚠️ Откройте страницу игры» в twitch-статус.
      void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.url?.includes("polemicagame.com")) {
          // Тихо: попап открывают и просто посмотреть настройки, а контент
          // мог ещё не загрузиться — предупреждение тут пугает зря.
          void sendMessageToContentScript({ type: "twitch_get_status" }, false);
        }
      });
    }
  });

  // ───────────────────────── Сохранение настроек ─────────────────────────
  const saveSettings = (): Promise<void> => {
    const cb = (id: string, fallback = false): boolean =>
      $<HTMLInputElement>(id)?.checked ?? fallback;
    const val = (id: string, fallback = ""): string => $<HTMLInputElement>(id)?.value || fallback;
    /** Значение селекта толщины рамок с защитой от мусора в DOM. */
    const noteFrameWidthValue = (): NoteFrameWidth => {
      const v = $<HTMLSelectElement>("note_frame_width")?.value;
      return v === "thin" || v === "medium" ? v : "thick";
    };
    /** Пустой список сцен = OBS не подключён; сохранённый выбор трогать нельзя. */
    const sceneVal = (id: string, known: string): string => {
      const sel = $<HTMLSelectElement>(id);
      if (!sel || sel.options.length === 0) return known;
      return sel.value || known;
    };

    const autoHideRolesEnabled = cb("auto_hide_roles_enabled", false);
    const settings: Settings = {
      extension_enabled: cb("extension_enabled", true),
      show_mmr: cb("show_mmr"),
      show_games: cb("show_games"),
      show_id: cb("show_id"),
      show_winrate: cb("show_winrate"),
      show_kills: cb("show_kills"),
      show_roles: cb("show_roles"),
      enable_role_faker: cb("enable_role_faker"),
      disable_webcam_clicks: cb("disable_webcam_clicks", false),
      auto_accept_enabled: cb("auto_accept_enabled", true),
      camera_rotate_enabled: cb("camera_rotate_enabled", true),
      camera_reload_enabled: cb("camera_reload_enabled", true),
      stream_lost_icon_enabled: cb("stream_lost_icon_enabled", true),
      player_mute_enabled: cb("player_mute_enabled", true),
      nick_colors_enabled: cb("nick_colors_enabled", true),
      note_frame_width: noteFrameWidthValue(),
      btn_stats_enabled: cb("btn_stats_enabled", true),
      btn_note_enabled: cb("btn_note_enabled", true),
      btn_last_games_enabled: cb("btn_last_games_enabled", true),
      btn_crossover_enabled: cb("btn_crossover_enabled", true),
      btn_hide_video_enabled: cb("btn_hide_video_enabled", true),
      last_games_count: readLastGamesCount($<HTMLSelectElement>("last_games_count")?.value),
      last_games_first_killed: cb("last_games_first_killed", true),
      note_indicator_enabled: cb("note_indicator_enabled", true),
      role_marker_enabled: cb("role_marker_enabled", false),
      role_marker_icons_enabled: cb("role_marker_icons_enabled", true),
      compact_nicknames_enabled: cb("compact_nicknames_enabled", false),
      nick_plate_position: $<HTMLSelectElement>("nick_plate_position")?.value || "default",
      ws_full_log_enabled: cb("ws_full_log_enabled", false),
      safe_controls_layout_enabled: cb("safe_controls_layout_enabled", true),
      ctl_pos_finish: $<HTMLSelectElement>("ctl_pos_finish")?.value || "right",
      ctl_pos_outcry: $<HTMLSelectElement>("ctl_pos_outcry")?.value || "center",
      ctl_pos_guess: $<HTMLSelectElement>("ctl_pos_guess")?.value || "left",
      f5_refresh_fix_enabled: cb("f5_refresh_fix_enabled", true),
      update_check_enabled: cb("update_check_enabled", true),
      debug_logging_enabled: cb("debug_logging_enabled", true),
      connection_diag_enabled: cb("connection_diag_enabled", false),
      skip_start_screen_enabled: cb("skip_start_screen_enabled", true),
      queue_background_warning_enabled: cb("queue_background_warning_enabled", true),
      requeue_after_lobby_fail_enabled: cb("requeue_after_lobby_fail_enabled", false),
      postgame_requeue_enabled: cb("postgame_requeue_enabled", true),
      postgame_skip_confirm_enabled: cb("postgame_skip_confirm_enabled", true),
      queue_peek_enabled: cb("queue_peek_enabled", false),
      queue_peek_auto: cb("queue_peek_auto", false),
      queue_peek_standard: cb("queue_peek_standard", true),
      queue_peek_polite: cb("queue_peek_polite", true),
      queue_peek_prime: cb("queue_peek_prime", true),
      pause_hotkey_enabled: cb("pause_hotkey_enabled", true),
      pause_hotkey_code: pauseHotkeyCode,
      hotkey_role_fake: roleFakeCode,
      hotkey_role_reset: roleResetCode,
      hotkey_role_hide: roleHideCode,
      hotkey_role_peek: rolePeekCode,
      outcry_hotkey_enabled: cb("outcry_hotkey_enabled", false),
      outcry_hotkey_code: outcryCode,
      obs_auto_record_enabled: cb("obs_auto_record_enabled", false),
      obs_clip_enabled: cb("obs_clip_enabled", false),
      obs_clip_hotkey_code: clipCode,
      obs_clip_minutes: Number($<HTMLSelectElement>("obs_clip_minutes")?.value) || 1,
      hotkey_hints_enabled: cb("hotkey_hints_enabled", true),
      statistics_enabled: cb("statistics_enabled", true),
      session_stats_enabled: cb("session_stats_enabled", false),
      profile_mmr_chart_enabled: cb("profile_mmr_chart_enabled", true),
      match_page_stats_enabled: cb("match_page_stats_enabled", true),
      match_stats_view: $<HTMLSelectElement>("match_stats_view")?.value || "hints",
      stats_button_theme: ($<HTMLSelectElement>("stats_button_theme")?.value || "default"),
      stats_button_color: readButtonColor(currentButtonColor),
      auto_hide_roles_enabled: autoHideRolesEnabled,
      role_phase_auto_switch_enabled:
        autoHideRolesEnabled && cb("role_phase_auto_switch_enabled", false),
      // OBS
      obs_enabled: cb("obs_enabled", false),
      // Санитайзер SEC26-1: userinfo/query отрезаются при сохранении —
      // obs_host синкается в облако и уезжает в бэкап, кредам там не место
      // (пароль — отдельное local-поле, v5 авторизуется хендшейком).
      obs_host: (() => {
        const clean = sanitizeObsHost(val("obs_host", "ws://localhost:4455"));
        // Поле отражает то, что реально сохранится: пользователь должен
        // УВИДЕТЬ, что креды/query вычищены (adversarial 27.08, №7).
        const el = $<HTMLInputElement>("obs_host");
        if (el && el.value.trim() && el.value !== clean) el.value = clean;
        return clean;
      })(),
      obs_password: val("obs_password", ""),
      obs_floating_panel_enabled: cb("obs_floating_panel_enabled", false),
      obs_auto_mode_enabled: cb("obs_auto_mode_enabled", false),
      obs_day_scene: sceneVal("obs_day_scene", knownDayScene),
      obs_night_scene: sceneVal("obs_night_scene", knownNightScene),
      // Twitch
      twitch_chat_enabled: cb("twitch_chat_enabled", false),
      twitch_channel_name: val("twitch_channel_name", ""),
      twitch_floating_panel_enabled: cb("twitch_floating_panel_enabled", false),
      twitch_chat_everywhere: cb("twitch_chat_everywhere", true),
    };

    // Пишем ТОЛЬКО изменившиеся ключи. До завершения загрузки не пишем вовсе —
    // раньше клик до загрузки уезжал в storage снимком HTML-дефолтов
    // (включая пустой пароль OBS).
    if (!lastKnown) return Promise.resolve();
    const patch: Partial<Settings> = {};
    for (const key of Object.keys(settings) as Array<keyof Settings>) {
      if (settings[key] !== lastKnown[key]) (patch as Record<string, unknown>)[key] = settings[key];
    }
    if (Object.keys(patch).length === 0) return Promise.resolve();
    // lastKnown обновляем ТОЛЬКО после успешной записи: оптимистичное
    // обновление при reject (квота sync) навсегда прятало настройку от диффа.
    const prevKnown = lastKnown;

    // setSettings сам разложит obs_password в storage.local.
    // Пара «адрес+пароль» OBS — ОДНОЙ транзакцией фону (ревью 27.08.2026):
    // они лежат в разных областях, storage-события приходят порознь, и фон
    // успевал подключиться к новому серверу со старым паролем. Сообщение
    // несёт обе части; storage остаётся источником правды для синка и UI.
    const endpointTouched = "obs_host" in patch || "obs_password" in patch;
    // Пару «адрес+пароль» пишет ФОН одной транзакцией (ревью 27.08.2026):
    // параллельные sync/local-записи попапа давали частичное состояние —
    // адрес новый, пароль старый — и storage-события успевали это применить.
    const endpointPatch = {
      host: String(settings.obs_host ?? ""),
      password: String(settings.obs_password ?? ""),
    };
    delete (patch as Record<string, unknown>).obs_host;
    delete (patch as Record<string, unknown>).obs_password;
    return setSettings(patch)
      .then(async () => {
        lastKnown = { ...prevKnown, ...patch };
        if (endpointTouched) {
          const tx = await sendRuntime<{ ok?: boolean; stage?: string }>({
            type: "obs_endpoint_set",
            ...endpointPatch,
          });
          // Недоставка (undefined) — тоже отказ: молчание фона не «ок».
          if (!tx || tx.ok !== true) {
            showPopupToast(
              tx?.stage === "host"
                ? "Пароль OBS сохранён, а адрес — нет: повторите"
                : "Настройки OBS не применились — повторите",
              "error",
            );
            // Бросаем: вызывающий (ручной «Подключиться») не должен ехать
            // дальше по НЕзаписанному намерению (ревью 27.08.2026).
            throw new Error("obs endpoint transaction failed");
          } else {
            lastKnown = { ...lastKnown, obs_host: endpointPatch.host, obs_password: endpointPatch.password };
          }
        }
        // Живое обновление фич в content (FeatureManager также реагирует на storage).
        // Пароль OBS в вкладки не рассылаем — content он не нужен, а любой
        // будущий дамп настроек в лог превратил бы это в утечку.
        const { obs_password: _pw, ...safe } = patch;
        if (Object.keys(safe).length) {
          void broadcastToGameTabs({ type: "updateNotesSettings", settings: safe });
        }
        // (updateRoleFaker удалён — это сообщение никто никогда не слушал.)
      })
      .catch((e) => {
        log.error(SCOPE, "saveSettings failed", e);
        showPopupToast("Не удалось сохранить настройки", "error");
        // Ошибку НЕ глотаем: вызывающий (ручной connect) обязан знать, что
        // намерение не записано (ревью 27.08.2026).
        throw e;
      });
  };

  // ───────────────────────── Подписка контролов на change ─────────────────────────
  const simpleChangeIds = [
    "extension_enabled",
    "show_mmr",
    "show_games",
    "show_id",
    "show_winrate",
    "show_kills",
    "show_roles",
    "enable_role_faker",
    "skip_start_screen_enabled",
    "queue_background_warning_enabled",
    "requeue_after_lobby_fail_enabled",
    "postgame_requeue_enabled",
    "postgame_skip_confirm_enabled",
    "queue_peek_enabled",
    "queue_peek_auto",
    "queue_peek_standard",
    "queue_peek_polite",
    "queue_peek_prime",
    "pause_hotkey_enabled",
    "statistics_enabled",
    "session_stats_enabled",
    "profile_mmr_chart_enabled",
    "obs_auto_record_enabled",
    "obs_clip_enabled",
    "obs_clip_minutes",
    "match_page_stats_enabled",
    "stats_button_theme",
    "match_stats_view",
    "auto_hide_roles_enabled",
    "role_phase_auto_switch_enabled",
    "disable_webcam_clicks",
    "auto_accept_enabled",
    "camera_rotate_enabled",
    "camera_reload_enabled",
    "stream_lost_icon_enabled",
    "player_mute_enabled",
    "nick_colors_enabled",
    "note_frame_width",
    "btn_stats_enabled",
    "btn_note_enabled",
    "btn_last_games_enabled",
    "btn_crossover_enabled",
    "btn_hide_video_enabled",
    "last_games_count",
    "last_games_first_killed",
    "note_indicator_enabled",
    "role_marker_enabled",
    "role_marker_icons_enabled",
    "compact_nicknames_enabled",
    "nick_plate_position",
    "ws_full_log_enabled",
    "safe_controls_layout_enabled",
    "ctl_pos_finish",
    "ctl_pos_outcry",
    "ctl_pos_guess",
    "outcry_hotkey_enabled",
    "outcry_hotkey_code",
    "hotkey_hints_enabled",
    "f5_refresh_fix_enabled",
    "update_check_enabled",
    "debug_logging_enabled",
    "connection_diag_enabled",
    "twitch_chat_everywhere",
  ];
  simpleChangeIds.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", saveSettings);
  });

  /**
   * Строка «свой цвет» показывается только у темы «Своя». Отдельный обработчик
   * рядом с сохранением: порядок не важен, оба слушают одно событие.
   */
  function syncCustomColorRow(): void {
    const row = $("stats_button_color_row");
    if (!row) return;
    row.style.display =
      $<HTMLSelectElement>("stats_button_theme")?.value === CUSTOM_THEME ? "" : "none";
  }
  $("stats_button_theme")?.addEventListener("change", syncCustomColorRow);

  /** Строка «Использовать иконки» видна только при включённых метках ролей. */
  function syncRoleMarkerIconsRow(): void {
    const row = $("role_marker_icons_row");
    if (!row) return;
    row.style.display = $<HTMLInputElement>("role_marker_enabled")?.checked ? "" : "none";
  }
  $("role_marker_enabled")?.addEventListener("change", syncRoleMarkerIconsRow);

  // Свой цвет: СОБСТВЕННАЯ палитра внутри попапа + поле #rrggbb. Никакого
  // <input type=color>: системная пипетка на macOS открывается отдельным
  // окном, Firefox на потере фокуса ЗАКРЫВАЕТ попап — и выбранный цвет
  // некуда доставлять (догадка владельца 14.08.2026, подтверждена: три
  // «выбрал — не изменилось» подряд и пустой журнал попапа). Всё ниже живёт
  // в DOM попапа и от системных окон не зависит.
  {
    const preview = $("stats_button_color");
    const hexInput = $<HTMLInputElement>("stats_button_color_hex");
    const grid = $("stats_button_color_grid");
    let colorSaveTimer: number | null = null;
    const applyColor = (hex: string, from: string): void => {
      currentButtonColor = hex;
      if (preview) preview.style.background = hex;
      if (hexInput && hexInput.value.trim().toLowerCase() !== hex) hexInput.value = hex;
      log.info("popup", `цвет (${from})`, hex);
      // Немедленный сброс журнала: попап живёт меньше трёх секунд планового
      // сброса, и без этого его строки умирали вместе с ним (все прошлые
      // «пустые» логи — ровно поэтому).
      log.flushNow();
      if (colorSaveTimer !== null) window.clearTimeout(colorSaveTimer);
      colorSaveTimer = window.setTimeout(() => {
        colorSaveTimer = null;
        saveSettings();
        log.flushNow();
      }, 250);
    };
    reflectButtonColor = (hex: string): void => {
      currentButtonColor = hex;
      if (preview) preview.style.background = hex;
      if (hexInput) hexInput.value = hex;
    };
    // Сетка: 22 ходовых цвета + белый и чёрный. Клик — выбрал.
    if (grid) {
      const swatches = [
        "#ffffff", "#e6e9f0", "#8b93a7", "#000000",
        "#ef4444", "#f97316", "#f59e0b", "#ffd54f",
        "#eab308", "#84cc16", "#22c55e", "#10b981",
        "#14b8a6", "#38bdf8", "#3b82f6", "#4267b2",
        "#6366f1", "#8b5cf6", "#a855f7", "#ec4899",
        "#f43f5e", "#94623c", "#d4a373", "#71717a",
      ];
      for (const hex of swatches) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.title = hex;
        cell.style.cssText =
          `background:${hex};height:22px;border-radius:6px;cursor:pointer;` +
          "border:1px solid rgba(255,255,255,.18);padding:0";
        cell.addEventListener("click", () => applyColor(hex, "клетка"));
        grid.appendChild(cell);
      }
    }
    hexInput?.addEventListener("input", () => {
      const v = hexInput.value.trim().toLowerCase();
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return; // ждём, пока допишет
      applyColor(
        v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v,
        "поле",
      );
    });
  }

  // Мгновенная визуальная реакция на мастер-выключатель (не ждём storage.onChanged).
  $<HTMLInputElement>("extension_enabled")?.addEventListener("change", (e) => {
    applyExtOff((e.target as HTMLInputElement).checked);
  });

  // Зависимость role_phase_auto_switch от auto_hide_roles.
  const autoHideRolesToggle = $<HTMLInputElement>("auto_hide_roles_enabled");
  const rolePhaseToggle = $<HTMLInputElement>("role_phase_auto_switch_enabled");
  if (autoHideRolesToggle && rolePhaseToggle) {
    autoHideRolesToggle.addEventListener("change", () => {
      rolePhaseToggle.disabled = !autoHideRolesToggle.checked;
      if (!autoHideRolesToggle.checked) rolePhaseToggle.checked = false;
    });
  }

  // ───────────────────────── OBS / Twitch ─────────────────────────
  setupOBSHandlers();
  setupTwitchHandlers();
  let twitchStatusTimer: ReturnType<typeof setTimeout> | null = null;

  // Приём событий OBS от background.
  onMessage((message: ExtMessage, sender) => {
    if ("type" in message && message.type === "obs_event") {
      const evt = message as ObsEventMsg;
      log.debug(SCOPE, "received obs_event", evt.eventType);
      handleOBSEvent(evt.eventType, evt.data);
      return { received: true };
    }
    if ("type" in message && message.type === "twitch_status") {
      return browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (sender.tab?.id !== tab?.id) return { received: false };
        const status = message as TwitchStatusMsg;
        if (twitchStatusTimer) clearTimeout(twitchStatusTimer);
        twitchStatusTimer = null;
        const connect = $<HTMLButtonElement>("twitch_connect");
        if (connect) {
          connect.textContent = "Подключиться";
          connect.disabled = false;
        }
        updateTwitchStatus(
          status.error
            ? status.error
            : status.connected
              ? `Подключено: ${status.channel}`
              : "Не подключен",
          status.connected,
        );
        return { received: true };
      });
    }
    return undefined;
  });

  function handleOBSEvent(eventType: ObsEventMsg["eventType"], data: unknown) {
    switch (eventType) {
      case "obs_scenes_updated": {
        const d = data as { scenes?: ObsScene[]; currentScene?: string } | undefined;
        if (d && d.scenes) {
          updateScenesList(d.scenes, d.currentScene);
          updateOBSStatus("Подключено", true);
        }
        break;
      }
      case "obs_scene_changed":
        updateCurrentSceneHighlight(data as string);
        break;
      case "obs_disconnected":
        updateOBSStatus("Отключено", false);
        updateScenesList([]);
        break;
      case "obs_connected":
        updateOBSStatus("Подключено", true);
        break;
    }
  }

  // ───────────────────────── Отправка простых сообщений в content ─────────────────────────
  async function sendMessageToContentScript(
    msg: ExtMessage,
    /** false — не показывать пользователю ошибку (тихий пробник статуса). */
    showErrors = true,
  ): Promise<boolean> {
    log.debug(SCOPE, "send to content", msg);
    const isTwitch = "type" in msg && msg.type.startsWith("twitch_");
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && tab.url.includes("polemicagame.com")) {
      try {
        // Тоже строгая: раньше отказ гасился внутри sendToActiveTab, и
        // команда считалась доставленной (находка 10).
        await sendToActiveTabStrict(msg);
        return true;
      } catch (error) {
        log.debug(SCOPE, "content script not available", error);
        if (showErrors) showContentScriptError(isTwitch);
        return false;
      }
    } else {
      if (showErrors) showWrongPageError(isTwitch);
      return false;
    }
  }

  function showContentScriptError(isTwitch = false) {
    const statusElement = $(isTwitch ? "twitch_status" : "obs_status");
    if (statusElement) {
      statusElement.textContent = "⚠️ Перезагрузите страницу игры";
      statusElement.style.color = "#ff9800";
    }
  }
  function showWrongPageError(isTwitch = false) {
    const statusElement = $(isTwitch ? "twitch_status" : "obs_status");
    if (statusElement) {
      statusElement.textContent = "⚠️ Откройте страницу игры";
      statusElement.style.color = "#ff9800";
    }
  }

  // ───────────────────────── Twitch ─────────────────────────
  function setupTwitchHandlers() {
    const twitchEnabled = $<HTMLInputElement>("twitch_chat_enabled");
    const twitchSettings = $("twitch_settings");
    const twitchConnect = $<HTMLButtonElement>("twitch_connect");
    const twitchDisconnect = $<HTMLButtonElement>("twitch_disconnect");
    const twitchChannelName = $<HTMLInputElement>("twitch_channel_name");
    const twitchFloatingEnabled = $<HTMLInputElement>("twitch_floating_panel_enabled");
    const showTwitchPanel = $<HTMLButtonElement>("show_twitch_panel");
    const hideTwitchPanel = $<HTMLButtonElement>("hide_twitch_panel");

    if (twitchEnabled) {
      twitchEnabled.addEventListener("change", (e) => {
        const enabled = (e.target as HTMLInputElement).checked;
        if (twitchSettings) twitchSettings.style.display = enabled ? "block" : "none";
        if (!enabled) {
          if (twitchStatusTimer) clearTimeout(twitchStatusTimer);
          twitchStatusTimer = null;
          void sendMessageToContentScript({ type: "twitch_disconnect" });
          updateTwitchStatus("Не подключен", false);
        }
        saveSettings();
      });
    }

    if (twitchConnect) {
      twitchConnect.addEventListener("click", () => {
        // При выключенном мастер-тумблере content жив (diag/nickname-responder),
        // поэтому sendToActiveTab не бросит — без этой проверки попап 5 секунд
        // ждал бы ответа и врал «обновите вкладку».
        if (lastKnown?.extension_enabled === false) {
          updateTwitchStatus("Расширение выключено (тумблер в шапке)", false);
          return;
        }
        const channel = twitchChannelName?.value.trim() || "";
        if (!channel) {
          updateTwitchStatus("Введите имя канала", false);
          return;
        }
        try {
          twitchConnect.disabled = true;
          twitchConnect.textContent = "Подключение...";
          updateTwitchStatus("Подключение к чату...", false);
          if (twitchStatusTimer) clearTimeout(twitchStatusTimer);
          twitchStatusTimer = setTimeout(() => {
            twitchStatusTimer = null;
            twitchConnect.textContent = "Подключиться";
            twitchConnect.disabled = false;
            updateTwitchStatus("Нет ответа от страницы игры — обновите вкладку", false);
          }, 5000);
          void sendMessageToContentScript({ type: "twitch_connect", channel }).then((sent) => {
            if (sent) return;
            if (twitchStatusTimer) clearTimeout(twitchStatusTimer);
            twitchStatusTimer = null;
            twitchConnect.textContent = "Подключиться";
            twitchConnect.disabled = false;
          });
          saveSettings();
        } catch (error) {
          log.error(SCOPE, "Twitch connection failed", error);
          updateTwitchStatus(`Ошибка: ${(error as Error)?.message}`, false);
          twitchConnect.textContent = "Подключиться";
          twitchConnect.disabled = false;
        }
      });
    }

    if (twitchDisconnect) {
      twitchDisconnect.addEventListener("click", () => {
        if (twitchStatusTimer) clearTimeout(twitchStatusTimer);
        twitchStatusTimer = null;
        void sendMessageToContentScript({ type: "twitch_disconnect" });
        updateTwitchStatus("Не подключен", false);
      });
    }

    if (twitchChannelName) twitchChannelName.addEventListener("change", saveSettings);
    if (twitchFloatingEnabled) twitchFloatingEnabled.addEventListener("change", saveSettings);

    if (showTwitchPanel) {
      showTwitchPanel.addEventListener("click", () => {
        const fl = $<HTMLInputElement>("twitch_floating_panel_enabled");
        if (fl) {
          fl.checked = true;
          saveSettings();
        }
        void sendMessageToContentScript({ type: "twitch_panel_show" });
      });
    }
    if (hideTwitchPanel) {
      hideTwitchPanel.addEventListener("click", () => {
        const fl = $<HTMLInputElement>("twitch_floating_panel_enabled");
        if (fl) {
          fl.checked = false;
          saveSettings();
        }
        void sendMessageToContentScript({ type: "twitch_panel_hide" });
      });
    }
  }

  function updateTwitchStatus(text: string, connected = false) {
    const statusElement = $("twitch_status");
    if (statusElement) {
      statusElement.textContent = text;
      statusElement.style.color = connected ? "#9146FF" : "#666";
    }
  }

  // ───────────────────────── Аватар ─────────────────────────
  // (Блок загрузки аватара удалён: кнопок upload_avatar/avatar_upload в
  // popup.html не существовало — вся цепочка была мёртвой с момента порта.)

  // ───────────────────────── OBS ─────────────────────────
  function setupOBSHandlers() {
    const obsEnabled = $<HTMLInputElement>("obs_enabled");
    const obsSettings = $("obs_settings");
    const obsConnect = $<HTMLButtonElement>("obs_connect");
    const obsDisconnect = $<HTMLButtonElement>("obs_disconnect");
    const obsHost = $<HTMLInputElement>("obs_host");
    const obsPassword = $<HTMLInputElement>("obs_password");
    const obsFloatingEnabled = $<HTMLInputElement>("obs_floating_panel_enabled");
    const showFloatingPanel = $<HTMLButtonElement>("show_floating_panel");
    const hideFloatingPanel = $<HTMLButtonElement>("hide_floating_panel");

    // «Сохранить клип» — тот же путь, что у клавиши: replay_save в фон.
    const saveClipBtn = $<HTMLButtonElement>("obs_save_clip");
    if (saveClipBtn) {
      saveClipBtn.addEventListener("click", async () => {
        const original = saveClipBtn.textContent;
        saveClipBtn.disabled = true;
        try {
          await sendOBSCommand("replay_save");
          saveClipBtn.textContent = "✓ Клип сохранён";
        } catch (e) {
          saveClipBtn.textContent = "✗ " + ((e as Error).message || "не удалось");
        } finally {
          setTimeout(() => {
            saveClipBtn.textContent = original;
            saveClipBtn.disabled = false;
          }, 2500);
        }
      });
    }

    if (obsEnabled) {
      obsEnabled.addEventListener("change", async (e) => {
        const enabled = (e.target as HTMLInputElement).checked;
        if (obsSettings) obsSettings.style.display = enabled ? "block" : "none";
        // Сначала сохраняем НАМЕРЕНИЕ, потом рвём соединение: закрытие
        // попапа во время await оставляло background с ручным отключением,
        // но с obs_enabled=true в настройках (находка 14).
        saveSettings();
        if (!enabled) {
          await sendOBSCommand("disconnect");
          updateOBSStatus("Не подключено", false);
          updateScenesList([]);
        }
      });
    }

    if (obsConnect) {
      obsConnect.addEventListener("click", async () => {
        // Санитайзер и здесь (ревью 27.08.2026, п.2): ручной connect брал
        // СЫРОЕ поле, то есть мог унести креды в команду мимо границы.
        const host = sanitizeObsHost(obsHost?.value || "ws://localhost:4455");
        const password = obsPassword?.value || "";
        try {
          obsConnect.disabled = true;
          obsConnect.textContent = "Подключение...";
          updateOBSStatus("Подключение...", false);
          // НАМЕРЕНИЕ фиксируем ДО длинной операции: попап закрывается при
          // потере фокуса, и если это случилось за время ожидания (до 10с),
          // background подключался по данным команды, а host/пароль в
          // настройках оставались прежними — следующий reconcile рвал
          // соединение (аудит lifecycle 01.08.2026, находка 14).
          // ЖДЁМ сохранения: fire-and-forget оставлял окно, где команда
          // connect уходила раньше записи намерения (ревью 27.08.2026).
          // Падение — стоп: подключаться по незаписанному намерению нельзя.
          try {
            await saveSettings();
          } catch {
            updateOBSStatus("Настройки не сохранились", false);
            return;
          }

          // Значения из ТОГО ЖЕ снимка, что ушёл в сохранение и транзакцию
          // (ревью 27.08.2026): раньше команда могла унести host, набранный
          // после/до сохранения — расхождение, которое потом не отладить.
          const result = await sendOBSCommand("connect", { url: host, password });
          if (result) {
            updateOBSStatus("Подключено", true);
            const status = await sendOBSCommand("get_status");
            const st = status as { scenes?: ObsScene[]; currentScene?: string } | undefined;
            if (st?.scenes && st.scenes.length > 0) {
              updateScenesList(st.scenes, st.currentScene);
            }
          }
          obsConnect.textContent = "Подключиться";
        } catch (error) {
          log.error(SCOPE, "OBS connection failed", error);
          updateOBSStatus(`Ошибка: ${(error as Error)?.message}`, false);
          obsConnect.textContent = "Подключиться";
        } finally {
          obsConnect.disabled = false;
        }
      });
    }

    if (obsDisconnect) {
      obsDisconnect.addEventListener("click", async () => {
        try {
          await sendOBSCommand("disconnect");
          updateOBSStatus("Не подключено", false);
          updateScenesList([]);
        } catch (error) {
          log.error(SCOPE, "Failed to disconnect", error);
        }
      });
    }

    if (obsHost) {
      obsHost.addEventListener("change", () => {
        // Сменился сервер — старый пароль ему не принадлежит (ревью
        // 27.08.2026): очищаем СРАЗУ, иначе между двумя правками полей
        // расширение успевало постучаться к новому OBS чужим паролем.
        if (obsHost.value.trim() !== (lastKnown?.obs_host ?? "") && obsPassword) {
          obsPassword.value = "";
        }
        saveSettings();
      });
    }
    if (obsPassword) obsPassword.addEventListener("change", saveSettings);
    if (obsFloatingEnabled) obsFloatingEnabled.addEventListener("change", saveSettings);

    const obsAutoModeEnabled = $<HTMLInputElement>("obs_auto_mode_enabled");
    const obsAutoSettings = $("obs_auto_settings");
    if (obsAutoModeEnabled && obsAutoSettings) {
      obsAutoModeEnabled.addEventListener("change", (e) => {
        const enabled = (e.target as HTMLInputElement).checked;
        obsAutoSettings.style.display = enabled ? "block" : "none";
        saveSettings();
      });
    }

    const obsDayScene = $<HTMLSelectElement>("obs_day_scene");
    const obsNightScene = $<HTMLSelectElement>("obs_night_scene");
    if (obsDayScene)
      obsDayScene.addEventListener("change", () => {
        knownDayScene = obsDayScene.value;
        saveSettings();
      });
    if (obsNightScene)
      obsNightScene.addEventListener("change", () => {
        knownNightScene = obsNightScene.value;
        saveSettings();
      });

    if (showFloatingPanel) {
      showFloatingPanel.addEventListener("click", () => {
        const fl = $<HTMLInputElement>("obs_floating_panel_enabled");
        if (fl) {
          fl.checked = true;
          saveSettings();
        }
        void broadcastToGameTabs({ type: "updateNotesSettings", settings: { obs_floating_panel_enabled: true } });
      });
    }
    if (hideFloatingPanel) {
      hideFloatingPanel.addEventListener("click", () => {
        const fl = $<HTMLInputElement>("obs_floating_panel_enabled");
        if (fl) {
          fl.checked = false;
          saveSettings();
        }
        void broadcastToGameTabs({ type: "updateNotesSettings", settings: { obs_floating_panel_enabled: false } });
      });
    }

    void restoreOBSState();
  }

  async function restoreOBSState() {
    try {
      const status = await sendOBSCommand("get_status");
      const st = status as
        | { connected?: boolean; scenes?: ObsScene[]; currentScene?: string }
        | undefined;
      if (st?.connected) {
        updateOBSStatus("Подключено", true);
        if (st.scenes && st.scenes.length > 0) updateScenesList(st.scenes, st.currentScene);
      } else {
        updateOBSStatus("Не подключено", false);
        updateScenesList([]);
      }
    } catch (error) {
      log.error(SCOPE, "Failed to restore OBS state", error);
      updateOBSStatus("Не подключено", false);
    }
  }

  /**
   * Команда OBS в background. Разворачивает ответ { success, data, error }.
   */
  async function sendOBSCommand(
    command: "connect" | "disconnect" | "get_status" | "set_scene" | "get_scenes" | "replay_save",
    data: { url?: string; password?: string; sceneName?: string } = {},
  ): Promise<unknown> {
    const response = await sendRuntime<{ success: boolean; data?: unknown; error?: string }>({
      type: "obs_command",
      command,
      data,
    });
    if (response && response.success) return response.data;
    throw new Error(response?.error || "Unknown error");
  }

  function updateOBSStatus(status: string, connected: boolean) {
    const statusElement = $("obs_status");
    if (statusElement) {
      statusElement.textContent = status;
      statusElement.style.color = connected ? "#4CAF50" : "#666";
    }
  }

  function updateScenesList(scenes: ObsScene[], currentScene?: string) {
    const scenesList = $("scenes_list");
    const obsDayScene = $<HTMLSelectElement>("obs_day_scene");
    const obsNightScene = $<HTMLSelectElement>("obs_night_scene");
    if (!scenesList) return;

    if (!scenes || scenes.length === 0) {
      scenesList.innerHTML = '<div class="scenes-empty">Нет доступных сцен</div>';
      if (obsDayScene) obsDayScene.innerHTML = '<option value="">Выберите сцену</option>';
      if (obsNightScene) obsNightScene.innerHTML = '<option value="">Выберите сцену</option>';
      return;
    }

    // Никаких inline-обработчиков: они запрещены CSP в MV3. Ховер — в CSS,
    // имя сцены приходит из OBS и экранируется.
    scenesList.innerHTML = scenes
      .map((scene) => {
        const isActive = scene.sceneName === currentScene;
        const safe = escapeHtml(scene.sceneName);
        return `<div class="scene-item${isActive ? " active" : ""}" data-scene="${safe}">${safe}${
          isActive ? " (активная)" : ""
        }</div>`;
      })
      .join("");

    scenesList.querySelectorAll<HTMLElement>(".scene-item").forEach((item) => {
      item.addEventListener("click", async () => {
        const sceneName = item.dataset.scene ?? "";
        try {
          await sendOBSCommand("set_scene", { sceneName });
          updateCurrentSceneHighlight(sceneName);
        } catch (error) {
          log.error(SCOPE, "Failed to switch scene", error);
          updateOBSStatus(`Ошибка смены сцены: ${(error as Error)?.message}`, true);
        }
      });
    });

    // Имя сцены приходит из OBS — экранируем перед вставкой в разметку.
    const sceneOptions =
      '<option value="">Выберите сцену</option>' +
      scenes
        .map((scene) => {
          const safe = escapeHtml(scene.sceneName);
          return `<option value="${safe}">${safe}</option>`;
        })
        .join("");

    if (obsDayScene) {
      obsDayScene.innerHTML = sceneOptions;
      obsDayScene.value = knownDayScene;
    }
    if (obsNightScene) {
      obsNightScene.innerHTML = sceneOptions;
      obsNightScene.value = knownNightScene;
    }
  }

  function updateCurrentSceneHighlight(sceneName: string) {
    const scenesList = $("scenes_list");
    if (!scenesList) return;
    scenesList.querySelectorAll<HTMLElement>(".scene-item").forEach((item) => {
      const isActive = item.dataset.scene === sceneName;
      item.classList.toggle("active", isActive);
      const baseName = item.dataset.scene ?? "";
      item.textContent = baseName + (isActive ? " (активная)" : "");
    });
  }
});
