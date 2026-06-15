/** Тема кнопок статистики. */
export type StatsTheme = "default" | string;

/** Полная схема пользовательских настроек расширения. */
export interface Settings {
  // Статистика игроков
  show_mmr: boolean;
  show_games: boolean;
  show_id: boolean;
  show_winrate: boolean;
  show_kills: boolean;
  show_roles: boolean;
  statistics_enabled: boolean;
  match_page_stats_enabled: boolean;
  stats_button_theme: StatsTheme;
  // Игровой процесс
  auto_accept_enabled: boolean;
  skip_start_screen_enabled: boolean;
  pause_hotkey_enabled: boolean;
  /** Физическая клавиша паузы (KeyboardEvent.code, напр. "F8", "KeyP"). */
  pause_hotkey_code: string;
  disable_webcam_clicks: boolean;
  enable_role_faker: boolean;
  auto_hide_roles_enabled: boolean;
  role_phase_auto_switch_enabled: boolean;
  /** Режим поворота камер: клик по игроку переворачивает его видео на 180°. */
  camera_rotate_enabled: boolean;
  // OBS
  obs_enabled: boolean;
  obs_host: string;
  /** Хранится в storage.local, НЕ синхронизируется в облако. */
  obs_password: string;
  obs_floating_panel_enabled: boolean;
  obs_auto_mode_enabled: boolean;
  obs_day_scene: string;
  obs_night_scene: string;
  // Twitch
  twitch_chat_enabled: boolean;
  twitch_channel_name: string;
  twitch_floating_panel_enabled: boolean;
}

export type SettingKey = keyof Settings;

/** Сцена OBS. */
export interface ObsScene {
  sceneName: string;
  sceneIndex?: number;
}

export interface ObsSceneData {
  scenes: ObsScene[];
  currentScene: string | null;
}

// ───────────────────────── Протокол сообщений ─────────────────────────
// Сохраняем поля `type`/`action`/`command` ради совместимости логики.

/** popup → background: команды OBS. */
export interface ObsCommandMsg {
  type: "obs_command";
  command: "connect" | "disconnect" | "get_status" | "set_scene" | "get_scenes";
  data?: { url?: string; password?: string; sceneName?: string };
}

/** background → popup/content: события OBS. */
export interface ObsEventMsg {
  type: "obs_event";
  eventType:
    | "obs_scenes_updated"
    | "obs_scene_changed"
    | "obs_disconnected"
    | "obs_connected";
  data?: unknown;
}

/** popup → content: обновления настроек/состояния. */
export interface UpdateNotesSettingsMsg {
  type: "updateNotesSettings";
  settings?: Partial<Settings>;
}
export interface UpdateRoleFakerMsg {
  type: "updateRoleFaker";
  enabled: boolean;
}
export interface UpdateAvatarMsg {
  type: "updateAvatar";
  avatarUrl: string | null;
}

/** popup → content: управление Twitch-панелью. */
export interface TwitchControlMsg {
  type:
    | "twitch_panel_show"
    | "twitch_panel_hide"
    | "twitch_panel_toggle"
    | "twitch_connect"
    | "twitch_disconnect";
  channel?: string;
}

/** popup → content: запрос длины ников (замена executeScript). */
export interface GetNicknameLengthsMsg {
  type: "getNicknameLengths";
}

/** content → background: автопринятие игры. */
export interface StartSearchMsg {
  action: "startSearch";
  players?: string;
  gameFound?: boolean;
}
export interface StopSearchMsg {
  action: "stopSearch";
}

export type ExtMessage =
  | ObsCommandMsg
  | ObsEventMsg
  | UpdateNotesSettingsMsg
  | UpdateRoleFakerMsg
  | UpdateAvatarMsg
  | TwitchControlMsg
  | GetNicknameLengthsMsg
  | StartSearchMsg
  | StopSearchMsg;
