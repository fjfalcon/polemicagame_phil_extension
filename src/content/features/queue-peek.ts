/**
 * Фича: «Кто в очереди» — разведка состава очередей поиска.
 *
 * КАК РАБОТАЕТ. Сервер отдаёт поимённый список ищущих ТОЛЬКО участнику
 * очереди (и только при Pro-подписке: без неё в `queues[mode].players`
 * приходит число, а не массив). Поэтому кнопка на секунду заводит нас в
 * самую пустую из разрешённых очередей, забирает `on_game_search_state` —
 * оно содержит сразу все три очереди — и немедленно выходит.
 *
 * ОЧЕРЕДЬ ПРИВЯЗАНА К ПОЛЬЗОВАТЕЛЮ, А НЕ К СОКЕТУ. Это главный факт, из
 * которого растут все меры ниже: наш `stop_game_search` снимает с поиска
 * АККАУНТ, поэтому разведка обязана прерываться, как только игрок начал
 * собственный поиск (см. registerPeekAbort/releaseForUserAction), иначе мы
 * запоздалым выходом выкинем его из его же очереди.
 *
 * ГЛАВНЫЙ РИСК: решение «собрать игру» принимает сервер в момент нашего
 * входа. Если очередь добьётся до десяти, игра создаётся мгновенно, и сайт
 * сам уводит в неё — отменить это расширение не может. Меры:
 *  • очередь выбирается по публичному счётчику (самая пустая из отмеченных),
 *    счётчик перечитывается НЕПОСРЕДСТВЕННО перед входом;
 *  • при заполненности выше WARN_AT спрашиваем подтверждение;
 *  • автопринятие глушится ровно на сетевую часть (стоп-кран взводится после
 *    всех диалогов и ожиданий, иначе он истекал до самого опасного момента);
 *  • `stop_game_search` уходит в finally и мы ЖДЁМ `on_stop_game_search`;
 *  • разведка отменяема снаружи: из disable(), pagehide и клика «Играть».
 *
 * Протокол socket.io v2 (engine.io v3) говорим сырым WebSocket. Формы кадров
 * сверены с бандлом сайта: `stop_game_search` сайт шлёт БЕЗ аргументов
 * (`socket.emit("stop_game_search")`, три места), подтверждение приходит
 * событием `on_stop_game_search`.
 */
import { log } from "@core/log";
import { escapeHtml } from "@core/escape";
import { onDomChange } from "@core/dom";
import { SITE } from "@core/selectors";
import { setAutoAcceptSuppressed, registerPeekAbort } from "../auto-accept-gate";
import type { Feature, FeatureContext } from "@core/feature";
import type { Settings } from "@shared/types";

const SCOPE = "queue-peek";
const SEARCH_API = "https://game.polemicagame.com/api/search";
/**
 * Креды идут И в URL подключения, И в кадре неймспейса — так делает клиент
 * сайта: socket.io v2 передаёт `opts.query` в engine.io (то есть в URL) и
 * отдельно приклеивает её к CONNECT-пакету (`40/search?...`). Без query в
 * URL сервер закрывал соединение сразу после установки.
 */
function socketUrl(creds: { id: number; authKey: string }): string {
  const q = new URLSearchParams({
    userId: String(creds.id),
    authKey: creds.authKey,
    intention: "game_search",
    EIO: "3",
    transport: "websocket",
  });
  return `wss://game.polemicagame.com/socket.io/?${q.toString()}`;
}
const NS = "/search";
/** Выше этого числа ищущих вход в очередь может достроить состав до игры. */
const WARN_AT = 5;
/** Жёсткий предел на сетевую часть: дальше выходим независимо от результата. */
const HARD_TIMEOUT_MS = 8000;
/** Сколько ждём подтверждения выхода, прежде чем рвать сокет. */
const STOP_CONFIRM_MS = 1500;
/** Таймаут обычных HTTP-запросов фичи (иначе бюджет до входа не ограничен). */
const HTTP_TIMEOUT_MS = 5000;

const MODE_TITLES: Record<string, string> = {
  standard: "Обычный",
  polite: "Рейтинг",
  prime: "Prime",
};

interface QueueInfo {
  available?: boolean;
  players: number | QueuePlayer[];
}
interface QueuePlayer {
  id?: number;
  username?: string;
  mmr?: number;
}

