/**
 * Все привязки к разметке сайта в одном месте.
 * При редизайне polemicagame.com правится ТОЛЬКО этот файл.
 * Фикстуры для проверки: tests/fixtures/*.json
 */

/** CSS-селекторы элементов сайта. */
export const SITE = {
  // Игроки и их панели
  player: ".player",
  playerDesktop:
    ".player.desktop-version:not(.judge-player), .player.desktop-version.hidden:not(.judge-player)",
  playerInfo: ".player__info",
  playerName: ".player__info .info__name",
  /**
   * Номер игрока в плашке (компонент PlayerNumber): `player-number player-N`,
   * где N — id (0-based), текстом рисуется N+1. Служит «ручкой гармошки» в
   * compact-nicks: по нему сворачиваем и разворачиваем ник.
   */
  playerNumber: ".player-number",
  /**
   * Контейнер плашки и наших иконок игрока: `.player__botleftmenu` — сайт
   * позиционирует его absolute в левом нижнем углу плитки (left/bottom
   * .625rem, сверено с room/bundle/style.css). Двигать плашку по углам надо
   * именно им: сама `.player__info` лежит ВНУТРИ него, и её собственный
   * absolute считался бы от контейнера, а не от плитки.
   */
  plateContainer: ".player__botleftmenu",
  /**
   * Верхние углы плитки, занятые кнопками САЙТА: слева — готовность и роль,
   * справа — фолы и меню «…». Нужны, чтобы понять, надо ли отодвигать нашу
   * плашку вниз: в лобби до готовности левый угол пуст, и отступ выглядит
   * как «плашка зависла посередине» (жалоба 08.08.2026).
   */
  topLeftMenu: ".player__topleftmenu",
  topRightMenu: ".player__toprightmenu",
  playerVideoWrapper: ".player__video-wrapper",
  playerVideo: ".player__video, .player__video-wrapper",
  playerVideoEl: "video.player__video",
  /** МЁРТВЫЙ по текущей разметке (аудит 01.08.2026): у меню сайта классы
   *  только `active`/`in-streamer-mode`. Потребитель (role-faker) при
   *  отсутствии узла просто ничего не делает — оставлен как безопасный
   *  фолбэк до правки самой фичи. */
  playerMenuWithRole: ".player__menu.with-role",
  // Роли (SVG-спрайты)
  roleUse: "use[href], use[xlink\\:href]",
  /** МЁРТВЫЙ по текущей разметке: роли берутся из внешнего SVG-спрайта,
   *  инлайновых <symbol> на странице нет. Потребители деградируют молча. */
  roleSymbols: "symbol#civilian, symbol#sheriff, symbol#mafia, symbol#godfather",
  myRole: ".player__role.role.role.my-role",
  anyRole: ".player__role.role.role",
  // Свои роли — все варианты разметки для скрытия/показа (auto-start)
  // Сверено с бандлом (аудит устойчивости 01.08.2026): класс my-role стоит
  // НА САМОМ элементе роли, отдельного предка .my-role сайт не создаёт —
  // варианты с ним были мёртвыми.
  ownRoleTargets: [
    ".player__role.role.role.my-role",
    ".my-player .player__role.role.role",
    ".my-player .player__role.my-role",
  ] as readonly string[],
  // Стадии игры (день/ночь/голосование)
  stage: ".stage, .substage",
  substageCurrent: ".substage.current",
  /** МЁРТВЫЙ: сайт рендерит подстадии только как current/next/temp. */
  substageActive: ".substage.active",
  substageNext: ".substage.next",
  // Автопринятие игры на странице поиска (auto-start)
  acceptGameDivPrimary:
    '.p-play__profile-accept.cursor-pointer, .p-play__profile-game.p-play__profile-accept, .p-play-profile__wr div[class*="cursor-pointer"]',
  acceptGameWrapperDiv: ".p-play-profile__wr div",
  cursorPointerDiv: "div.cursor-pointer",
  // ── комната до старта игры: развал лобби (queue-requeue, этап 2) ──
  /**
   * Экран «Идет набор игроков»: роллер рисует его РОВНО при
   * `gameView.stage.type === "voting_for_game_start"`. Значит его присутствие —
   * доказательство, что матч ещё НЕ начался.
   */
  pregameScreen: ".new-stage",
  /**
   * Признаки ИДУЩЕГО матча внутри `.stage`. Проверять сам `.stage` нельзя:
   * роллер рисует эту ветку всегда, когда стадия не «набор игроков» — в том
   * числе СРАЗУ ПОСЛЕ ЗАГРУЗКИ комнаты, пока состояние игры ещё не пришло по
   * сокету. Тогда узел пустой (внутри — пустой `.substages`), и матча за ним
   * нет (жалоба 01.08.2026: автовозврат не срабатывал в комнате НИКОГДА).
   */
  runningStageMarkers: ".stage .stage__name, .stage .time-of-day, .stage .substage",
  /**
   * Пауза, промах мафии и итог игры рисуются ВМЕСТО роллера
   * (`fixedState` → RollerFixedState), поэтому там нет ни `.stage`, ни
   * `.new-stage`. Все три состояния бывают только ПОСЛЕ старта матча — значит
   * этот экран сам по себе доказывает, что игра идёт (ревью 02.08.2026).
   */
  roomFixedState: ".roller .ended",
  /**
   * Матч ЗАВЕРШЁН — только победа одной из сторон. Тем же блоком `.ended` сайт
   * рисует паузу и промах мафии, а это середина ЖИВОЙ игры (contClasses:
   * ended-mafia / ended-civilian / ended-pause / ended-mafia-missed). Классы
   * держим в SITE, чтобы их сторожил контрактный тест по живым бандлам.
   */
  roomMatchEnded: ".ended.ended-mafia, .ended.ended-civilian",
  /** Обратный отсчёт роспуска: «Игра будет распущена через MM:SS». */
  disbandmentTimer: ".disbandment-timer",
  /** Отметка «Готов» на СВОЕЙ плитке (player__topleftmenu). */
  myReadinessMark: ".player.my-player .player__readiness",
  /** Мой ник за столом: единственный след «кто я» на странице комнаты. */
  myPlayerName: ".player.my-player .info__name",
  /**
   * Игра окончена ДЛЯ МЕНЯ: моя плитка помечена выбытием. Классы сайт
   * вычисляет напрямую из состояния игрока (`notTransparentStateClasses`):
   * state-killed ⇔ isKilled && !votedBy (ночной отстрел),
   * state-voted ⇔ isKilled && votedBy (заголосован),
   * state-disqualified ⇔ isDisqualified.
   * Нужны потому, что выбывшего сайт НЕ уводит из комнаты и НЕ переводит в
   * `?role=viewer` — он просто сидит мёртвым до конца матча (жалоба
   * 07.08.2026: «меня заголосовали — кнопки в новую игру нет»).
   */
  myEliminatedState:
    ".player.my-player .state.state-killed, .player.my-player .state.state-voted, .player.my-player .state.state-disqualified",
  /**
   * Кнопка готовности в игровых контролах. Это ControlsButton
   * (`div.button.preset-1.<size>`) с подписью «Готов» и классом `active`,
   * когда игрок УЖЕ нажал (`:class="{active: votingForGameStart.voted}"`).
   * Иконку как признак использовать нельзя: сайт отдаёт svg по хешу без имени
   * файла (см. CAMERA_ICON_HASHES в auto-start).
   */
  readyButton: ".controls .button",
  /**
   * Центральная зона ряда контролов: сюда UserControls рисует кнопки
   * доступных действий, и там почти всегда РОВНО ОДНА кнопка — своя речь
   * подменяется выкриком на том же месте (см. controls-safety).
   */
  controlsCenter: ".controls .center",
  /** Кнопка контролов (у всех один класс — различаем по подписи). */
  controlsButton: ".button",
  readyButtonActiveClass: "active",
  /** Экран смерти комнаты: ссылка на поиск. */
  roomDeadLink: ".error a[href='/game-search']",
  /** «Попробовать снова» — это ошибка СВЯЗИ, комната может быть жива. */
  roomRetryButton: ".error a.error__main-buttons-item:not([href])",
  /**
   * ВСЕ главные кнопки экрана ошибки комнаты. Нужны целиком: ссылка на поиск
   * сама по себе развала НЕ доказывает — экран исключения (`on_self_strike`,
   * kicked) рисует home+search, и клик по search вернул бы исключённого
   * игрока в очередь (аудит автовозврата 03.08.2026, RQ-5). Развал сайт
   * рисует ЕДИНСТВЕННОЙ кнопкой-ссылкой на /game-search (`on_stop_game`).
   */
  roomErrorButtons: ".error a.error__main-buttons-item",
  // Игровая страница: стартовый экран, лобби, веб-камера (auto-start)
  welcomeModal: ".common-room-modal",
  lobbyStageName: ".new-stage__name",
  invitationLink: ".invitation-link",
  /**
   * Секундомер идущего поиска — единственный надёжный признак «игрок в
   * очереди». Гейт именно по нему: класс `--search` сайт вешает и на
   * скелетон загрузки кнопки, где очереди ещё нет. Общий для queue-guard и
   * queue-peek, чтобы при смене разметки чинить одно место.
   */
  searchInProgress: ".p-play__profile-game--search .p-play__profile-game-search-time",
  /** Блок с галочками очередей и кнопкой «Играть» — якорь для наших кнопок. */
  searchPanel: ".p-play__profile-panel",
  /** Обёртка кнопки «Играть» внутри панели: вставляемся сразу после неё. */
  searchPlayWrap: ".p-play-profile__wr",
  /**
   * Ссылка на СВОЙ профиль в шапке сайта — единственный способ узнать свой
   * userId из разметки (сайт держит его в состоянии Vue, а у изолированного
   * мира своего доступа туда нет). В игровой комнате шапки нет, поэтому
   * прочитанное значение кэшируется (см. core/own-user).
   */
  ownProfileLink: '.p-header__userCont-dropdown a[href^="/profile/"], .p-header__userCont a[href^="/profile/"]',
  webcamButton: "div.button.preset-1.small.desktop-version",
  webcamButtonOffClass: "off",
  // Меню «показать/скрыть роли» (auto-start)
  roleMenuClickable: 'button, [role="button"], li, a, span, div',
  // Профиль / поиск игры
  // (profileImg/profileAvatar/profileAvatarIcons удалены вместе с мёртвой фичей аватара)
  /**
   * Игра уже собрана: блок с таймером и «Принять игру» → «Готовы: N/10».
   * В шаблоне сайта это ветка `searchState.group` внутри `.p-play-profile__wr`,
   * то есть секундомера поиска в этот момент на странице НЕТ.
   */
  profileAccept: ".p-play__profile-accept",
  profileSearchButton: ".p-play__profile-button",
  profileSearchClose: ".p-play__profile-game-search-close",
  // ── «В поиск» после конца игры / смерти игрока (postgame-search) ──
  /**
   * Блок «Продолжить игру / Покинуть игру» на странице поиска: сервер ещё
   * считает игрока в игре (`userInGame`), кнопки «Играть» в этот момент в
   * DOM НЕТ вообще (ветки шаблона взаимоисключающие). Убитого/заголосованного
   * игрока сайт сам уводит в режим зрителя (`on_self_strike` →
   * location="/game?role=viewer&game_id=…"), но из игры НЕ выписывает —
   * поэтому перед новым поиском обязателен выход через этот блок.
   */
  searchDecideBlock: ".p-play__profile-game--decide",
  /**
   * «Покинуть игру» — только ВНУТРИ решающего блока (гейт по контейнеру,
   * §4 п.2). Клик по ней НЕ выходит из игры: `quitGame(false)` лишь открывает
   * модалку подтверждения (сверено с бандлом game-search 07.08.2026).
   */
  searchQuitButton: ".p-play__profile-game--decide .p-play__profile-quit",
  /**
   * Модалка подтверждения выхода (ConfirmQuitGameModal). Её главная кнопка
   * зовёт `quitGame(true)` → POST /api/games/quit → userInGame сбрасывается.
   * Ban-проп модалки на странице поиска НЕ передаётся (всегда нейтральный
   * текст без угрозы бана) — сверено с единственным местом использования.
   */
  confirmQuitModal: ".confirmQuit",
  confirmQuitButton: ".confirmQuit .confirmQuit__content-btn",
  /**
   * ВТОРОЙ путь выхода — модалка «Вы уже играете» (`modal-game-in-progress`,
   * bundle/main.js). Сайт показывает её, когда игрок нажал «Играть», сервер
   * ответил illegalState=in_game, а режим разрешает искать из игры
   * (`inGameUsersAllowed`): «Вернуться в игру» / «Завершить последнюю игру»
   * (второе шлёт socket quit_game). Без её обработки машина видела чужую
   * модалку и сдавалась (жалоба владельца 07.08.2026).
   */
  inProgressModal: ".modal-game-in-progress",
  /** Кнопки внутри неё; какая именно — решает точный текст (§4 п.2). */
  inProgressButtons: ".modal-game-in-progress .modal-game-in-progress__body button",
  /**
   * Предупреждение о блокировке в этой же модалке (`isWarning`): «Если вы
   * досрочно покинете игру … вы получите автоматическую блокировку». На
   * странице поиска сайт его не передаёт, но появись оно — автоклик за
   * игрока недопустим: ценой ошибки будет бан.
   */
  inProgressWarning: ".modal-game-in-progress .modal-game-in-progress__header p",
  /**
   * Лоадер на месте кнопки «Играть» (`isSearchBtnLoading`). Важен для
   * самолечения postgame-search: в ветке illegalState=in_game сайт НЕ
   * сбрасывает searchBtnLoading, и после выхода из игры лоадер остаётся
   * навсегда — кнопка «Играть» не рендерится до F5 (лог 07.08.2026, 18:29).
   */
  searchButtonLoader: ".p-play__profile-game-loader-gradient",
  // Кнопки / меню
  settingsButton: "div.button.preset-1.small.desktop-version",
  // OBS-панель: детекция активного игрового интерфейса и стадий
  obsGameControls:
    ".button.preset-1.small.desktop-version, .game-room__settings, .player__role.role.role",
  endedTitle: ".ended__title",
  // Пост-игровая статистика
  statsTable: ".game-stats-table .table",
  statsTableRoot: ".game-stats-table",
  statsHeader: ".game-stats-header",
  statsRow: ".row",
  statsCellTitle: ".cell.title",
  /** Ячейка с ником игрока в таблице разбора — якорь ссылки на профиль. */
  statsUsernameCell: ".cell.username",
  penaltyDots: ".penalty-dots",
  penaltyDot: ".penalty-dot",
  bestMoveDot: ".best-move-dot",
} as const;

