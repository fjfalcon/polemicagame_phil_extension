/**
 * Единственный источник правды по настройкам.
 * Поверх storage.sync (+ storage.local для секретов) с типизацией и подписками.
 *
 * Безопасность: obs_password живёт в storage.local, чтобы пароль OBS НЕ уходил
 * в облачную синхронизацию аккаунта (фикс прежнего поведения).
 */
import { browser } from "./env";
import { log } from "./log";
import type { Settings, SettingKey } from "@shared/types";

export const DEFAULT_SETTINGS: Settings = {
  show_mmr: true,
  show_games: true,
  show_id: false,
  show_winrate: true,
  show_kills: true,
  show_roles: true,
  statistics_enabled: true,
  match_page_stats_enabled: true,
  stats_button_theme: "default",
  auto_accept_enabled: true,
  skip_start_screen_enabled: true,
  pause_hotkey_enabled: true,
  pause_hotkey_code: "F8",
  disable_webcam_clicks: false,
  enable_role_faker: false,
  auto_hide_roles_enabled: false,
  role_phase_auto_switch_enabled: false,
  camera_rotate_enabled: true,
  f5_refresh_fix_enabled: true,
  remember_player_volume_enabled: true,
  hotkey_role_fake: "KeyF",
  hotkey_role_reset: "KeyE",
  hotkey_role_hide: "KeyD",
  update_check_enabled: true,
  obs_enabled: false,
  obs_host: "ws://localhost:4455",
  obs_password: "",
  obs_floating_panel_enabled: false,
  obs_auto_mode_enabled: false,
  obs_day_scene: "",
  obs_night_scene: "",
  twitch_chat_enabled: false,
  twitch_channel_name: "",
  twitch_floating_panel_enabled: false,
};

/** Ключи, хранящиеся локально (не синхронизируются в облако). */
const LOCAL_KEYS = new Set<SettingKey>(["obs_password"]);

function isLocal(key: string): key is SettingKey {
  return LOCAL_KEYS.has(key as SettingKey);
}

function splitDefaults() {
  const sync: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    (isLocal(k) ? local : sync)[k] = v;
  }
  return { sync, local };
}

/** Прочитать все настройки (с дефолтами). */
export async function getSettings(): Promise<Settings> {
  const { sync, local } = splitDefaults();
  const [s, l] = await Promise.all([
    browser.storage.sync.get(sync),
    browser.storage.local.get(local),
  ]);
  return { ...DEFAULT_SETTINGS, ...(s as object), ...(l as object) } as Settings;
}

/** Прочитать одну настройку. */
export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  const area = isLocal(key) ? browser.storage.local : browser.storage.sync;
  const res = await area.get({ [key]: DEFAULT_SETTINGS[key] });
  return (res as Settings)[key];
}

/** Записать частичный патч настроек (секреты автоматически уйдут в local). */
export async function setSettings(patch: Partial<Settings>): Promise<void> {
  const syncPatch: Record<string, unknown> = {};
  const localPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    (isLocal(k) ? localPatch : syncPatch)[k] = v;
  }
  const ops: Promise<void>[] = [];
  if (Object.keys(syncPatch).length) ops.push(browser.storage.sync.set(syncPatch));
  if (Object.keys(localPatch).length) ops.push(browser.storage.local.set(localPatch));
  await Promise.all(ops);
  log.debug("settings", "saved", Object.keys(patch));
}

export type SettingsChangeHandler = (changed: Partial<Settings>) => void;

/**
 * Подписка на изменения настроек (из любой области и любого контекста).
 * Возвращает функцию отписки.
 */
export function onSettingsChanged(handler: SettingsChangeHandler): () => void {
  const listener = (
    changes: Record<string, { newValue?: unknown }>,
    area: string,
  ) => {
    if (area !== "sync" && area !== "local") return;
    const patch: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(changes)) {
      if (k in DEFAULT_SETTINGS) patch[k] = c.newValue;
    }
    if (Object.keys(patch).length) handler(patch as Partial<Settings>);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
