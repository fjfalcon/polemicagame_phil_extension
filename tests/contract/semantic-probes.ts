/**
 * Семантические пробы по СЫРОМУ тексту бандлов сайта.
 *
 * Ответ на главный урок недели 01–06.08.2026 (см. docs/audit-fragility):
 * прежний контракт проверял «класс ещё существует», а все жалобы были про
 * «класс больше не означает то состояние». Каждая проба пригвождает СВЯЗЬ
 * (байндинг, ветку, матрицу кнопок), а не факт существования строки.
 *
 * Правила:
 *  - только стабильные якоря: строковые литералы, имена свойств и ключи
 *    локали; минифицированные имена переменных матчатся как \w+;
 *  - пробы чистые (текст → вердикт): их гоняет и живой контракт-тест по
 *    сети, и офлайн-юнит по реальным фрагментам с мутациями — так
 *    мутационный критерий проверяется без сети;
 *  - окно после якоря ограничено: «где-то в бандле» — не доказательство.
 */

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

type Probe = (text: string) => ProbeResult;

function re(pattern: RegExp, detail: string): Probe {
  return (text) => ({ ok: pattern.test(text), detail });
}

function has(needle: string, detail: string): Probe {
  return (text) => ({ ok: text.includes(needle), detail });
}

/**
 * Окно после якоря; null — якорь не найден. Для socket-хендлеров окно
 * дополнительно обрезается по началу СЛЕДУЮЩЕЙ подписки: фиксированная длина
 * заезжала в соседний хендлер и его кнопки читались как «лишние» в нашем
 * (проба stopGameMatrix поймала это на первом же прогоне).
 */
function windowAfter(text: string, anchor: string, size: number): string | null {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  let end = at + anchor.length + size;
  const nextHandler = text.indexOf('.on("', at + anchor.length);
  if (nextHandler > 0 && nextHandler < end) end = nextHandler;
  return text.slice(at, end);
}

function inWindow(
  anchor: string,
  size: number,
  mustHave: string[],
  mustNotHave: string[],
  detail: string,
): Probe {
  return (text) => {
    const w = windowAfter(text, anchor, size);
    if (w === null) return { ok: false, detail: `${detail}: якорь «${anchor}» не найден` };
    for (const needle of mustHave) {
      if (!w.includes(needle)) return { ok: false, detail: `${detail}: в окне нет «${needle}»` };
    }
    for (const needle of mustNotHave) {
      if (w.includes(needle)) return { ok: false, detail: `${detail}: в окне лишнее «${needle}»` };
    }
    return { ok: true, detail };
  };
}

// ─────────────────────────── game-search.js ───────────────────────────

