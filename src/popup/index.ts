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
  mergeNotes,
  isSafeTag,
  TAGS_KEY,
  MAX_IMPORT_ENTRIES,
} from "@core/notes-store";

/** Сколько игр с метками ролей принимаем из чужого файла (у фичи лимит 50). */
const MAX_IMPORT_ROLE_GAMES = 50;

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
  $("download_logs")?.addEventListener("click", async () => {
    const entries = await log.collectAll();
    const complete = log.isComplete();
    const head = [
      `Polemica Notes ${browser.runtime.getManifest().version}`,
      `UA: ${navigator.userAgent}`,
      `exported: ${new Date().toISOString()}`,
      `entries: ${entries.length}`,
      // Шапка должна отвечать на вопрос «можно ли верить этому файлу» до того,
      // как по нему начнут делать выводы (аудит наблюдаемости, LOG-1).
      `complete: ${complete ? "yes" : "NO — часть записей потеряна, storage.local отказал"}`,
      "",
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
    // Заодно уборка: попап — единственное место, куда человек приходит сам,
    // и удобный момент вернуть браузеру место.
    await wsLog.sweepStorage();
    const frames = await wsLog.collectAll();
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
    const blob = new Blob([wsLog.formatFrames(frames)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polemica-ws-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showPopupToast(`Кадров: ${frames.length}`);
  });
  $("clear_ws_log")?.addEventListener("click", async () => {
    await wsLog.clearAll();
    showPopupToast("Полный лог очищен");
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
          // Смена адреса OBS = другой сервер: старый пароль ему не отдаём.
          if (
            typeof settingsPatch.obs_host === "string" &&
            settingsPatch.obs_host !== lastKnown?.obs_host
          ) {
            settingsPatch.obs_password = "";
          }
        }

        const applySettings = async (): Promise<number> => {
          if (!Object.keys(settingsPatch).length) return 0;
          try {
            await setSettings(settingsPatch as Partial<Settings>);
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
        const applyExtras = async (): Promise<void> => {
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
          if (!tags.length && !muted.length && !hasMarks) return;
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
              for (const [game, marks] of Object.entries(incomingMarks as Record<string, unknown>)) {
                if (addedGames >= MAX_IMPORT_ROLE_GAMES) break;
                if (typeof game !== "string" || game.length > 200) continue;
                if (!marks || typeof marks !== "object" || Array.isArray(marks)) continue;
                if (game in merged) continue;
                // Значения — только строки-идентификаторы ролей.
                const clean: Record<string, string> = {};
                for (const [player, role] of Object.entries(marks as Record<string, unknown>)) {
                  if (typeof player !== "string" || player.length > 200) continue;
                  if (typeof role !== "string" || role.length > 40) continue;
                  clean[player] = role;
                }
                merged[game] = clean;
                addedGames++;
              }
              patch.roleMarks = merged;
            }
            await browser.storage.local.set(patch);
          } catch (e) {
            log.error(SCOPE, "extras import failed", e);
          }
        };

        if (Object.keys(incoming).length === 0) {
          const restoredSettings = await applySettings();
          await applyExtras();
          showPopupToast(
            restoredSettings
              ? `Восстановлено настроек: ${restoredSettings}. Заметок в файле нет`
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
        const { added, replaced } = mergeNotes(notes, incoming);
        if (!added && !replaced) {
          const onlyExtras = await applySettings();
          await applyExtras();
          showPopupToast(
            onlyExtras
              ? `Все заметки из файла уже есть; настроек: ${onlyExtras}`
              : "Все заметки из файла уже есть",
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
        const applied = await sendRuntime<NotesResultMsg>({
          type: "notes_merge",
          incoming: incoming as Record<string, unknown>,
        });
        if (applied?.reason === "read_failed") {
          // Координатор ОСОЗНАННО отказал (не смог прочитать карту) — писать
          // напрямую нельзя, это обход защиты «не поверх непрочитанного».
          showPopupToast("Не удалось прочитать текущие заметки — импорт отменён", "error");
          return;
        }
        if (!applied || applied.ok !== true) {
          // Фолбэк на прямую запись, если координатор недоступен: терять
          // импорт из-за спящего воркера нельзя.
          const fallbackMerged = mergeNotes(notes, incoming).merged;
          if (!(await saveNotes(fallbackMerged))) {
            showPopupToast("Не удалось сохранить заметки", "error");
            return;
          }
        }
        // Настройки применяем ПОСЛЕ успешной записи заметок (находка 6).
        const restoredSettings = await applySettings();
        await applyExtras();
        // Авторитетные цифры — от координатора: он считал их на свежей карте
        // (в игровой вкладке могли править заметки в эти же секунды).
        const addedFinal = applied?.added ?? added;
        const replacedFinal = applied?.replaced ?? replaced;
        const notesMsg = replacedFinal
          ? `Добавлено: ${addedFinal}, обновлено: ${replacedFinal}`
          : `Импортировано заметок: ${addedFinal}`;
        showPopupToast(
          restoredSettings ? `${notesMsg}; настроек: ${restoredSettings}` : notesMsg,
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
      // <input type="color"> молча превращает НЕцвет в чёрный, а следующий же
      // клик по любому тумблеру записал бы этот чёрный в настройки. При
      // загрузке мы такое значение нормализуем — здесь обязаны так же.
      else if (el.type === "color") el.value = readButtonColor(value);
      else if (typeof value === "string") el.value = value;
    }
    // Зависимые блоки видимости.
    if ("extension_enabled" in patch) applyExtOff(patch.extension_enabled !== false);
    // Тему могли сменить с другого устройства — строка своего цвета обязана
    // появиться/исчезнуть вместе с ней.
    if ("stats_button_theme" in patch) syncCustomColorRow();
    if (typeof patch.stats_button_color === "string") {
      const hex = $<HTMLInputElement>("stats_button_color_hex");
      if (hex) hex.value = readButtonColor(patch.stats_button_color);
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
    if (
      patch.hotkey_role_fake ||
      patch.hotkey_role_reset ||
      patch.hotkey_role_hide ||
      patch.hotkey_role_peek ||
      patch.outcry_hotkey_code
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
    roleKeyRenders.forEach((r) => r());
    const set = (id: string, val: boolean) => {
      const el = $<HTMLInputElement>(id);
      if (el) el.checked = val;
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
    set("match_page_stats_enabled", items.match_page_stats_enabled);

    const sbt = $<HTMLSelectElement>("stats_button_theme");
    if (sbt) sbt.value = items.stats_button_theme || "default";
    const sbc = $<HTMLInputElement>("stats_button_color");
    // Нормализация: <input type="color"> молча показывает чёрный на мусоре.
    if (sbc) sbc.value = readButtonColor(items.stats_button_color);
    const sbcHex = $<HTMLInputElement>("stats_button_color_hex");
    if (sbcHex) sbcHex.value = readButtonColor(items.stats_button_color);
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
    set("role_marker_enabled", items.role_marker_enabled);
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
  const saveSettings = () => {
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
      role_marker_enabled: cb("role_marker_enabled", false),
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
      hotkey_hints_enabled: cb("hotkey_hints_enabled", true),
      statistics_enabled: cb("statistics_enabled", true),
      match_page_stats_enabled: cb("match_page_stats_enabled", true),
      match_stats_view: $<HTMLSelectElement>("match_stats_view")?.value || "hints",
      stats_button_theme: ($<HTMLSelectElement>("stats_button_theme")?.value || "default"),
      stats_button_color: readButtonColor($<HTMLInputElement>("stats_button_color")?.value),
      auto_hide_roles_enabled: autoHideRolesEnabled,
      role_phase_auto_switch_enabled:
        autoHideRolesEnabled && cb("role_phase_auto_switch_enabled", false),
      // OBS
      obs_enabled: cb("obs_enabled", false),
      obs_host: val("obs_host", "ws://localhost:4455"),
      obs_password: val("obs_password", ""),
      obs_floating_panel_enabled: cb("obs_floating_panel_enabled", false),
      obs_auto_mode_enabled: cb("obs_auto_mode_enabled", false),
      obs_day_scene: sceneVal("obs_day_scene", knownDayScene),
      obs_night_scene: sceneVal("obs_night_scene", knownNightScene),
      // Twitch
      twitch_chat_enabled: cb("twitch_chat_enabled", false),
      twitch_channel_name: val("twitch_channel_name", ""),
      twitch_floating_panel_enabled: cb("twitch_floating_panel_enabled", false),
    };

    // Пишем ТОЛЬКО изменившиеся ключи. До завершения загрузки не пишем вовсе —
    // раньше клик до загрузки уезжал в storage снимком HTML-дефолтов
    // (включая пустой пароль OBS).
    if (!lastKnown) return;
    const patch: Partial<Settings> = {};
    for (const key of Object.keys(settings) as Array<keyof Settings>) {
      if (settings[key] !== lastKnown[key]) (patch as Record<string, unknown>)[key] = settings[key];
    }
    if (Object.keys(patch).length === 0) return;
    // lastKnown обновляем ТОЛЬКО после успешной записи: оптимистичное
    // обновление при reject (квота sync) навсегда прятало настройку от диффа.
    const prevKnown = lastKnown;

    // setSettings сам разложит obs_password в storage.local.
    void setSettings(patch)
      .then(() => {
        lastKnown = { ...prevKnown, ...patch };
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
    "match_page_stats_enabled",
    "stats_button_theme",
    "stats_button_color",
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
    "role_marker_enabled",
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

  // Свой цвет. Два пути, потому что родной color-input на macOS в попапе
  // Firefox может вовсе не получать значение из системной палитры (жалобы
  // владельца 14.08.2026, дважды): 1) живой выбор пипеткой с дросселем;
  // 2) ТЕКСТОВОЕ поле #rrggbb — работает везде и не зависит от палитры.
  // Каждый путь пишет в журнал: если палитра снова промолчит, это станет
  // видно по отсутствию строки, а не по новой загадке.
  {
    const colorInput = $<HTMLInputElement>("stats_button_color");
    const hexInput = $<HTMLInputElement>("stats_button_color_hex");
    let colorSaveTimer: number | null = null;
    const scheduleSave = (): void => {
      if (colorSaveTimer !== null) window.clearTimeout(colorSaveTimer);
      colorSaveTimer = window.setTimeout(() => {
        colorSaveTimer = null;
        saveSettings();
      }, 250);
    };
    colorInput?.addEventListener("input", () => {
      log.debug("popup", "цвет из палитры", colorInput.value);
      if (hexInput) hexInput.value = colorInput.value;
      scheduleSave();
    });
    colorInput?.addEventListener("change", () => {
      log.debug("popup", "палитра закрыта", colorInput.value);
    });
    hexInput?.addEventListener("input", () => {
      const v = hexInput.value.trim().toLowerCase();
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return; // ждём, пока допишет
      log.debug("popup", "цвет из поля", v);
      if (colorInput) colorInput.value = v.length === 4
        ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
        : v;
      scheduleSave();
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
        const host = obsHost?.value || "ws://localhost:4455";
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
          saveSettings();

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

    if (obsHost) obsHost.addEventListener("change", saveSettings);
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
    command: "connect" | "disconnect" | "get_status" | "set_scene" | "get_scenes",
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
