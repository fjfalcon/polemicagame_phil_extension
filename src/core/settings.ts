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
  extension_enabled: true,
  show_mmr: true,
  show_games: true,
  show_id: false,
  show_winrate: true,
  show_kills: true,
  show_roles: true,
  statistics_enabled: true,
  match_page_stats_enabled: true,
  match_stats_view: "hints",
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
  player_mute_enabled: true,
  nick_colors_enabled: true,
  // "thick" (3px) — вид, каким рамки были всегда; тонкие/средние — по вкусу.
  note_frame_width: "thick",
  btn_stats_enabled: true,
  btn_note_enabled: true,
  btn_last_games_enabled: true,
  btn_hide_video_enabled: true,
  // Выключено по умолчанию (8.1.43, решение владельца): метка «мой read» —
  // нишевая фича, новичку она мешает. Уже включившим её пользователям
  // значение из storage сохранит прежнее поведение.
  role_marker_enabled: false,
  f5_refresh_fix_enabled: true,
  hotkey_role_fake: "KeyF",
  hotkey_role_reset: "KeyE",
  hotkey_role_hide: "KeyD",
  update_check_enabled: true,
  debug_logging_enabled: true,
  connection_diag_enabled: false,
  queue_background_warning_enabled: true,
  // Выключено по умолчанию: фича заходит в реальную очередь, включать её
  // должен осознанно сам игрок.
  queue_peek_enabled: false,
  // Автозаход рискованнее ручного (игрока может не быть у экрана), поэтому
  // отдельная галочка и тоже выключено по умолчанию.
  queue_peek_auto: false,
  // Выключено по умолчанию (решение владельца, 31.07.2026): фича совершает
  // действие за игрока (ставит в очередь) — включать её должен он сам,
  // осознанно. Тот же принцип, что у queue_peek_enabled.
  requeue_after_lobby_fail_enabled: false,
  // Включено по умолчанию — в отличие от requeue: там автоматика стартует
  // сама по событиям сайта, здесь ВСЯ цепочка действий — продолжение явного
  // клика игрока по кнопке с прямой подписью, согласие даётся каждым нажатием.
  postgame_requeue_enabled: true,
  // Пропуск модалки включён по умолчанию: ради пропуска этих окон кнопка и
  // делалась. Кому нужен чекпойнт сайта — выключает и подтверждает сам.
  postgame_skip_confirm_enabled: true,
  queue_peek_standard: true,
  queue_peek_polite: true,
  queue_peek_prime: true,
  obs_enabled: false,
  obs_host: "ws://localhost:4455",
  obs_password: "",
  obs_floating_panel_enabled: false,
  obs_auto_mode_enabled: false,
  obs_day_scene: "",
  obs_night_scene: "",
  twitch_chat_enabled: false,
  twitch_channel_name: "",
  // true: настройка теперь реально гейтит показ панели (раньше не читалась
  // никем); true сохраняет прежнее поведение «панель появляется сама».
  twitch_floating_panel_enabled: true,
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
  return res[key] as Settings[K];
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
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    area: string,
  ) => {
    if (area !== "sync" && area !== "local") return;
    const patch: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(changes)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      // Firefox присылает ВСЕ ключи области после set() и может вызвать
      // слушателя, когда данные не менялись (MDN, Bug 1621162). Без сверки
      // old/new «неизменившийся» obs_enabled: true читался как намеренное
      // включение и отменял ручное отключение OBS (аудит lifecycle
      // 01.08.2026, находка 5).
      const next =
        c.newValue === undefined
          ? // Ключ удалён — это возврат к ДЕФОЛТУ, а не undefined в рантайме
            // (иначе фича с дефолтом true молча выключалась до перезагрузки;
            // находка 18).
            DEFAULT_SETTINGS[k as SettingKey]
          : c.newValue;
      const prev = c.oldValue === undefined ? DEFAULT_SETTINGS[k as SettingKey] : c.oldValue;
      if (Object.is(prev, next)) continue;
      patch[k] = next;
    }
    if (Object.keys(patch).length) handler(patch as Partial<Settings>);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