export const gameSearchProbes: Record<string, Probe> = {
  /** Непринятость обозначена ровно cursor-pointer, привязанным к !isGameAccepted. */
  acceptCursorBinding: re(
    /class:\{"cursor-pointer":!\w+\.isGameAccepted\}/,
    "cursor-pointer ⇔ !isGameAccepted (queue-requeue и auto-start читают класс как состояние)",
  ),
  /** isGameAccepted — это group.ready, а не что-то другое. */
  acceptedIsGroupReady: re(
    /isGameAccepted:function\s*\(\)\s*\{[\s\S]{0,240}?\.group\)[\s\S]{0,140}?\.ready\}/,
    "isGameAccepted вычисляется из searchState.group.ready",
  ),
  /** Отказ лобби перезагружает страницу — на этом стоит мост этапа 1. */
  notAcceptedReloads: re(
    /"game_not_accepted"===\w+\.reason\?window\.location\.reload\(\)/,
    "on_stop_game_search(game_not_accepted) → window.location.reload()",
  ),
  /** Подпись непринятой карточки. */
  acceptLabel: has("Принять игру", "текст «Принять игру» в ветке непринятой карточки"),
  /**
   * Переход в комнату — POST-форма на /game ИМЕННО в хендлере on_game_found
   * (queue-requeue опирается на полную загрузку). Два несвязанных «где-то в
   * бандле» здесь не доказательство: в game-search ДВЕ формы на /game, и
   * перевод целевой на GET оставался бы зелёным (контрольное ревью
   * 06.08.2026) — поэтому оба признака ищутся в окне самого хендлера.
   */
  postFormToGame: inWindow(
    'on("on_game_found"',
    900,
    ['location.origin+"/game"', 'setAttribute("method","post")'],
    [],
    "on_game_found строит POST-форму на /game",
  ),
  // ── «В поиск» после игры (postgame-search) ──
  /** Пока сервер держит игрока в игре, вместо «Играть» рисуется решающий блок. */
  decideBlockButtons: inWindow(
    "p-play__profile-game--decide",
    600,
    ["Продолжить игру", "Покинуть игру", "quitGame(!1)"],
    [],
    "решающий блок: «Продолжить игру» + «Покинуть игру» → quitGame(false)",
  ),
  /**
   * «Покинуть игру» сама из игры НЕ выводит: quitGame(false) открывает
   * модалку, и только quitGame(true) шлёт POST /api/games/quit и сбрасывает
   * userInGame. На этой двухшаговости стоит машина postgame-search.
   */
  quitOpensConfirmThenApi: inWindow(
    "quitGame:function",
    1200,
    ["showQuitAskModal=!0", "/api/games/quit", "storeChangeUserInGame(null)"],
    [],
    "quitGame: false → модалка; true → POST /api/games/quit → userInGame сброшен",
  ),
  /**
   * Единственное использование модалки подтверждения: quit → quitGame(true),
   * ban-проп НЕ передаётся (иначе текст модалки грозил бы баном, и автоклик
   * по ней потерял бы моральное право на существование).
   */
  confirmQuitWiring: inWindow(
    'ConfirmQuitGameModal",{on:',
    240,
    ["quitGame(!0)"],
    ["ban"],
    "usage ConfirmQuitGameModal: quit → quitGame(true), без ban-пропа",
  ),
  /** Кнопка модалки: класс, клик и подпись «Покинуть лобби». */
  confirmQuitButtonLabel: inWindow(
    'confirmQuit__content-btn",on:{click:',
    160,
    ["Покинуть лобби"],
    [],
    "кнопка модалки подтверждения: confirmQuit__content-btn + «Покинуть лобби»",
  ),
  /**
   * Второй путь выхода: на illegalState=in_game сайт открывает модалку
   * «Вы уже играете» с колбэком quit_game. Ветка гейтится inGameUsersAllowed
   * — значит модалка появляется не всегда, и decide-путь остаётся основным.
   */
  inGameModalWiring: inWindow(
    'case"in_game":',
    260,
    ["storeChangeUserInGame(!0)", "inGameUsersAllowed", '"game-in-progress"', 'emit("quit_game")'],
    [],
    "illegalState=in_game → модалка game-in-progress с onQuitGame → quit_game",
  ),
  /**
   * Режимы очередей и их подписи: их показывает панелька «сколько в
   * очередях» после игры, а сам список приходит с /api/search по ключам
   * mode. Переименуют — панель начнёт врать заголовками.
   */
  censorshipModeTitles: inWindow(
    "censorshipModes:[",
    900,
    ['mode:"standard"', 'title:"Обычный"', 'mode:"polite"', 'title:"Рейтинг"', 'mode:"prime"', 'title:"Prime"'],
    [],
    "очереди: standard «Обычный», polite «Рейтинг», prime «Prime»",
  ),
  /** disabled у «Играть» ⇔ не выбраны очереди (queue-requeue и postgame читают). */
  playDisabledBinding: re(
    /attrs:\{disabled:!\w+\.selectedCensorshipModes\.length\}/,
    "disabled «Играть» ⇔ !selectedCensorshipModes.length",
  ),
  /**
   * Лоадер кнопки поиска ⇔ isSearchBtnLoading. В ветке illegalState=in_game
   * сайт searchBtnLoading НЕ сбрасывает — «вечная крутилка», на детекции
   * которой стоит самолечение postgame-search (лог 07.08.2026, 18:29).
   */
  searchBtnLoaderBinding: re(
    /isSearchBtnLoading\?\w+\("div",\{staticClass:"p-play__profile-game p-play__profile-game--search p-play__profile-game-loader-gradient"\}/,
    "isSearchBtnLoading ⇔ лоадер p-play__profile-game-loader-gradient вместо «Играть»",
  ),
  /** Пока userInGame — поиск запрещён; «Играть» в DOM не существует. */
  searchDisabledWhileInGame: re(
    /searchDisabled:function\(\)\{return (?:\w+|this)\.gameSearchDisabled\|\|(?:\w+|this)\.userInGame&&!(?:\w+|this)\.inGameUsersAllowed\}/,
    "searchDisabled ⇔ gameSearchDisabled || userInGame && !inGameUsersAllowed",
  ),
};