/** Текстовые маркеры (сайт двуязычный). Используются для поиска кнопок/фаз по тексту. */
export const TEXT = {
  /**
   * Подписи кнопок игровых контролов (RU + EN, сверено с живыми
   * room/bundle/locales/RU.js и EN.js 09.08.2026):
   *   speech_player_finish «Завершите речь» / «End the speech»
   *   send_guess «Оставить ЛХ» / «Make a guess»
   *   cancel_guess «Сбросить ЛХ» / «Reset guess»
   * Классы у кнопок одинаковые, отличить их можно только подписью — за
   * переименованием следит контрактная проба.
   */
  finishSpeechButton: ["завершите речь", "end the speech"] as readonly string[],
  outcryButton: ["выкрикнуть", "outcry"] as readonly string[],
  guessButtons: [
    "оставить лх",
    "сбросить лх",
    "make a guess",
    "reset guess",
  ] as readonly string[],
  // Сверено с room/bundle/locales/RU.js (31.07.2026): ночные этапы —
  // card_distribution «Раздача карт», familiarity_with_mafia «Знакомство
  // мафии», first_night «Первая ночь», night «Ночь», mafia_acts «Ход мафии»
  // ИЛИ «Голосование мафии» (два словаря!), checks «Проверки», doctor_acts
  // «Ход доктора»; дневные — morning «Утро», day «День», discussion «Речь
  // игрока», voting «Голосование/Начало голосования», voting_summary «Итоги
  // голосования», extra_speeches «Доп. речь», farewell_minute «Прощальная
  // минута».
  night: [
    "ночь",
    "ноч",
    "раздача карт",
    "ход мафии",
    "знакомство мафии",
    // «Голосование мафии», любые будущие «… мафии» (конфликт с дневным
    // «голос» решает DAY_STRONG-приоритет в auto-start).
    "мафи",
    "проверк",
    // «Ход доктора»
    "доктор",
    // «Аукцион» — ночная стадия в самом бандле:
    // case "night": case "auction": case "card_distribution": e="night"
    "аукцион",
    "auction",
    "night",
    "card deal",
    // Живая EN-локаль: card_distribution:"Card distribution" — без этого
    // маркера классификатор давал null (аудит хрупкости 06.08.2026).
    "card distribution",
    "dealing",
    "mafia",
    "doctor",
    "check",
    // best-effort, не проверено на живом EN-интерфейсе
    "mafia turn",
    "mafia introduction",
    "checks",
  ],
  day: [
    "день",
    // «Утро» — этап сводки ночи (промах/убийство); без него после промаха
    // фаза «залипала» в ночи и роли не скрывались (жалоба 31.07.2026).
    "утро",
    "голос",
    "итоги",
    "речь игрока",
    "доп. речь",
    "прощальная",
    // «Промах» — реальный текст (mafia_miss), живёт на .ended-экране.
    // «Лучший ход» НЕ добавлен: в локали это подсказка (guess_tooltip), а не
    // название этапа — маркер был бы мёртвым (ревью аудита устойчивости).
    "промах",
    "day",
    "morning",
    "vote",
    "voting",
    "results",
    "player's speech",
    "player speech",
    "speech",
    // Живая EN-локаль пишет discussion:"Player's speach" — С ОПЕЧАТКОЙ (sic).
    // Правильное "speech" её не ловило, и день на EN давал null
    // (аудит хрупкости 06.08.2026). Если сайт исправит опечатку, маркер
    // станет мёртвым, но безвредным — "speech" выше подхватит.
    "speach",
    "additional speech",
    "farewell",
    // best-effort, не проверено на живом EN-интерфейсе
    "best move",
    "miss",
  ],
  /**
   * Сильные дневные маркеры — побеждают при конфликте день+ночь в ОДНОМ
   * тексте (см. classifyPhaseText). Слабое «голос» конфликт не решает:
   * оно есть и в ночном «Голосование мафии».
   */
  dayStrong: [
    "день",
    "утро",
    "речь игрока",
    "итоги",
    "доп. речь",
    "прощальная",
    "day",
    "morning",
    "speech",
    "results",
    "farewell",
  ],
  // Кнопки приёма игры на странице поиска (auto-start, RU+EN)
  acceptGameButton: [
    "готов",
    "подтвердить",
    "начать игру",
    "принять игру",
    "ready",
    "confirm",
    "start playing",
  ],
  // Текст «Принять игру» (точечный маркер div-ов приёма)
  acceptGameText: ["принять игру", "start playing"],
  // Приветственное окно / кнопка «НАЧАТЬ ИГРУ» (auto-start)
  welcome: ["добро пожаловать", "welcome", "режим зрителя"],
  // «Начать просмотр» — кнопка того же .common-room-modal у ЗРИТЕЛЯ
  // (viewer_mode/start_watching в локали): без неё «пропустить стартовый
  // экран» молча не работало зрителям (аудит устойчивости, находка 7).
  startGameButton: ["начать игру", "start playing", "начать просмотр", "start watching"],
  // Пункты меню «показать/скрыть роли» (auto-start, day/night switch)
  showRoles: ["показать роли", "show roles"],
  hideRoles: ["скрыть роли", "hide roles"],
  /**
   * Подпись кнопки готовности в комнате до старта игры. Она ОДНА И ТА ЖЕ в
   * обоих состояниях (start_game_readiness_button_ready и _not_ready — оба
   * «Готов»/«Ready»), поэтому текст опознаёт кнопку, а нажата ли готовность —
   * говорит класс `active` (SITE.readyButtonActiveClass).
   */
  readyButton: ["готов", "ready"],
  /**
   * Шаги выхода из игры на странице поиска (postgame-search). Строки зашиты
   * в шаблон бандла game-search ПО-РУССКИ (страница поиска не локализуется,
   * сверено 07.08.2026) — английских вариантов не существует, добавлять их
   * значило бы матчить то, чего нет.
   */
  quitGameButton: ["покинуть игру"],
  confirmQuitButton: ["покинуть лобби"],
  /** Кнопка выхода в модалке «Вы уже играете» (второй путь). */
  finishLastGameButton: ["завершить последнюю игру"],
  /** Слово-маркер предупреждения о бане в той же модалке (см. inProgressWarning). */
  banWarningMarker: ["блокировк"],
} as const;

