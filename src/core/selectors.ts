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
  playerIcons: ".player-icons",
  playerStats: ".player-stats",
  playerVideoWrapper: ".player__video-wrapper",
  playerVideo: ".player__video, .player__video-wrapper",
  playerVideoEl: "video.player__video",
  playerMenuWithRole: ".player__menu.with-role",
  // Роли (SVG-спрайты)
  roleUse: "use[href], use[xlink\\:href]",
  roleSymbols: "symbol#civilian, symbol#sheriff, symbol#mafia, symbol#godfather",
  myRole: ".player__role.role.role.my-role",
  anyRole: ".player__role.role.role",
  // Свои роли — все варианты разметки для скрытия/показа (auto-start)
  ownRoleTargets: [
    ".player__role.role.role.my-role",
    ".my-role .player__role.role.role",
    ".my-player .player__role.role.role",
    ".my-player .player__role.my-role",
    ".my-role .player__role.my-role",
  ] as readonly string[],
  // Стадии игры (день/ночь/голосование)
  stage: ".stage, .substage",
  substageCurrent: ".substage.current, .stage.current",
  substageActive: ".substage.active, .stage.active",
  substageNext: ".substage.next, .stage.next",
  // Автопринятие игры на странице поиска (auto-start)
  acceptGameDivPrimary:
    '.p-play__profile-accept.cursor-pointer, .p-play__profile-game.p-play__profile-accept, .p-play-profile__wr div[class*="cursor-pointer"]',
  acceptGameDivLoose: 'div.cursor-pointer, div[class*="accept"]',
  acceptGameWrapperDiv: ".p-play-profile__wr div",
  cursorPointerDiv: "div.cursor-pointer",
  // Игровая страница: стартовый экран, лобби, веб-камера (auto-start)
  welcomeModal: ".common-room-modal",
  lobbyStageName: ".new-stage__name",
  invitationLink: ".invitation-link",
  webcamButton: "div.button.preset-1.small.desktop-version",
  webcamButtonStartIcon: ".button.preset-1.small.desktop-version",
  webcamButtonOffClass: "off",
  // Меню «показать/скрыть роли» (auto-start)
  roleMenuClickable: 'button, [role="button"], li, a, span, div',
  // Профиль / поиск игры
  profileImg: ".p-play__profile-img",
  profileAvatar: ".avatarlvl__avatar",
  profileAvatarIcons: ".avatarlvl__icons",
  profileAccept: ".p-play__profile-accept",
  profileSearchButton: ".p-play__profile-button",
  profileSearchClose: ".p-play__profile-game-search-close",
  profileSearchPlayers: ".p-play__profile-game-search-players",
  // Кнопки / меню
  settingsButton: "div.button.preset-1.small.desktop-version",
  // OBS-панель: детекция активного игрового интерфейса и стадий
  obsGameControls:
    ".button.preset-1.small.desktop-version, .game-room__settings, .player__menu.with-role, .player__role.role.role",
  endedTitle: ".ended__title",
  // Пост-игровая статистика
  statsTable: ".game-stats-table .table",
  statsTableRoot: ".game-stats-table",
  statsHeader: ".game-stats-header",
  statsRow: ".row",
  statsCellTitle: ".cell.title",
  penaltyDots: ".penalty-dots",
  penaltyDot: ".penalty-dot",
  bestMoveDot: ".best-move-dot",
  bestMoveTooltip: ".best-move-tooltip",
} as const;

/** Текстовые маркеры (сайт двуязычный). Используются для поиска кнопок/фаз по тексту. */
export const TEXT = {
  accept: ["начать игру", "готов", "подтвердить", "принять", "старт", "join", "ready", "accept"],
  pause: ["пауза", "break", "перерыв"],
  night: [
    "ночь",
    "ноч",
    "раздача карт",
    "ход мафии",
    "знакомство мафии",
    "проверк",
    "night",
    "card deal",
    "dealing",
    "mafia",
    "check",
  ],
  day: [
    "день",
    "голос",
    "итоги",
    "речь игрока",
    "доп. речь",
    "прощальная",
    "day",
    "vote",
    "voting",
    "results",
    "player's speech",
    "player speech",
    "speech",
    "additional speech",
    "farewell",
  ],
  vote: ["голос", "vote"],
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
  // Режимы игры на карточке приёма
  gameMode: ["культурный", "обычный", "без цензуры"],
  // Приветственное окно / кнопка «НАЧАТЬ ИГРУ» (auto-start)
  welcome: ["добро пожаловать", "welcome"],
  startGameButton: ["начать игру", "start playing"],
  // Лобби: «Идет набор игроков»
  recruiting: ["идет набор игроков", "recruiting players"],
  // Пункты меню «показать/скрыть роли» (auto-start, day/night switch)
  showRoles: ["показать роли", "show roles"],
  hideRoles: ["скрыть роли", "hide roles"],
} as const;

/** CSS-классы/идентификаторы, создаваемые САМИМ расширением (наши, не сайта). */
export const OWN = {
  statsButton: "stats-button",
  noteButton: "note-button",
  lastGamesButton: "last-games-button",
  hideVideoButton: "hide-video-button",
  rotateButton: "rotate-button",
  roleHideStyle: "polemica-role-hide",
  /** Контейнер для иконок, добавляемых к игроку. */
  playerIcons: "player-icons",
  /** Контейнер инлайновой статистики игрока. */
  playerStats: "player-stats",
  /** Тултип со статистикой. */
  tooltip: "tooltip",
  /** <style> с правилами страницы матча, создаётся фичей. */
  matchPageStyle: "polemica-match-page-style",
} as const;

/** Все классы наших элементов, которые надо удалять при выключении фичи. */
export const OWN_BUTTON_SELECTOR =
  ".stats-button, .note-button, .last-games-button, .hide-video-button, .rotate-button";