let settings: Settings | null = null;
let button: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;
let running = false;
/** Отмена текущей разведки: выставляется на время сетевой части. */
let abortCurrent: (() => void) | null = null;
let pageHideListener: (() => void) | null = null;
let unsubscribeDom: (() => void) | null = null;
let playClickListener: ((e: MouseEvent) => void) | null = null;
/**
 * Разведка отменена снаружи (клик «Играть», уход со страницы, выключение
 * фичи). ЯВНЫЙ флаг, а не разбор текста ошибки: на тексте цикл повторов
 * не понимал, что его прервали, и заходил в очередь ВТОРОЙ раз — уже поверх
 * начатого игроком поиска и с возвращённым автопринятием.
 */
let peekCancelled = false;

/** Ошибка захода. `retryable` — можно ли безопасно попробовать другую очередь. */
class PeekError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PeekError";
  }
}

/** Прервать текущую разведку (и запретить повторы). */
function cancelPeek(reason: string): void {
  if (!running) return;
  peekCancelled = true;
  log.info(SCOPE, "разведка отменена:", reason);
  abortCurrent?.();
}

function isSearchPage(): boolean {
  return location.pathname === "/game-search" || location.pathname.startsWith("/game-search/");
}

/** Идёт ли на странице НАСТОЯЩИЙ поиск игрока (тогда лезть вторым сокетом нельзя). */
function siteSearchActive(): boolean {
  return !!document.querySelector(SITE.searchInProgress);
}

/**
 * Проверки ниже — по НАЛИЧИЮ узла, без getClientRects: панель поиска у сайта
 * собрана на `v-if` (в render-функции это цепочка тернарников), состояния
 * взаимоисключающие и лишних скрытых копий не рендерится. Замер видимости
 * форсировал бы layout на каждое изменение DOM — см. syncButtonVisibility.
 *
 * Игра уже собрана: панель принятия («Принять игру», затем обратный отсчёт с
 * «Готовы: N/10»). Секундомер поиска в этот момент со страницы уходит, поэтому
 * одного siteSearchActive() мало — раньше кнопка оставалась висеть ровно там,
 * где разведка опаснее всего: сервер держит для игрока найденное лобби.
 */
function siteAcceptActive(): boolean {
  return !!document.querySelector(SITE.profileAccept);
}

/**
 * Разведка уместна ровно в одном состоянии — когда игрок МОЖЕТ начать поиск,
 * то есть на месте кнопка «Играть». Проверка намеренно fail-closed: незнакомое
 * состояние панели («Игра запускается», скелетон загрузки, собранная игра)
 * прячет кнопку, а не показывает её «на всякий случай».
 */
function canStartSearch(): boolean {
  return !!document.querySelector(SITE.profileSearchButton);
}

/** Почему разведка сейчас запрещена; null — можно. */
function blockedReason(): string | null {
  if (siteSearchActive()) {
    return "Вы уже в поиске — разведка отключена, чтобы не порвать вашу очередь.";
  }
  if (siteAcceptActive()) {
    return "Игра уже собрана — разведка отключена, чтобы не мешать принятию.";
  }
  if (!canStartSearch()) {
    return "Кнопка «Играть» сейчас недоступна — разведка отключена.";
  }
  return null;
}

function enabledModes(): string[] {
  const s = settings;
  const list: string[] = [];
  if (!s || s.queue_peek_standard !== false) list.push("standard");
  if (!s || s.queue_peek_polite !== false) list.push("polite");
  if (!s || s.queue_peek_prime !== false) list.push("prime");
  return list;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface Credentials {
  id: number;
  authKey: string;
  /** Pro-подписка: без неё «Рейтинг» недоступен, а состав приходит числом. */
  pro: boolean;
  /** Отдельное членство Prime — Pro его НЕ включает. */
  prime: boolean;
}

/** Креды из SSR-разметки страницы поиска: Vue снимает атрибут при монтировании. */
async function readCredentials(): Promise<Credentials | null> {
  try {
    const html = await (await fetchWithTimeout("/game-search")).text();
    const m = html.match(/current-user='([^']+)'/);
    if (!m) return null;
    const user = JSON.parse(m[1].replace(/&quot;/g, '"'));
    if (!user?.id || !user?.authKey) return null;
    return {
      id: Number(user.id),
      authKey: String(user.authKey),
      pro: Number(user?.subscription?.type || 0) >= 2,
      prime: user?.prime_member === true || user?.primeMember === true,
    };
  } catch (e) {
    // ТОЛЬКО имя ошибки: текст SyntaxError цитирует разбираемую строку, а в
    // ней authKey. Логи выгружаются кнопкой и уходят людям (docs/site-api.md).
    log.error(SCOPE, "credentials read failed", (e as Error)?.name || "unknown");
    return null;
  }
}