// ─────────────────────────── room/main.js ───────────────────────────

export const roomProbes: Record<string, Probe> = {
  /** Нажатая готовность = класс active, привязанный к votingForGameStart.voted. */
  readyActiveBoundToVoted: re(
    /\{active:\w+(\.\$parent)?\.votingForGameStart\.voted\}/,
    "active ⇔ votingForGameStart.voted (второй признак готовности в queue-requeue)",
  ),
  /** Экран набора игроков ⇔ ровно стадия voting_for_game_start. */
  rollerPregameTernary: re(
    /"voting_for_game_start"===[\s\S]{0,160}?\.stage\.type\)\s*\?/,
    "тернарник роллера: .new-stage рисуется ровно при voting_for_game_start",
  ),
  newStageClass: has('class:"new-stage"', "класс new-stage существует в шаблоне роллера"),
  /** on_game_disbandment только запускает отсчёт (t.time) — больше ничего. */
  disbandmentStartsCountdown: re(
    /on\("on_game_disbandment",[\s\S]{0,220}?startDisbandmentCountdown\(\w+\.time\)/,
    "on_game_disbandment → startDisbandmentCountdown(t.time)",
  ),
  /** Старт стадии немедленно ставит gameDidStart (гасит отсчёт роспуска). */
  startStageSetsGameDidStart: inWindow(
    "on_start_stage:function",
    500,
    ["setGameDidStart"],
    [],
    "on_start_stage коммитит setGameDidStart сразу",
  ),
  /**
   * Матрица кнопок роспуска: on_stop_game рисует ЕДИНСТВЕННУЮ ссылку на поиск
   * — ровно та узкая форма, по которой queue-requeue доказывает развал.
   */
  stopGameMatrix: inWindow(
    'on("on_stop_game"',
    900,
    ["link_search_game"],
    ["link_home_redirect", "try_again"],
    "on_stop_game: только ссылка на поиск, без home и retry",
  ),
  /** Экран исключения — home + search: ambiguous для queue-requeue. */
  selfStrikeMatrix: inWindow(
    'on("on_self_strike"',
    1500,
    ["link_home_redirect", "link_search_game"],
    [],
    "on_self_strike: home + search (исключённого нельзя вернуть автокликом)",
  ),
  /** Потеря сессии — только action без ссылки на поиск (retry-вето). */
  sessionDroppedMatrix: inWindow(
    'on("on_session_dropped"',
    500,
    ["try_again"],
    ["link_search_game"],
    "on_session_dropped: только try_again-action, без ссылки на поиск",
  ),
  /** Камера «выключена» = класс off, привязанный к !videoTrackAvailable. */
  cameraOffBinding: re(
    /\{off:!this\.\$store\.state\.videoTrackAvailable\}/,
    "off ⇔ !videoTrackAvailable (auto-start прекращает автоклики по off)",
  ),
  /**
   * Направление меню ролей: при показанной роли пункт зовётся значением ключа
   * hide_roles. ВНИМАНИЕ: ключи локали семантически ИНВЕРТИРОВАНЫ
   * (show_roles:"Скрыть роли") — проба пригвождает и байндинг, и инверсию:
   * если сайт «исправит» любую половину, тест упадёт и мы пересмотрим маркеры.
   */
  roleMenuDirection: re(
    /roleDisplay\?this\.\$root\.Loc\.hide_roles:this\.\$root\.Loc\.show_roles/,
    "roleDisplay ? Loc.hide_roles : Loc.show_roles",
  ),
  /** Пара without-hover/with-hover принадлежит кнопке продолжения паузы. */
  withoutHoverContinue: re(
    /class:"without-hover",textContent:v\(\w+\.\$parent\.readinessTextWithoutHoverContinue\)/,
    "without-hover привязан к тексту продолжения паузы (F8)",
  ),
  /** Строка суммы в таблице статистики подписана «Итог» (захардкожено сайтом). */
  sumRowTitle: has(
    'code:"sum",title:"Итог"',
    "строка суммы: code=sum, title=«Итог» (match-stats ищет строку по этому тексту)",
  ),
  /** Ячейки таблицы статистики: ["cell","title",code] / ["cell","player",code]. */
  statsCellClasses: (text) => ({
    ok: /\["cell","title",\w+\.code\]/.test(text) && /\["cell","player",\w+\.code\]/.test(text),
    detail: "классы ячеек таблицы статистики (.cell.title.<code>)",
  }),
  // ── «В поиск» после игры (postgame-search) ──
  /**
   * Убитый/заголосованный при начавшейся игре сам становится зрителем —
   * ровно поэтому кнопка «В поиск» показывается в режиме зрителя: это
   * штатное состояние умершего игрока, а из игры сервер его НЕ выписал.
   */
  deadPlayerBecomesViewer: inWindow(
    'on("on_self_strike"',
    1500,
    ['"/game?role=viewer&game_id="'],
    [],
    "on_self_strike (не kick, игра идёт) → редирект в /game?role=viewer",
  ),
  /**
   * Выбытие игрока помечается классами плитки, и ровно ими postgame-search
   * узнаёт «матч окончен ДЛЯ МЕНЯ»: сайт выбывшего из комнаты не уводит и в
   * `?role=viewer` не переводит (жалоба 07.08.2026). Проба держит связь
   * класс ⇔ состояние, а не факт существования строки.
   */
  eliminatedStateClasses: inWindow(
    "notTransparentStateClasses:function",
    400,
    ['isKilled?', '"state-voted"', '"state-killed"', 'isDisqualified&&', '"state-disqualified"'],
    [],
    "state-voted/state-killed ⇔ isKilled(+votedBy), state-disqualified ⇔ isDisqualified",
  ),
  /**
   * Плашка игрока: номер (PlayerNumber) и ник живут в одном `.player__info`,
   * а у самой плашки — сайтовый onClick (превью игрока). На этом стоит
   * compact-nicks: сворачиваем ник, «ручкой» служит номер, а его клик мы
   * обязаны гасить, иначе откроется чужое окно.
   */
  playerInfoPlate: inWindow(
    'class:"player__info info"',
    420,
    ["showPlayerPreview", 'class:"info__name"'],
    [],
    "player__info: onClick=showPlayerPreview + внутри info__name",
  ),
  /** Номер игрока: класс player-N (id), подпись — id+1. */
  playerNumberBinding: re(
    /\["player-number","player-"\.concat\(\w+\.id\)\][^)]*\)[^)]*textContent:v\(\w+\.id\+1\)/,
    "PlayerNumber: класс player-<id>, текст id+1 (id 0-based, подпись с единицы)",
  ),
  /**
   * Инициатор паузы приходит с сервера: сайт читает `pause.initiatorId` из
   * состояния игры и прокидывает его в обработчик паузы (сам обработчик
   * поле игнорирует — именно поэтому «кто поставил» нигде не видно). На
   * этом стоит фича pause-initiator: пропадёт поле — фича замолчит, и
   * узнать об этом надо тестом, а не по жалобе.
   */
  pauseInitiatorInState: re(
    /\w+\.pause&&\w+\.pause\.initiatorId&&\(\w+=\w+\.pause\.initiatorId\)/,
    "состояние игры несёт pause.initiatorId",
  ),
  /**
   * …и доезжает до обработчика паузы. ВАЖНО про честность формулировки: это
   * ВНУТРЕННИЙ вызов сайта (`e.on_start_pause({…, initiatorId:f})`), а не
   * доказательство того, что поле есть в проводном событии `on_start_pause`.
   * Что кладёт туда сервер, из бандла не следует — обработчик поле не
   * читает. Проверять это можно только живой сессией (ревью 08.08.2026).
   */
  pauseInitiatorReachesHandler: re(
    /on_start_pause\(\{time:\w+,voted:[^}]*initiatorId:\w+\}\)/,
    "сайт передаёт initiatorId в свой обработчик паузы (внутренний вызов)",
  ),
  /** Футер статистики: «Поиск игры» ведёт на /game-search (fromGame). */
  statsFooterSearchLink: re(
    /endGameLink:function\(\)\{return\{link:"\/game-search"/,
    "endGameLink → /game-search (кнопка «Поиск игры» в футере статистики)",
  ),
  /** on_stop_game(gameOver): сайт сам уводит комнату на /game-search. */
  gameOverAutoRedirect: inWindow(
    'on("on_stop_game"',
    900,
    ['"gameOver"', 'location="/game-search"'],
    [],
    "on_stop_game c reason.code=gameOver → авторедирект на поиск",
  ),
  /**
   * Окно захвата стримера: сайт открывает ЖИВОМУ игроку viewer-вкладку с
   * window.name === "streamWindow" — на этом литерале стоит гейт кнопки
   * «В поиск» (иначе мисклик в окне захвата выписал бы стримера из матча).
   */
  streamWindowName: inWindow(
    "updateStreamerWindow:function",
    600,
    ['"?role=viewer&game_id="', 'window.open(', '"streamWindow"'],
    [],
    "updateStreamerWindow: window.open(url?role=viewer…, \"streamWindow\")",
  ),
};

// ─────────────────────────── bundle/main.css ───────────────────────────

/**
 * Правила раскладки таблицы статистики. Они SCOPED — привязаны к Vue-хешу
 * компонента, и наши вставленные строки фаз обязаны нести тот же атрибут,
 * иначе таблица разваливается (жалоба 07.08.2026: ячейки схлопнулись в
 * ноль, строки растянулись). Проба не проверяет КОНКРЕТНЫЙ хеш (он меняется
 * от ребилда к ребилду, и хардкод как раз и был причиной бага) — она
 * проверяет, что раскладка по-прежнему живёт под scoped-селектором: пока
 * это так, детект scope из DOM обязателен.
 */
export const siteCssProbes: Record<string, Probe> = {
  statsRowScoped: re(
    /\.table \.row\[data-v-[a-f0-9]+\]\{[^}]*display:flex/,
    "раскладка строки таблицы статистики scoped (.table .row[data-v-*]{display:flex})",
  ),
  statsCellScoped: re(
    // Граница `[;{]` обязательна: голое «flex:1» живёт и внутри префиксных
    // -webkit-box-flex/-ms-flex, и проба без неё оставалась зелёной, когда
    // настоящий flex уезжал (поймано мутацией 07.08.2026).
    /\.table \.row \.cell\[data-v-[a-f0-9]+\]\{[^}]*[;{]flex:1[;}]/,
    "ширина ячеек таблицы статистики scoped (.table .row .cell[data-v-*]{flex:1})",
  ),
  /** Числа, на которые опирается наш фолбэк-CSS, если scope не найден. */
  statsCellWidths: (text) => {
    const cell = /\.table \.row \.cell\[data-v-[a-f0-9]+\]\{([^}]*)\}/.exec(text);
    const title = /\.table \.row \.cell\.title\[data-v-[a-f0-9]+\]\{([^}]*)\}/.exec(text);
    const detail = "ширины ячеек статистики: player min-width 115px, title 67px";
    if (!cell || !title) return { ok: false, detail: `${detail}: правила не найдены` };
    const ok =
      cell[1].includes("min-width:115px") &&
      title[1].includes("min-width:67px") &&
      title[1].includes("max-width:67px");
    return { ok, detail };
  },
};

