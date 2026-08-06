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