async function fetchQueueCounts(): Promise<Record<string, QueueInfo> | null> {
  try {
    // Без заголовков: Content-Type на кросс-доменном GET делает запрос
    // непростым и добавляет preflight, который сервис может не пережить.
    const res = await fetchWithTimeout(SEARCH_API);
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.queues as Record<string, QueueInfo>) || null;
  } catch (e) {
    log.error(SCOPE, "queue counts failed", (e as Error)?.name || "unknown");
    return null;
  }
}

function countOf(info: QueueInfo | undefined): number {
  if (!info) return 0;
  return Array.isArray(info.players) ? info.players.length : Number(info.players) || 0;
}

/**
 * Один заход в очередь: подключиться, дождаться состояния, выйти.
 * Возвращает `queues` из `on_game_search_state` (в нём сразу все режимы).
 * Отмена снаружи — через registerPeekAbort/abortCurrent.
 */
/**
 * Доступна ли очередь аккаунту. Сервер на заявку в чужую очередь отвечает
 * `bad_request`, а публичный счётчик этого не показывает: он присылает
 * `available: false` сразу для всех режимов (проверено живьём).
 */
function modeAllowed(mode: string, creds: Credentials): boolean {
  if (mode === "prime") return creds.prime;
  if (mode === "polite") return creds.pro;
  return true;
}