/** CSS-классы/идентификаторы, создаваемые САМИМ расширением (наши, не сайта). */
export const OWN = {
  statsButton: "stats-button",
  noteButton: "note-button",
  lastGamesButton: "last-games-button",
  /** Кнопка «пересечения» — префикс обязателен: голые имена уже кусались. */
  crossoverButton: "pn-crossover-button",
  hideVideoButton: "hide-video-button",
  rotateButton: "rotate-button",
  muteButton: "mute-button",
  roleHideStyle: "polemica-role-hide",
  /** Контейнер для иконок, добавляемых к игроку. */
  playerIcons: "player-icons",
  /** Контейнер инлайновой статистики игрока. */
  playerStats: "player-stats",
  /** Тултип со статистикой. */
  /** Тултип статистики. ПРЕФИКС ОБЯЗАТЕЛЕН: голый `tooltip` — живой класс
   *  САЙТА (room/game-search/profile), и наш глобальный cleanup сносил его
   *  Vue-тултипы (аудит устойчивости 01.08.2026, находка 1). */
  tooltip: "pn-tooltip",
  /** <style> с правилами страницы матча, создаётся фичей. */
  matchPageStyle: "polemica-match-page-style",
} as const;

/** Все классы наших элементов, которые надо удалять при выключении фичи. */
export const OWN_BUTTON_SELECTOR =
  ".stats-button, .note-button, .last-games-button, .pn-crossover-button, " +
  ".hide-video-button, .rotate-button, .mute-button";