// ────────────────────── room/bundle/style.css (комната) ──────────────────────

/**
 * Геометрия плитки игрока, на которой стоит перестановка плашки по углам
 * (nick-plate). Двигаем мы КОНТЕЙНЕР `.player__botleftmenu`, и работает это
 * только пока: плитка — точка отсчёта (position: relative), а контейнер
 * прижат к её левому нижнему углу абсолютным позиционированием.
 */
export const roomCssProbes: Record<string, Probe> = {
  tileIsPositioningRoot: re(
    /\.player\[data-v-[a-f0-9]+\]\{[^}]*position:relative/,
    "плитка .player — position:relative (точка отсчёта для углов плашки)",
  ),
  plateContainerAnchored: (text) => {
    const rule = /\.player__botleftmenu\[data-v-[a-f0-9]+\]\{([^}]*)\}/.exec(text);
    const detail = "контейнер плашки прижат к левому нижнему углу (left/bottom .625rem)";
    if (!rule) return { ok: false, detail: `${detail}: правило не найдено` };
    const ok = rule[1].includes("bottom:.625rem") && rule[1].includes("left:.625rem");
    return { ok, detail };
  },
  /** Позиционирование контейнеров углов — absolute (общее правило сайта). */
  cornerMenusAbsolute: re(
    /\.player__(?:botleftmenu|toprightmenu)\[data-v-[a-f0-9]+\][^{]*\{[^}]*position:absolute/,
    "угловые контейнеры плитки позиционируются absolute",
  ),
};