function peekOnce(creds: Credentials, mode: string): Promise<Record<string, QueueInfo>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(creds));
    let settled = false;
    let searchStarted = false;
    let leaving = false;
    let result: Record<string, QueueInfo> | null = null;
    let failure: Error | null = null;
    let handshakeSeen = false;
    /** Имена полученных событий — чтобы таймаут был диагностируемым. */
    const seen: string[] = [];

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(stopTimer);
      abortCurrent = null;
      registerPeekAbort(null);
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
      if (failure) reject(failure);
      else resolve(result || {});
    };

    let stopTimer: ReturnType<typeof setTimeout> = setTimeout(() => undefined, 0);

    /** Выйти из очереди и дождаться подтверждения (или добить по таймауту). */
    const leave = (err?: Error) => {
      if (err && !failure) failure = err;
      if (leaving) return;
      leaving = true;
      if (!searchStarted || ws.readyState !== WebSocket.OPEN) {
        done();
        return;
      }
      try {
        // Форма сверена с бандлом сайта: без аргументов.
        ws.send(`42${NS},["stop_game_search"]`);
      } catch {
        done();
        return;
      }
      // Ждём on_stop_game_search; не дождались — рвём сокет (обрыв сессии
      // сервер тоже трактует как выход, см. queue-timeout-report.md).
      stopTimer = setTimeout(() => {
        log.warn(SCOPE, "подтверждения выхода не было — рвём сокет");
        done();
      }, STOP_CONFIRM_MS);
    };

    abortCurrent = () => leave(new PeekError("разведка прервана"));
    // Регистрируем ОБЁРТКУ, помечающую заход отменённым: сырой abortCurrent
    // не ставил бы peekCancelled, и отмена по этому пути (releaseForUserAction)
    // не запрещала бы повторную попытку. Сейчас это прикрывает собственный
    // click-listener, но держаться на таком совпадении нельзя.
    registerPeekAbort(() => {
      peekCancelled = true;
      abortCurrent?.();
    });

    const timeout = setTimeout(
      () =>
        leave(
          new PeekError(
            `сервер не ответил вовремя (получено: ${seen.length ? seen.join(", ") : "ничего"})`,
          ),
        ),
      HARD_TIMEOUT_MS,
    );

    ws.addEventListener("error", () => {
      if (!failure) failure = new PeekError("не удалось подключиться");
      done();
    });
    ws.addEventListener("close", (e) => {
      if (!failure && !result) {
        // Код и причина закрытия — единственная подсказка, если сервер
        // отверг подключение (неверная форма запроса, протухший authKey).
        failure = new PeekError(
          `соединение закрыто раньше времени (code=${e.code}${e.reason ? `, ${e.reason}` : ""}${
            handshakeSeen ? ", рукопожатие было" : ", рукопожатия не было"
          })`,
        );
      }
      done();
    });

    ws.addEventListener("message", (event) => {
      const data = String(event.data);

      if (data.startsWith("0{")) {
        handshakeSeen = true;
        log.debug(SCOPE, "handshake", data.slice(0, 120));
        ws.send(
          `40${NS}?userId=${creds.id}&authKey=${encodeURIComponent(creds.authKey)}&intention=game_search`,
        );
        return;
      }
      if (data === "2") {
        ws.send("3");
        return;
      }
      if (!data.startsWith(`42${NS},`)) return;

      let payload: [string, unknown];
      try {
        payload = JSON.parse(data.slice(`42${NS},`.length));
      } catch {
        return;
      }
      const [name, body] = payload;
      seen.push(name);

      if (name === "session_initialized") {
        ws.send(
          `42${NS},${JSON.stringify([
            "start_game_search",
            {
              gameMode: "league",
              role: "player",
              userId: creds.id,
              authKey: creds.authKey,
              censorship: [mode],
            },
          ])}`,
        );
        searchStarted = true;
        return;
      }

      // Ответ на нашу заявку. При отказе состояние очереди НЕ придёт — без
      // этой ветки мы просто ждали таймаут и показывали «сервер не ответил».
      if (name === "on_start_game_search") {
        const r = (body || {}) as {
          success?: boolean;
          illegalState?: string;
          message?: string;
          reason?: string;
        };
        if (r.success) return; // ждём on_game_search_state
        searchStarted = false;
        const why =
          r.illegalState === "game_search"
            ? "аккаунт уже числится в поиске"
            : r.illegalState === "in_game"
              ? "аккаунт числится в игре"
              : r.message === "no access to league"
                ? "нет доступа к лиге (нужна верификация аккаунта)"
                : r.message === "ban_is_still_active"
                  ? "действует ограничение на поиск"
                  : r.message === "game_search_disabled"
                    ? "поиск игр временно отключён"
                    : r.message || r.reason || "сервер отклонил заявку";
        if (r.illegalState === "game_search") {
          // Похоже, прошлый заход не был закрыт до конца — просим выйти,
          // чтобы следующая попытка сработала.
          try {
            ws.send(`42${NS},["stop_game_search"]`);
          } catch {
            /* сокет мёртв */
          }
        }
        // Повтор осмыслен только когда отказ мог зависеть от очереди
        // (bad_request на недоступный режим). Запреты уровня аккаунта —
        // «уже в поиске», «в игре», бан, отключённый поиск — не повторяем.
        const retryable =
          !r.illegalState && r.message !== "ban_is_still_active" && r.message !== "game_search_disabled";
        failure = new PeekError(why, retryable);
        done();
        return;
      }

      if (name === "connection_refused") {
        searchStarted = false;
        failure = new PeekError("сервер отклонил подключение");
        done();
        return;
      }

      if (name === "on_game_found" || name === "redirect_to_game") {
        // Отменить создание игры мы не можем — сайт уведёт в неё сам.
        // Единственное, что в наших силах: не мешать и честно сказать.
        log.warn(SCOPE, "во время разведки собралась игра");
        leave(new PeekError("во время разведки собралась игра — сайт переведёт вас в неё"));
        return;
      }

      if (name === "on_stop_game_search") {
        done();
        return;
      }

      if (name === "on_game_search_state") {
        const queues = (body as { queues?: Record<string, QueueInfo> })?.queues;
        if (queues) result = queues;
        leave();
      }
    });
  });
}

/**
 * @param peeked были ли мы в очереди. Пока не были, число вместо списка —
 *   это просто публичный счётчик, а НЕ признак отсутствия Pro; путать эти
 *   два случая нельзя, иначе панель врёт про подписку.
 */
