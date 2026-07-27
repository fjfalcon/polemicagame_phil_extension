/** Тема кнопок статистики. */
export type StatsTheme = "default" | string;

/** Полная схема пользовательских настроек расширения. */
export interface Settings {
  /** Мастер-выключатель: false гасит ВСЕ функции расширения разом. */
  extension_enabled: boolean;
  // Статистика игроков
  show_mmr: boolean;
  show_games: boolean;
  show_id: boolean;
  show_winrate: boolean;
  show_kills: boolean;
  show_roles: boolean;
  statistics_enabled: boolean;
  match_page_stats_enabled: boolean;
  /** Вид страницы разбора матча: hints | legend | classic. */
  match_stats_view: string;
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
  /** Кнопка локального мьюта игрока (глушит его звук только у меня). */
  player_mute_enabled: boolean;
  /** Квадратик-метка роли у игрока (мой read, сбрасывается за игру). */
  role_marker_enabled: boolean;
  /** Возвращать F5 нормальное обновление страницы (сайт перехватывает его под настройки). */
  f5_refresh_fix_enabled: boolean;
  /** Клавиша подмены роли (KeyboardEvent.code, дефолт KeyF). */
  hotkey_role_fake: string;
  /** Клавиша сброса роли (дефолт KeyE). */
  hotkey_role_reset: string;
  /** Клавиша скрытия/показа своей роли (дефолт KeyD). */
  hotkey_role_hide: string;
  /** Проверять наличие новой версии на GitHub и показывать баннер. */
  update_check_enabled: boolean;
  /** Вести логи в storage.local для диагностики (выгружаются из popup). */
  debug_logging_enabled: boolean;
  /** Диагностика подключения очереди поиска (WS-события, дрейф таймеров). */
  connection_diag_enabled: boolean;
  /** Предупреждать, что свёрнутая вкладка вот-вот выпадет из очереди поиска. */
  queue_background_warning_enabled: boolean;
  /** Кнопка «Кто в очереди» на странице поиска (разведка состава очередей). */
  queue_peek_enabled: boolean;
  /** Какие очереди разрешено использовать для разведки. */
  queue_peek_standard: boolean;
  queue_peek_polite: boolean;
  queue_peek_prime: boolean;
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

/** Последнее подтверждённое background-состояние OBS. */
export interface ObsConnectionState extends ObsSceneData {
  connected: boolean;
  sessionId: string | null;
  timestamp: number;
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
// UpdateRoleFakerMsg и UpdateAvatarMsg удалены в 8.1.23:
// первый никто не слушал, у второго не существовало UI-отправителя.

/** popup → content: управление Twitch-панелью. */
export interface TwitchControlMsg {
  type:
    | "twitch_panel_show"
    | "twitch_panel_hide"
    | "twitch_panel_toggle"
    | "twitch_connect"
    | "twitch_disconnect"
    | "twitch_get_status";
  channel?: string;
}

/** content → popup: фактическое состояние Twitch IRC. */
export interface TwitchStatusMsg {
  type: "twitch_status";
  connected: boolean;
  channel: string;
  /** Человекочитаемая причина, когда подключение невозможно (пустой канал и т.п.). */
  error?: string;
}

/** popup → content: запрос длины ников (замена executeScript). */
export interface GetNicknameLengthsMsg {
  type: "getNicknameLengths";
}

/** content → background: автопринятие игры. */
export interface StartSearchMsg {
  action: "startSearch";
}
export interface StopSearchMsg {
  action: "stopSearch";
}

/** content → background: вкладка с активным поиском ушла в фон / вернулась. */
export interface QueueGuardMsg {
  action: "queueGuardArm" | "queueGuardCancel";
}

/** background → content: «ты ещё скрыт и всё ещё в очереди?» */
export interface QueueGuardPingMsg {
  action: "queueGuardPing";
}

export interface QueueGuardPingReply {
  hidden: boolean;
  searching: boolean;
}

export type ExtMessage =
  | ObsCommandMsg
  | ObsEventMsg
  | UpdateNotesSettingsMsg
  | TwitchControlMsg
  | TwitchStatusMsg
  | GetNicknameLengthsMsg
  | StartSearchMsg
  | StopSearchMsg
  | QueueGuardMsg
  | QueueGuardPingMsg;