/** Матч маркера фазы в тексте этапа (для classifyPhaseText и спецслучаев). */
export function hasPhaseMarker(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => {
    // Короткие английские слова — только по границам слова: «day» не должен
    // матчиться в «today», «miss» — в «dismiss». Латиница живёт в никах
    // игроков, которые могут попадать в текст стадии на русском интерфейсе.
    if (/^[a-z]+$/.test(marker) && marker.length <= 5) {
      return new RegExp(`(^|[^a-z])${marker}([^a-z]|$)`).test(text);
    }
    return text.includes(marker);
  });
}

/**
 * Классификация текста этапа игры в фазу день/ночь. Единая точка для
 * авто-скрытия ролей (auto-start) и автосцен OBS (obs-panel) — раньше у
 * каждого была своя, и «Голосование мафии» (ночной этап mafia_acts в одном
 * из двух словарей локали сайта; в другом — «Ход мафии») из-за слова «голос»
 * классифицировался как день посреди ночи.
 *
 * Правило конфликта (текст матчит оба списка): побеждает ночь, КРОМЕ
 * текстов с сильным дневным маркером (TEXT.dayStrong). Сегодня реальный
 * конфликтный текст один — «Ночь | Голосование мафии», и он ночной;
 * dayStrong — страховка на случай будущих дневных текстов с «мафи»/«доктор»
 * внутри (в substage сайт дописывает только номер игрока, не ник — ники в
 * конфликт не попадают).
 */