function renderPanel(
  queues: Record<string, QueueInfo>,
  note?: string,
  exited = false,
  peeked = false,
): void {
  panel?.remove();
  panel = document.createElement("div");
  panel.style.cssText = `
    position: fixed; z-index: 2147483600;
    width: 320px; max-height: 60vh; overflow-y: auto;
    background: #161c2c; color: #e6e9f0; border: 1px solid rgba(255,255,255,.12);
    border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
    font: 13px/1.4 system-ui, sans-serif; padding: 12px 14px;
  `;

  const rows = Object.keys(MODE_TITLES)
    .map((mode) => {
      const info = queues[mode];
      const title = MODE_TITLES[mode];
      if (!info) return `<div style="margin:8px 0;color:#8b93a7">${title}: нет данных</div>`;
      const players = info.players;
      if (!Array.isArray(players)) {
        const why = peeked ? " (поимённо — только с Pro)" : "";
        return `<div style="margin:8px 0"><b>${title}</b>: ${Number(players) || 0} чел.<span style="color:#8b93a7">${why}</span></div>`;
      }
      if (players.length === 0) return `<div style="margin:8px 0"><b>${title}</b>: пусто</div>`;
      const list = players
        .map((p) => {
          const name = escapeHtml(String(p.username || p.id || "?"));
          const mmr = p.mmr ? ` <span style="color:#8b93a7">${escapeHtml(String(p.mmr))}</span>` : "";
          return `<div style="padding:2px 0">${name}${mmr}</div>`;
        })
        .join("");
      return `<div style="margin:8px 0"><b>${title}</b> — ${players.length}:<div style="margin-top:4px">${list}</div></div>`;
    })
    .join("");

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <b style="flex:1">Кто в очереди</b>
      <button data-close style="background:transparent;border:none;color:#e6e9f0;cursor:pointer;font-size:15px">✕</button>
    </div>
    ${note ? `<div style="color:#f59e0b;margin-bottom:6px">${escapeHtml(note)}</div>` : ""}
    ${rows}
    <div style="color:#8b93a7;margin-top:8px;font-size:11px">Снимок на момент нажатия.${
      exited ? " Выход из очереди подтверждён сервером." : ""
    }</div>
  `;
  panel.querySelector("[data-close]")?.addEventListener("click", () => {
    panel?.remove();
    panel = null;
  });
  document.body.appendChild(panel);

  // Привязываем к кнопке, а не к углу экрана: кнопка теперь в панели поиска,
  // и оторванный от неё результат читался бы как чужой элемент. Позицию
  // зажимаем в границы окна, чтобы список не уехал за экран.
  const anchor = button?.getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  const margin = 8;
  let left = anchor ? anchor.left : window.innerWidth - rect.width - 16;
  let top = anchor ? anchor.bottom + margin : 64;
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
  if (top + rect.height > window.innerHeight - margin) {
    // Под кнопкой не помещается — показываем над ней.
    top = anchor ? Math.max(margin, anchor.top - rect.height - margin) : margin;
  }
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

/**
 * @param auto запуск НЕ по клику игрока (автозаход при открытии страницы).
 *   Автозаход строго осторожнее ручного: игрока может не быть у экрана, а в
 *   фоновой вкладке браузер душит таймеры — там наш выход из очереди
 *   задержался бы (тот же механизм, что описан в
 *   docs/queue-timeout-report.md). Поэтому вместо вопроса «всё равно зайти?»
 *   мы просто НЕ заходим в занятую очередь.
 */
async function runPeek(auto = false): Promise<void> {
  if (running) return;
  // Кнопка могла пережить SPA-переход — на чужой странице не работаем.
  if (!isSearchPage()) return;
  const blocked = blockedReason();
  if (blocked) {
    // Автозаход молчит: незапрошенная всплывашка в момент старта поиска
    // только пугает.
    if (!auto) renderPanel({}, blocked);
    return;
  }
  const modes = enabledModes();
  if (modes.length === 0) {
    renderPanel({}, "В настройках не выбрано ни одной очереди для разведки.");
    return;
  }

  running = true;
  peekCancelled = false;
  if (button) {
    button.disabled = true;
    button.textContent = "Смотрю…";
  }

  try {
    // Креды читаем ДО замера счётчиков: между замером и входом должно быть
    // как можно меньше времени.
    const creds = await readCredentials();
    if (!creds) {
      renderPanel({}, "Не удалось прочитать данные аккаунта.");
      return;
    }

    const counts = await fetchQueueCounts();
    if (!counts) {
      renderPanel({}, "Не удалось получить счётчики очередей.");
      return;
    }
    // По флагу `available` НЕ фильтруем: публичный /api/search отдаёт
    // available:false сразу для всех трёх очередей даже у Pro-аккаунта,
    // который спокойно в них ищет (проверено живьём). Раньше этот фильтр
    // отбрасывал всё, разведка не запускалась вовсе, и панель показывала
    // одни счётчики с ложной припиской про Pro.
    const candidates = modes
      .filter((mode) => counts[mode] && modeAllowed(mode, creds))
      .sort((a, b) => countOf(counts[a]) - countOf(counts[b]));
    if (candidates.length === 0) {
      renderPanel(
        counts,
        "Нет доступной очереди для захода: «Рейтинг» требует Pro, «Prime» — членства Prime.",
      );
      return;
    }

    // Не больше двух заходов: дальше это уже не «на секунду».
    const attempts = candidates.slice(0, 2);
    let lastError: Error | null = null;

    for (const mode of attempts) {
      // Перед КАЖДЫМ заходом (не только первым) проверяем всё заново:
      // отмену, свежий счётчик, порог и собственный поиск игрока. Раньше
      // вторая попытка входила по данным десятисекундной давности и без
      // подтверждения — могла молча зайти в почти полную очередь.
      if (peekCancelled) return;
      if (blockedReason()) {
        renderPanel({}, "Состояние поиска изменилось — разведка отменена.");
        return;
      }

      const fresh = await fetchQueueCounts();
      // Fail-CLOSED: без свежего счётчика мы не знаем размер очереди, а
      // `countOf(undefined) === 0` тихо отключил бы порог WARN_AT — главный
      // предохранитель фичи — и мы вошли бы в девятиместную очередь молча.
      if (!fresh) {
        renderPanel(counts, "Не удалось перечитать счётчик очереди — вход отменён.");
        return;
      }
      const freshCount = countOf(fresh[mode]);
      if (freshCount > WARN_AT && auto) {
        // Автозаход не спрашивает — он отступает: диалог на загрузке страницы
        // и так неуместен, а «согласие» некому дать, если игрок отошёл.
        renderPanel(
          fresh,
          `В самой свободной очереди уже ${freshCount} игроков — автопросмотр не заходил, показаны счётчики.`,
        );
        return;
      }
      if (freshCount > WARN_AT) {
        const ok = window.confirm(
          `В очереди «${MODE_TITLES[mode] || mode}» уже ${freshCount} игроков из 10.\n\n` +
            "Если во время разведки наберётся десять, игра соберётся и сайт сам переведёт вас в неё — " +
            "выйти из собранной игры нельзя без штрафа.\n\nВсё равно посмотреть?",
        );
        if (!ok) return;
        // Пока показывался диалог, очередь могла дорасти — сверяемся ещё раз.
        // Тоже fail-closed: нет ответа — не заходим.
        const afterDialog = await fetchQueueCounts();
        if (!afterDialog) {
          renderPanel(fresh, "Не удалось перепроверить счётчик — вход отменён.");
          return;
        }
        const afterCount = countOf(afterDialog[mode]);
        if (afterCount > freshCount) {
          renderPanel(afterDialog, `Пока вы думали, очередь выросла до ${afterCount} — вход отменён.`);
          return;
        }
      }
      if (peekCancelled || blockedReason()) return;

      // Стоп-кран взводим ВПЛОТНУЮ к сетевой части: раньше он висел на всё
      // время диалогов и успевал истечь по сторожевому таймеру.
      setAutoAcceptSuppressed(true);
      try {
        const queues = await peekOnce(creds, mode);
        renderPanel(queues, undefined, true, true);
        log.info(SCOPE, "снимок очередей получен через", mode);
        return;
      } catch (e) {
        lastError = e as Error;
        // Повтор только там, где виновата конкретная очередь. Отмена и
        // запреты уровня аккаунта («уже в поиске», «в игре», бан, собралась
        // игра) прекращают всё немедленно.
        // Отмена — тихий выход: панель «Не получилось» после disable() висела
        // бы на странице уже после разборки фичи, а при клике «Играть» пугала
        // бы всплывашкой ровно в момент старта поиска.
        if (peekCancelled) return;
        if (!(lastError instanceof PeekError) || !lastError.retryable) break;
        log.debug(SCOPE, "очередь", mode, "не подошла:", lastError.message);
      } finally {
        setAutoAcceptSuppressed(false);
      }
    }
    throw lastError || new PeekError("не удалось получить состав");
  } catch (e) {
    log.error(SCOPE, "peek failed", (e as Error)?.message || "unknown");
    renderPanel({}, `Не получилось: ${(e as Error).message}`);
  } finally {
    abortCurrent = null;
    registerPeekAbort(null);
    running = false;
    if (button) {
      button.disabled = false;
      button.textContent = BUTTON_LABEL;
    }
  }
}

/**
 * Автозаход при открытии страницы поиска.
 *
 * Три условия, которых нет у ручного запуска:
 *  • один раз на загрузку страницы (никаких повторов по таймеру);
 *  • только когда вкладка ВИДНА — в скрытой браузер душит таймеры, и наш
 *    выход из очереди может задержаться на десятки секунд (тот же механизм,
 *    что в docs/queue-timeout-report.md); открыли в фоне — ждём показа;
 *  • пауза перед стартом: даём странице отрисоваться, а игроку — шанс сразу
 *    нажать «Играть» (тогда автозаход отменится сам).
 */
const AUTO_PEEK_DELAY_MS = 1500;
let autoPeekDone = false;
let autoPeekTimer: ReturnType<typeof setTimeout> | null = null;
let autoVisibilityListener: (() => void) | null = null;

function scheduleAutoPeek(): void {
  if (autoPeekDone || autoPeekTimer || autoVisibilityListener) return;

  const start = () => {
    autoPeekTimer = null;
    if (autoPeekDone) return;
    // Вкладку спрятали внутри паузы — не сжигаем попытку, а ждём показа
    // (иначе автозаход тихо терялся, хотя обещали «дождёмся видимой»).
    if (document.hidden) {
      scheduleAutoPeek();
      return;
    }
    autoPeekDone = true;
    // Ещё раз сверяемся: за паузу игрок мог сам встать в очередь или уйти.
    if (!isSearchPage() || blockedReason()) return;
    void runPeek(true);
  };

  if (document.hidden) {
    autoVisibilityListener = () => {
      if (document.hidden || autoPeekDone) return;
      if (autoVisibilityListener) {
        document.removeEventListener("visibilitychange", autoVisibilityListener);
        autoVisibilityListener = null;
      }
      autoPeekTimer = setTimeout(start, AUTO_PEEK_DELAY_MS);
    };
    document.addEventListener("visibilitychange", autoVisibilityListener);
    return;
  }
  autoPeekTimer = setTimeout(start, AUTO_PEEK_DELAY_MS);
}

function cancelAutoPeek(): void {
  if (autoPeekTimer) {
    clearTimeout(autoPeekTimer);
    autoPeekTimer = null;
  }
  if (autoVisibilityListener) {
    document.removeEventListener("visibilitychange", autoVisibilityListener);
    autoVisibilityListener = null;
  }
}

const BUTTON_CLASS = "pn-queue-peek-button";
/** Один источник надписи: finally восстанавливал другой текст, и после
 * первого нажатия кнопка навсегда меняла ширину в ряду с «Играть». */
const BUTTON_LABEL = "👀 Очередь";

/**
 * Кнопка живёт в панели поиска — рядом с галочками очередей и «Играть»
 * (просьба владельца; фиксированная в углу экрана мешала).
 *
 * Панель перерисовывается Vue, поэтому вставку повторяем из общего
 * наблюдателя. Запись идемпотентна (инвариант AGENTS.md §4 п.1): если наша
 * кнопка уже на месте в этой панели — не трогаем ничего.
 */
function ensureButton(): void {
  if (!isSearchPage()) return;
  const panel = document.querySelector<HTMLElement>(SITE.searchPanel);
  if (!panel) return;
  const existing = panel.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`);
  if (existing) {
    button = existing;
    syncButtonVisibility();
    return;
  }

  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;
  btn.type = "button";
  btn.textContent = BUTTON_LABEL;
  btn.title = "Показать, кто сейчас ищет игру";
  /**
   * Панель — flex-ряд (галочки | «Играть» | мы). Соседи объявлены `flex: 1 1
   * auto` и делят свободное место, поэтому без явного `flex: 0 0 auto` наша
   * кнопка растягивалась на пол-экрана. Ширину задаём содержимым.
   */
  btn.style.cssText = `
    flex: 0 0 auto; align-self: stretch; margin-left: 8px; white-space: nowrap;
    background: rgba(255,255,255,.06); color: #cfd6e6;
    border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
    padding: 0 14px; cursor: pointer; font: 600 13px system-ui, sans-serif;
  `;
  btn.addEventListener("click", () => void runPeek());

  // Сразу под кнопкой «Играть», если она есть; иначе в конец панели.
  const playWrap = panel.querySelector<HTMLElement>(SITE.searchPlayWrap);
  if (playWrap && playWrap.parentElement === panel) {
    playWrap.insertAdjacentElement("afterend", btn);
  } else {
    panel.appendChild(btn);
  }
  button = btn;
  syncButtonVisibility();
}

