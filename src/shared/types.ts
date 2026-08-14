/** Тема кнопок статистики. */
export type StatsTheme = "default" | string;

/** Толщина рамки-метки: thin=1px, medium=2px, thick=3px (исторический вид). */
export type NoteFrameWidth = "thin" | "medium" | "thick";

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
  /** Цвет темы «своя» (#rrggbb). Работает, когда выбрана тема custom. */
  stats_button_color: string;
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
  /** Цветные ники игроков (цвет задаётся в заметке; палитра — как у рамок). */
  nick_colors_enabled: boolean;
  /** Толщина цветной рамки-метки вокруг камеры игрока. */
  note_frame_width: NoteFrameWidth;
  /** Кнопки на плитке игрока — можно убрать любую из ряда. */
  btn_stats_enabled: boolean;
  btn_note_enabled: boolean;
  btn_last_games_enabled: boolean;
  /** Кнопка «пересечения»: сколько игр сыграно с этим игроком и кем он был. */
  btn_crossover_enabled: boolean;
  btn_hide_video_enabled: boolean;
  /** Сколько последних игр показывать в окне истории: "4" или "8". */
  last_games_count: string;
  /** Отмечать в этом окне игры, где игрок был первым убитым («ПУ»). */
  last_games_first_killed: boolean;
  /** Квадратик-метка роли у игрока (мой read, сбрасывается за игру). */
  role_marker_enabled: boolean;
  /** Управлять раскладкой кнопок действий в игре. */
  safe_controls_layout_enabled: boolean;
  /** Позиция кнопки в центре ряда: left | center | right. */
  ctl_pos_finish: string;
  ctl_pos_outcry: string;
  ctl_pos_guess: string;
  /** Возвращать F5 нормальное обновление страницы (сайт перехватывает его под настройки). */
  f5_refresh_fix_enabled: boolean;
  /** Клавиша подмены роли (KeyboardEvent.code, дефолт KeyF). */
  hotkey_role_fake: string;
  /** Клавиша сброса роли (дефолт KeyE). */
  hotkey_role_reset: string;
  /** Клавиша скрытия/показа своей роли (дефолт KeyD). */
  hotkey_role_hide: string;
  /** Клавиша «показать роли, пока удерживается» (дефолт KeyV). */
  hotkey_role_peek: string;
  /** Выкрикнуть с клавиши. Выключено по умолчанию: действие расходуемое. */
  outcry_hotkey_enabled: boolean;
  /** Клавиша выкрика (дефолт KeyC). */
  outcry_hotkey_code: string;
  /** Писать клавишу прямо на кнопке: «Выкрикнуть (C)», «Пауза (F8)». */
  hotkey_hints_enabled: boolean;
  /** Кнопка «Перезагрузить камеры» в игре (видео пересоздаётся без F5). */
  camera_reload_enabled: boolean;
  /** Метка обрыва на камере игрока, чей видеопоток перестал приходить. */
  stream_lost_icon_enabled: boolean;
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
  /** Сразу смотреть состав очередей при открытии страницы поиска. */
  queue_peek_auto: boolean;
  /** Развалилось принятое лобби — автоматически снова встать в поиск. */
  requeue_after_lobby_fail_enabled: boolean;
  /** Кнопка «В поиск» после конца игры/смерти: выйти из игры и снова в очередь. */
  postgame_requeue_enabled: boolean;
  /** Писать полный лог кадров игрового сокета (без медиа и ключей сессии). */
  ws_full_log_enabled: boolean;
  /** Свернуть ники игроков «гармошкой» — видна только цифра. */
  compact_nicknames_enabled: boolean;
  /** Угол плитки для плашки игрока: default | top-left | top-right | bottom-right. */
  nick_plate_position: string;
  /** «В поиск»: подтверждать модалку «Покинуть лобби» автоматически.
   *  false — машина останавливается на модалке и ждёт клика игрока,
   *  после подтверждения продолжает сама (нажмёт «Играть»). */
  postgame_skip_confirm_enabled: boolean;
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
  data?: {
    url?: string;
    password?: string;
    sceneName?: string;
    /** true — сцену переключает САМ пользователь (клик в панели): такая
     *  команда всегда проходит и забирает владение автосценой этой вкладке. */
    manual?: boolean;
  };
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

/** popup → content (активная вкладка): открыть менеджер цветов ников. */
export interface OpenNickColorsMsg {
  type: "openNickColors";
}

/**
 * Точечная правка карты заметок: `record === null` — удалить ключ.
 * Пишет ВСЕГДА background (единственная очередь на браузер), поэтому две
 * вкладки больше не затирают правки друг друга целой картой.
 */
export interface NoteOp {
  key: string;
  record: unknown | null;
}

/** Применить точечные правки заметок через координатор в background. */
export interface NotesApplyOpsMsg {
  type: "notes_apply_ops";
  ops: NoteOp[];
}

/** Слить карту заметок (импорт бэкапа) через тот же координатор. */
export interface NotesMergeMsg {
  type: "notes_merge";
  incoming: Record<string, unknown>;
}

/** Ответ координатора: ok=false — писать НЕ удалось (UI обязан сказать). */
export interface NotesResultMsg {
  ok: boolean;
  /** Почему отказ. read_failed — писать нельзя, фолбэк запрещён. */
  reason?: "read_failed";
  notes?: Record<string, unknown>;
  added?: number;
  replaced?: number;
}

/**
 * popup → content: «какая версия расширения тебя запустила?»
 * После обновления открытая вкладка продолжает работать на СТАРОМ
 * content-скрипте (браузер не переинжектит его в уже загруженный документ),
 * и пользователь этого не видит (аудит lifecycle 01.08.2026, находка 3).
 */
export interface GetContentVersionMsg {
  type: "getContentVersion";
}

/**
 * background → вкладка: «автосцену OBS ведёшь сейчас ты?»
 *
 * Спрашиваем саму вкладку, а не браузер: `tabs.get` успешен и для выгруженной
 * вкладки, и для той, чей content-скрипт осиротел после обновления расширения,
 * а `tab.url` без разрешения `tabs` приходит только для страниц сайта. Молчание
 * в ответ = владение свободно (ревью 02.08.2026).
 */
export interface ObsSceneOwnerPingMsg {
  type: "obs_scene_owner_ping";
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

/** content(поиск) → background: идёт ли в другой вкладке ЖИВОЙ матч игрока?
 *  Сторож postgame-search: перед автокликом «Покинуть игру» машина обязана
 *  убедиться, что не выписывает игрока из идущей игры (viewer-вкладку с
 *  ?role=viewer сайт открывает и живому стримеру — stream window). */
export interface PostgameLiveQueryMsg {
  type: "postgame_live_query";
}

/** background → content(все вкладки игры): «твоя вкладка держит живой матч?» */
export interface PostgameLiveProbeMsg {
  type: "postgame_live_probe";
}

export type ExtMessage =
  | ObsCommandMsg
  | ObsEventMsg
  | UpdateNotesSettingsMsg
  | TwitchControlMsg
  | TwitchStatusMsg
  | GetNicknameLengthsMsg
  | OpenNickColorsMsg
  | GetContentVersionMsg
  | ObsSceneOwnerPingMsg
  | NotesApplyOpsMsg
  | NotesMergeMsg
  | StartSearchMsg
  | StopSearchMsg
  | QueueGuardMsg
  | QueueGuardPingMsg
  | PostgameLiveQueryMsg
  | PostgameLiveProbeMsg;
