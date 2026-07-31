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
  webcamButton: "div.button.preset-1.small.desktop-version",
  webcamButtonStartIcon: ".button.preset-1.small.desktop-version",
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
    "night",
    "card deal",
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
    "day",
    "morning",
    "vote",
    "voting",
    "results",
    "player's speech",
    "player speech",
    "speech",
    "additional speech",
    "farewell",
    // best-effort, не проверено на живом EN-интерфейсе
    "best move",
    "miss",
  ],
  vote: ["голос", "vote"],
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
  muteButton: "mute-button",
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
  ".stats-button, .note-button, .last-games-button, .hide-video-button, .rotate-button, .mute-button";

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
export function classifyPhaseText(text: string): "day" | "night" | null {
  const day = hasPhaseMarker(text, TEXT.day);
  const night = hasPhaseMarker(text, TEXT.night);
  if (day && night) return hasPhaseMarker(text, TEXT.dayStrong) ? "day" : "night";
  if (day) return "day";
  if (night) return "night";
  return null;
}