/**
 * Терминальный экран игры (победа/поражение/промах/пауза): `.ended`.
 *
 * Сайт перед `gameOver` явно вызывает `on_start_day`, но результат рисует НЕ
 * стадией, а отдельным блоком без фазовых маркеров — и наши фазы «залипали»
 * на ночи: OBS оставался на ночной сцене, а роль могла остаться показанной
 * на экране результата (аудит устойчивости 01.08.2026, находка 5).
 */
export const ENDED_SCREEN_SELECTOR = ".ended";

/** Виден ли терминальный экран игры (см. ENDED_SCREEN_SELECTOR). */
export function endedScreenVisible(): boolean {
  const el = document.querySelector<HTMLElement>(ENDED_SCREEN_SELECTOR);
  if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
  // ПАУЗА рисуется ТЕМ ЖЕ блоком (fixedState PAUSE → contClasses
  // "ended-pause"), но игра не закончилась и фаза не «день». Без этой
  // проверки ночная пауза — а с нашим же F8 они частые — уводила бы OBS на
  // дневную сцену и обратно (поймано ревью аудита устойчивости 01.08.2026).
  return !el.classList.contains("ended-pause");
}

/**
 * Матч ЗАВЕРШЁН (победа мафии или мирных), а не просто «фиксированный экран».
 *
 * Тем же блоком `.ended` сайт рисует ещё паузу и промах мафии — оба посреди
 * ЖИВОЙ игры (contClasses: ended-mafia / ended-civilian / ended-pause /
 * ended-mafia-missed). Отдельная проверка нужна там, где вопрос стоит «идёт ли
 * матч прямо сейчас» — например, ведёт ли эта вкладка автосцену OBS.
 */
export function matchFinishedVisible(): boolean {
  const el = document.querySelector<HTMLElement>(SITE.roomMatchEnded);
  return !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
}

export function classifyPhaseText(text: string): "day" | "night" | null {
  const day = hasPhaseMarker(text, TEXT.day);
  const night = hasPhaseMarker(text, TEXT.night);
  if (day && night) return hasPhaseMarker(text, TEXT.dayStrong) ? "day" : "night";
  if (day) return "day";
  if (night) return "night";
  return null;
}