/**
 * Длительность анимации перехода роллера (мс) — для сверки с нашим confirm.
 * Якорь по соседнему полю data-блока РОЛЛЕРА: в бандле два animationDuration
 * (у другого компонента — 0), и first-match после перестановки модулей
 * минификатором отдал бы 0, вакуумно «пройдя» сверку (ревью 06.08.2026).
 */
export function siteRollerAnimationMs(text: string): number | null {
  const m = /animationDuration:(\d+),currentSubstage:/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Хэши иконок из auto-start обязаны существовать в бандле комнаты. */
export function missingIconHashes(text: string, hashes: string[]): string[] {
  return hashes.filter((h) => !text.includes(h));
}

// ─────────────────────────── локали ───────────────────────────

export const ruLocaleProbes: Record<string, Probe> = {
  readinessLabels: (text) => {
    const keys = [
      'start_game_readiness_button_not_ready:"Готов"',
      'start_game_readiness_button_ready:"Готов"',
      'player_start_game_readiness_state:"Готов"',
    ];
    const missing = keys.filter((k) => !text.includes(k));
    return {
      ok: missing.length === 0,
      detail: `обе подписи кнопки готовности и отметка плитки — ровно «Готов» (${missing.join("; ") || "ок"})`,
    };
  },
  /**
   * Подписи кнопок центра — по ним controls-safety отличает «Завершите
   * речь» и ЛХ от остальных: классы у всех кнопок одинаковые. Переименует
   * сайт — защита от случайного выкрика молча перестанет действовать.
   */
  controlActionLabels: (text) => {
    const keys = [
      'speech_player_finish:"Завершите речь"',
      'outcry:"Выкрикнуть"',
      'send_guess:"Оставить ЛХ"',
      'cancel_guess:"Сбросить ЛХ"',
    ];
    const missing = keys.filter((k) => !text.includes(k));
    return {
      ok: missing.length === 0,
      detail: `подписи кнопок действий в центре ряда (${missing.join("; ") || "ок"})`,
    };
  },
  /**
   * Текст стадии ДО прихода состояния комнаты. По нему queue-requeue и
   * postgame-search отличают свежезагруженную комнату от идущего матча —
   * переименует сайт, и возврат после развала снова начнёт выключаться сам
   * (жалоба 09.08.2026).
   */
  waitingForGameLabel: (text) => ({
    ok: text.includes('waiting_for_game:"Ожидание начала игры"'),
    detail: "подпись стадии ожидания начала игры",
  }),
  pauseLabels: (text) => ({
    ok:
      text.includes('pause:"Пауза"') &&
      text.includes('end_pause:"Завершить"') &&
      text.includes('continue_game_button_not_ready:"Продолжить игру"'),
    detail: "точные подписи паузы/продолжения/завершения (F8)",
  }),
  welcomeLabels: (text) => ({
    ok:
      text.includes('welcome:"Добро пожаловать"') &&
      text.includes('connect_to_game:"Начать игру"') &&
      text.includes('viewer_mode:"Режим зрителя"') &&
      text.includes('start_watching:"Начать просмотр"'),
    detail: "подписи стартового окна игрока и зрителя",
  }),
  /** Инверсия ключей меню ролей — вторая половина пробы roleMenuDirection. */
  roleMenuKeysInverted: (text) => ({
    ok: text.includes('show_roles:"Скрыть роли"') && text.includes('hide_roles:"Показать роли"'),
    detail: "ключи show/hide_roles семантически инвертированы (известная ловушка)",
  }),
  roleRowTitle: has('game_stats_role:"Роль"', "заголовок строки ролей — «Роль» (match-stats)"),
  disbandPrefix: has(
    'readiness_timeout:"Игра будет распущена через"',
    "префикс отсчёта роспуска (парсер MM:SS в queue-requeue)",
  ),
};

export function runProbes(
  probes: Record<string, Probe>,
  text: string,
): Array<{ name: string; ok: boolean; detail: string }> {
  return Object.entries(probes).map(([name, probe]) => {
    const r = probe(text);
    return { name, ok: r.ok, detail: r.detail };
  });
}
