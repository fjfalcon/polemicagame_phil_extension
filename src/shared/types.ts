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
  /** Панель «Мой вечер»: игры сессии с ролью и ±MMR. */
  session_stats_enabled: boolean;
  /** График «Путь MMR» на своём профиле. */
  profile_mmr_chart_enabled: boolean;
  /** Автозапись игр в OBS: вход в комнату — StartRecord, выход — StopRecord. */
  obs_auto_record_enabled: boolean;
  /** «Клип момента»: SaveReplayBuffer по клавише/кнопке. */
  obs_clip_enabled: boolean;
  obs_clip_hotkey_code: string;
  /** Длина буфера повторов, минут. */
  obs_clip_minutes: number;
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
  /** Жёлтая точка на кнопке заметки: «у этого игрока есть заметка». */
  note_indicator_enabled: boolean;
  /** Квадратик-метка роли у игрока (мой read, сбрасывается за игру). */
  role_marker_enabled: boolean;
  /** В метке — иконка роли из спрайта сайта; false — прежние «Мир/Шер/Дон». */
  role_marker_icons_enabled: boolean;
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
  /** Клик по номеру игрока переключает ник (иначе клик остаётся сайту). */
  nick_click_toggle_enabled: boolean;
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
  /** Чат на всех страницах сайта (поиск, лобби, профиль), не только в игре. */
  twitch_chat_everywhere: boolean;
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
  command:
    | "connect"
    | "disconnect"
    | "get_status"
    | "set_scene"
    | "get_scenes"
    | "record_start"
    | "record_stop"
    | "replay_save"
    | "replay_setup";
  data?: {
    url?: string;
    password?: string;
    sceneName?: string;
    /** replay_setup: длина буфера повторов в секундах. */
    seconds?: number;
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

/**
 * Правки ПАЛИТРЫ через тот же координатор — ИНТЕНТОМ, а не снимком.
 *
 * Раньше вкладка читала палитру, доливала свой цвет и писала массив целиком.
 * Окно гонки было маленьким, но не нулевым: две вкладки, добавившие разные
 * цвета одновременно, читали один и тот же диск и вторая затирала первый
 * (внешний аудит 28.08.2026). Заметки этот класс гонки прошли ещё 26.08 —
 * палитра осталась на старой модели согласованности.
 */
export interface NotesTagOpsMsg {
  type: "notes_tag_ops";
  /** Цвета, которые надо ДОБАВИТЬ в палитру. */
  add?: string[];
  /** Цвета, которые надо УБРАТЬ. */
  remove?: string[];
}

/** Ответ координатора на правку палитры: свежий список для синхронизации UI. */
export interface NotesTagsResultMsg {
  ok: boolean;
  tags?: string[];
  /** «read_failed» — свежее состояние не прочиталось, писать отказались. */
  reason?: string;
}

/** Слить карту заметок (импорт бэкапа) через тот же координатор. */
export interface NotesMergeMsg {
  type: "notes_merge";
  incoming: Record<string, unknown>;
  /** Предел замен, одобренный пользователем в диалоге; больше — координатор
   *  обязан отказать consent_exceeded, а не писать (ревью 26.08.2026). */
  approvedReplaced?: number;
}

/** Ответ координатора: ok=false — писать НЕ удалось (UI обязан сказать). */
export interface NotesResultMsg {
  ok: boolean;
  /**
   * Счётчики ОБЯЗАТЕЛЬНЫ при ok:true (ревью 27.08.2026): «успех» без них
   * снова означал бы «сохранено» поверх молча обрезанного текста. Для
   * ok:false остаются необязательными — там нечего было применять.
   */
  /** Почему отказ. read_failed — писать нельзя, фолбэк запрещён;
   *  consent_exceeded — замен больше одобренного, нужен новый вопрос. */
  reason?: "read_failed" | "consent_exceeded" | "bad_request";
  notes?: Record<string, unknown>;
  added?: number;
  replaced?: number;
  /** Сколько записей обрезано/выброшено при нормализации (ревью 27.08.2026). */
  truncated?: number;
  skipped?: number;
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

/** Фон спрашивает вкладку: «ты сейчас в игровой комнате?» (автозапись OBS). */
export interface ObsRoomProbeMsg {
  type: "obs_room_probe";
}

/**
 * Попап меняет ПАРУ «адрес + пароль» OBS одной транзакцией (ревью
 * 27.08.2026): они живут в разных областях хранилища (host — sync, пароль —
 * local), события приходят порознь, и любой таймер-склейкой это не лечится —
 * пользователь дописывает пароль СЕКУНДЫ спустя. Сообщение несёт обе части
 * сразу, фон применяет их атомарно.
 */
export interface ObsEndpointMsg {
  type: "obs_endpoint_set";
  host: string;
  /** Не передан — пароль НЕ трогаем (в бэкапе его нет никогда). */
  password?: string;
}

/** Контент/попап просят фон выполнить разовую миграцию заметок sync→local
 *  (SEC26-5: запись миграции — только сериализованный координатор). */
export interface NotesMigrateMsg {
  type: "notes_migrate";
}

/** Попап собирается выгружать лог: вкладки дописывают хвост на диск. */
export interface WsLogFlushMsg {
  type: "ws_log_flush";
}

/** Попап очистил полный лог: контент-контексты сбрасывают свой буфер/учёт. */
export interface WsLogResetMsg {
  type: "ws_log_reset";
}

/** Попап спрашивает вкладку её состояние для диагностического снимка. */
export interface DiagStateMsg {
  type: "diag_state";
}

export type ExtMessage =
  | ObsCommandMsg
  | ObsRoomProbeMsg
  | DiagStateMsg
  | NotesMigrateMsg
  | ObsEndpointMsg
  | WsLogResetMsg
  | WsLogFlushMsg
  | ObsEventMsg
  | UpdateNotesSettingsMsg
  | TwitchControlMsg
  | TwitchStatusMsg
  | GetNicknameLengthsMsg
  | OpenNickColorsMsg
  | GetContentVersionMsg
  | ObsSceneOwnerPingMsg
  | NotesApplyOpsMsg
  | NotesTagOpsMsg
  | NotesMergeMsg
  | StartSearchMsg
  | StopSearchMsg
  | QueueGuardMsg
  | QueueGuardPingMsg
  | PostgameLiveQueryMsg
  | PostgameLiveProbeMsg;