/**
 * Кнопка видна только там, где разведка вообще разрешена (blockedReason):
 * свой поиск, собранная игра, отсутствие «Играть» — всё это состояния, где
 * нажатие может лишь показать отказ, а вид кнопки сбивает с толку.
 *
 * Запись строго идемпотентна — функция вызывается из общего наблюдателя
 * DOM, а безусловная правка style стала бы самоподдерживающимся циклом
 * (инвариант AGENTS.md §4 п.1).
 */
function syncButtonVisibility(): void {
  if (!button) return;
  const want = blockedReason() ? "none" : "";
  if (button.style.display !== want) button.style.display = want;
}

export const queuePeekFeature: Feature = {
  id: "queue-peek",
  settingKey: "queue_peek_enabled",
  enable(ctx: FeatureContext) {
    settings = ctx.settings;
    // Слушатели вешаем ВСЕГДА, даже вне страницы поиска: FeatureManager
    // повторно enable() не зовёт, а на страницу поиска можно прийти
    // SPA-переходом (это и есть типичный путь). Раньше в таком случае не было
    // ни кнопки, ни автозахода — фича работала только по F5.
    ensureButton();
    unsubscribeDom = onDomChange(() => {
      // Панель поиска перерисовывается Vue (смена галочек, старт/стоп поиска)
      // — возвращаем кнопку на место. Вставка идемпотентна, цикла не будет.
      ensureButton();
      if (settings?.queue_peek_auto && isSearchPage()) scheduleAutoPeek();
    });
    // Уход со страницы посреди разведки: выходим из очереди явно, не полагаясь
    // на то, что сервер заметит обрыв (по замеру он держит сессию до 45с).
    pageHideListener = () => {
      cancelAutoPeek();
      autoPeekDone = true;
      cancelPeek("уход со страницы");
    };
    window.addEventListener("pagehide", pageHideListener);

    /**
     * СВОЙ перехват клика «Играть». Полагаться на releaseForUserAction из
     * search.ts нельзя: та фича гейтится настройкой auto_accept_enabled, и у
     * игрока с выключенным автопринятием прерывания не было вовсе — наш
     * запоздалый выход снимал бы его с только что начатого поиска.
     * Capture-фаза: успеваем до обработчиков сайта.
     */
    playClickListener = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.(SITE.profileSearchButton)) return;
      // Отменяем И запланированный автозаход: cancelPeek выходит рано, пока
      // разведка ещё не запущена, и без этих двух строк клик в течение паузы
      // не оставлял следа — таймер срабатывал и лез в очередь поверх поиска,
      // который игрок только что начал.
      cancelAutoPeek();
      autoPeekDone = true;
      cancelPeek("игрок начал поиск сам");
    };
    document.addEventListener("click", playClickListener, true);

    if (settings?.queue_peek_auto && isSearchPage()) scheduleAutoPeek();
  },
  update(ctx: FeatureContext) {
    settings = ctx.settings;
  },
  disable() {
    // Сначала выйти из очереди, потом всё остальное.
    cancelPeek("фича выключена");
    cancelAutoPeek();
    autoPeekDone = false;
    registerPeekAbort(null);
    if (playClickListener) {
      document.removeEventListener("click", playClickListener, true);
      playClickListener = null;
    }
    if (pageHideListener) {
      window.removeEventListener("pagehide", pageHideListener);
      pageHideListener = null;
    }
    if (unsubscribeDom) {
      unsubscribeDom();
      unsubscribeDom = null;
    }
    // Чистим по классу: ссылка могла указывать на кнопку, которую Vue уже снёс
    // вместе с перерисованной панелью.
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
    button = null;
    panel?.remove();
    panel = null;
    setAutoAcceptSuppressed(false);
    running = false;
  },
};
