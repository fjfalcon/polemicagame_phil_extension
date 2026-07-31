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
import { browser } from "@core/env";
import { log } from "@core/log";
import { installErrorCapture } from "@core/errors";
import { getSettings, setSettings, onSettingsChanged, DEFAULT_SETTINGS } from "@core/settings";
import { formatKeyCode, isModifierCode } from "@core/keyboard";
import { escapeHtml } from "@core/escape";
import { loadNotes, saveNotes, mergeNotes } from "@core/notes-store";
import type { NotesMap } from "@core/notes-store";
import {
  sendRuntime,
  sendToActiveTab,
  broadcastToGameTabs,
  onMessage,
} from "@core/messaging";
import type {
  Settings,
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

  // ───────────────────────── Версия в шапке ─────────────────────────
  const verEl = $("popup_version");
  if (verEl) verEl.textContent = `v${browser.runtime.getManifest().version}`;

  // ───────────────────────── Логи: скачать / очистить ─────────────────────────
  $("download_logs")?.addEventListener("click", async () => {
    const entries = await log.collectAll();
    const head = [
      `Polemica Notes ${browser.runtime.getManifest().version}`,
      `UA: ${navigator.userAgent}`,
      `exported: ${new Date().toISOString()}`,
      `entries: ${entries.length}`,
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
    showPopupToast(`Логов: ${entries.length}`);
  });
  $("clear_logs")?.addEventListener("click", async () => {
    await log.clearAll();
    showPopupToast("Логи очищены");
  });

  // ───────────────────────── Проверка обновления вручную ─────────────────────────
  // Плановая проверка ходит на GitHub раз в час и между запросами отвечает из
  // кэша — сразу после выхода релиза баннера на странице ещё нет. Кнопка
  // спрашивает GitHub немедленно и заодно сбрасывает кэш, чтобы контент-скрипт
  // показал баннер на следующей же странице.
  const checkUpdateBtn = $<HTMLButtonElement>("check_update_now");
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener("click", async () => {
      const current = browser.runtime.getManifest().version;
      checkUpdateBtn.disabled = true;
      checkUpdateBtn.textContent = "Проверяю…";
      try {
        const res = await fetch(
          "https://api.github.com/repos/fjfalcon/polemicagame_phil_extension/releases/latest",
          { headers: { Accept: "application/vnd.github+json" } },
        );
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        const data = (await res.json()) as { tag_name?: string; html_url?: string };
        const latest = String(data.tag_name || "").replace(/^v/, "");
        if (!latest) throw new Error("пустой тег");

        // Свежий ответ кладём в общий кэш: баннер на странице появится сразу,
        // а «не напоминать» для новой версии сбрасываем — она ещё не показана.
        await browser.storage.local.set({
          pn_update_last_check: Date.now(),
          pn_update_latest: latest,
        });

        const cmp = (a: string, b: string): number => {
          const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
          const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
          }
          return 0;
        };
        if (cmp(latest, current) > 0) {
          showPopupToast(`Доступна версия ${latest} (у вас ${current}) — открываю страницу релиза`);
          void browser.tabs.create({ url: data.html_url || `https://github.com/fjfalcon/polemicagame_phil_extension/releases/latest` });
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
        await sendToActiveTab({ type: "openNickColors" });
        window.close(); // попап закрываем — диалог уже на странице
      } catch {
        showPopupToast("Не удалось открыть менеджер на странице", "error");
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
        const payload = {
          app: "polemica-notes",
          type: "notes-backup",
          version: browser.runtime.getManifest().version,
          exportedAt: new Date().toISOString(),
          settings: safeSettings,
          notes,
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
        const data = JSON.parse(await file.text());
        const incoming = (data?.notes ?? (data?.app ? {} : data)) as NotesMap;
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
          throw new Error("bad format");
        }

        // ── настройки из бэкапа (8.1.56) ──
        // Берём ТОЛЬКО известные ключи и только с совпадающим типом: файл
        // мог прийти от другого человека, из будущей версии или быть правлен
        // руками. obs_password не импортируем — его там и нет.
        let restoredSettings = 0;
        const rawSettings = data?.settings;
        if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
          const patch: Record<string, unknown> = {};
          for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
            if (key === "obs_password" || !(key in rawSettings)) continue;
            const value = (rawSettings as Record<string, unknown>)[key];
            if (typeof value === typeof def) patch[key] = value;
          }
          if (Object.keys(patch).length) {
            try {
              await setSettings(patch as Partial<Settings>);
              restoredSettings = Object.keys(patch).length;
              const applied = await getSettings();
              lastKnown = applied;
              reflectPatch(applied);
              const { obs_password: _pw, ...safe } = applied;
              void broadcastToGameTabs({ type: "updateNotesSettings", settings: safe });
            } catch (e) {
              log.error(SCOPE, "settings import failed", e);
              showPopupToast("Настройки из файла восстановить не удалось", "error");
            }
          }
        }

        if (Object.keys(incoming).length === 0) {
          showPopupToast(
            restoredSettings
              ? `Восстановлено настроек: ${restoredSettings}. Заметок в файле нет`
              : "В файле нет заметок",
            restoredSettings ? "success" : "error",
          );
          return;
        }

        // mergeNotes понимает и старый строковый формат заметок — прежний импорт
        // молча выбрасывал такие записи и всё равно рисовал зелёный тост.
        const { notes, loadFailed } = await loadNotes();
        if (loadFailed) {
          // Мерж в непрочитанную (пустую) карту с последующей записью стёр бы
          // все существующие заметки, заменив их содержимым файла.
          showPopupToast("Не удалось прочитать текущие заметки — импорт отменён", "error");
          return;
        }
        const { merged, added, replaced } = mergeNotes(notes, incoming);
        if (!added && !replaced) {
          showPopupToast("Все заметки из файла уже есть");
          return;
        }
        if (!(await saveNotes(merged))) {
          showPopupToast("Не удалось сохранить заметки", "error");
          return;
        }
        const notesMsg = replaced
          ? `Добавлено: ${added}, обновлено: ${replaced}`
          : `Импортировано заметок: ${added}`;
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
      else if (typeof value === "string") el.value = value;
    }
    // Зависимые блоки видимости.
    if ("extension_enabled" in patch) applyExtOff(patch.extension_enabled !== false);
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
    if (patch.hotkey_role_fake || patch.hotkey_role_reset || patch.hotkey_role_hide) {
      roleKeyRenders.forEach((r) => r());
    }
  };

  // Точечные писатели из content (закрытие панели крестиком) и другие
  // устройства теперь видны попапу сразу.
  onSettingsChanged((patch) => {
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
    set("player_mute_enabled", items.player_mute_enabled);
    set("nick_colors_enabled", items.nick_colors_enabled);
    set("btn_stats_enabled", items.btn_stats_enabled);
    set("btn_note_enabled", items.btn_note_enabled);
    set("btn_last_games_enabled", items.btn_last_games_enabled);
    set("btn_hide_video_enabled", items.btn_hide_video_enabled);
    set("role_marker_enabled", items.role_marker_enabled);
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
          void sendMessageToContentScript({ type: "twitch_get_status" });
        }
      });
    }
  });

  // ───────────────────────── Сохранение настроек ─────────────────────────
  const saveSettings = () => {
    const cb = (id: string, fallback = false): boolean =>
      $<HTMLInputElement>(id)?.checked ?? fallback;
    const val = (id: string, fallback = ""): string => $<HTMLInputElement>(id)?.value || fallback;
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
      player_mute_enabled: cb("player_mute_enabled", true),
      nick_colors_enabled: cb("nick_colors_enabled", true),
      btn_stats_enabled: cb("btn_stats_enabled", true),
      btn_note_enabled: cb("btn_note_enabled", true),
      btn_last_games_enabled: cb("btn_last_games_enabled", true),
      btn_hide_video_enabled: cb("btn_hide_video_enabled", true),
      role_marker_enabled: cb("role_marker_enabled", false),
      f5_refresh_fix_enabled: cb("f5_refresh_fix_enabled", true),
      update_check_enabled: cb("update_check_enabled", true),
      debug_logging_enabled: cb("debug_logging_enabled", true),
      connection_diag_enabled: cb("connection_diag_enabled", false),
      skip_start_screen_enabled: cb("skip_start_screen_enabled", true),
      queue_background_warning_enabled: cb("queue_background_warning_enabled", true),
      requeue_after_lobby_fail_enabled: cb("requeue_after_lobby_fail_enabled", false),
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
      statistics_enabled: cb("statistics_enabled", true),
      match_page_stats_enabled: cb("match_page_stats_enabled", true),
      match_stats_view: $<HTMLSelectElement>("match_stats_view")?.value || "hints",
      stats_button_theme: ($<HTMLSelectElement>("stats_button_theme")?.value || "default"),
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
    "queue_peek_enabled",
    "queue_peek_auto",
    "queue_peek_standard",
    "queue_peek_polite",
    "queue_peek_prime",
    "pause_hotkey_enabled",
    "statistics_enabled",
    "match_page_stats_enabled",
    "stats_button_theme",
    "match_stats_view",
    "auto_hide_roles_enabled",
    "role_phase_auto_switch_enabled",
    "disable_webcam_clicks",
    "auto_accept_enabled",
    "camera_rotate_enabled",
    "player_mute_enabled",
    "nick_colors_enabled",
    "btn_stats_enabled",
    "btn_note_enabled",
    "btn_last_games_enabled",
    "btn_hide_video_enabled",
    "role_marker_enabled",
    "f5_refresh_fix_enabled",
    "update_check_enabled",
    "debug_logging_enabled",
    "connection_diag_enabled",
  ];
  simpleChangeIds.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", saveSettings);
  });

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
  async function sendMessageToContentScript(msg: ExtMessage): Promise<boolean> {
    log.debug(SCOPE, "send to content", msg);
    const isTwitch = "type" in msg && msg.type.startsWith("twitch_");
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && tab.url.includes("polemicagame.com")) {
      try {
        await sendToActiveTab(msg);
        return true;
      } catch (error) {
        log.debug(SCOPE, "content script not available", error);
        showContentScriptError(isTwitch);
        return false;
      }
    } else {
      showWrongPageError(isTwitch);
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
        if (!enabled) {
          await sendOBSCommand("disconnect");
          updateOBSStatus("Не подключено", false);
          updateScenesList([]);
        }
        saveSettings();
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
          saveSettings();
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
