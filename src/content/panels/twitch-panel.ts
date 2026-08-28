/**
 * Фича: плавающая панель Twitch-чата на игровой странице.
 * Порт twitch-chat-panel.js (917 строк) на новую TS-архитектуру.
 *
 * Подключается к Twitch IRC через анонимный WebSocket
 * (wss://irc-ws.chat.twitch.tv:443, PASS SCHMOOPIIE, NICK justinfanXXXXX),
 * вступает в канал #<twitch_channel_name>, парсит PRIVMSG и показывает
 * последние сообщения в маленькой плавающей панели поверх игры.
 *
 * Базовая механика панели (drag / resize / persist позиции и размера) —
 * в @core/FloatingPanel, здесь НЕ дублируется (storageKey "twitch-panel").
 *
 * Управление:
 *  • settingKey "twitch_chat_enabled" — вкл/выкл фичи (FeatureManager).
 *  • ctx.settings.twitch_channel_name — имя канала; смена через update(ctx)
 *    приводит к переподключению к новому каналу.
 *  • команды popup через onMessage (TwitchControlMsg): show/hide/toggle,
 *    twitch_connect (с channel), twitch_disconnect.
 *
 * Панель видна только при активном игровом интерфейсе — состояние
 * отслеживается через общий onDomChange (как в оригинале — MutationObserver).
 */
import { browser } from "@core/env";
import { FloatingPanel } from "@core/FloatingPanel";
import { onDomChange } from "@core/dom";
import { escapeHtml } from "@core/escape";
import {
  applyChrome,
  buildGearMenu,
  buildHoverStrip,
  buildUnlockChip,
  CHROME_DEFAULTS,
  menuCheck,
  menuHint,
  menuRange,
  menuRow,
  menuSegmented,
  menuSelect,
  ownField,
  readPanelPrefsRaw,
  sanitizeChromePrefs,
  savePanelPrefs,
  type ChromePrefs,
} from "@core/panel-chrome";
import { log } from "@core/log";
import { onMessage, sendRuntime } from "@core/messaging";
import { SITE } from "@core/selectors";
import { isGameRoomPath } from "@shared/routes";
import type { Feature, FeatureContext } from "@core/feature";
import type { TwitchControlMsg } from "@shared/types";

const SCOPE = "twitch";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
/** Максимум хранимых сообщений. */
const MAX_MESSAGES = 200;
/** Базовая задержка переподключения. */
const RECONNECT_DELAY = 5000;
/** Потолок попыток: опечатка в имени канала не должна долбить IRC вечно. */
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectAttempts = 0;

interface ChatMessage {
  username?: string;
  /** Цвет ника из IRC-тега color (проверенный #rrggbb) либо undefined. */
  color?: string;
  /** Эмодзи-префиксы бейджей (мод/вип/саб/стример) — наши константы. */
  badges?: string[];
  message: string;
  timestamp: Date;
  type: "chat" | "system";
  /** Сообщение упоминает @канал — подсветить. */
  mention?: boolean;
  /**
   * Ключ обновляемой системной строки: следующее сообщение с тем же ключом
   * не добавляет строку, а переписывает эту. «Подключаемся…» → «Подключились»
   * — один шаг одного события, а не две строки (просьба владельца 27.08.2026).
   */
  systemKey?: string;
}

/** Ключи обновляемых системных строк. */
const SYS_CONNECT = "connect";

// ─────────────── пер-устройство настройки вида панели ───────────────

/**
 * Живут в localStorage СТРАНИЦЫ рядом с позицией панели (fp:*): это визуальные
 * предпочтения конкретного устройства, как и позиция окна. ВНИМАНИЕ: страница
 * принадлежит сайту, источник недоверенный — каждое поле санитизируется при
 * чтении (см. карту хранилища в AGENTS.md §5).
 */
interface PanelPrefs extends ChromePrefs {
  timestamps: boolean;
  highlightMentions: boolean;
  /** Сколько последних сообщений видно (окно чата; остальное — скроллом). */
  visibleCount: number;
}

const PREFS_KEY = "fp:twitch-panel:prefs";
const DEFAULT_PREFS: PanelPrefs = {
  ...CHROME_DEFAULTS,
  timestamps: true,
  highlightMentions: true,
  visibleCount: 10,
};
const FONT_PX = { s: 11, m: 12.5, l: 14 } as const;
const VISIBLE_VARIANTS = [3, 5, 10, 25, 50] as const;

/**
 * Экспорт — тестовый шов: property-тесты page-storage-trust кормят парсер
 * враждебным localStorage (по паттерну noteTrustedInput в queue-requeue.ts).
 *
 * Каждое поле читается только как СОБСТВЕННОЕ (Object.hasOwn): раньше доступ
 * через точку шёл по цепочке прототипов, и унаследованное поле подходящего
 * типа (например, clickThrough: true на Object.prototype) проходило схему как
 * выбор пользователя (аудит хрупкости 06.08.2026). JSON.parse прототип не
 * подменяет, но парсер обязан быть безопасен сам по себе, а не за счёт
 * предположений о вызывающем.
 */
export function loadPrefs(): PanelPrefs {
  const raw = readPanelPrefsRaw(PREFS_KEY);
  const d = DEFAULT_PREFS;
  const visibleCount = ownField(raw, "visibleCount");
  return {
    ...sanitizeChromePrefs(raw, d),
    timestamps: ownField(raw, "timestamps") !== false,
    highlightMentions: ownField(raw, "highlightMentions") !== false,
    visibleCount: (VISIBLE_VARIANTS as readonly number[]).includes(visibleCount as number)
      ? (visibleCount as number)
      : d.visibleCount,
  };
}

function savePrefs(p: PanelPrefs): void {
  savePanelPrefs(PREFS_KEY, p);
}

// ─────────────── история чата поверх перезагрузки ───────────────

/**
 * Анонимный IRC Twitch бэклога не отдаёт: после F5 приходят только новые
 * сообщения, и стример терял контекст разговора (просьба владельца
 * 26.08.2026). Буфер панели поэтому сохраняется в sessionStorage ВКЛАДКИ:
 * переживает перезагрузку и жёсткие переходы в той же вкладке, а с её
 * закрытием испаряется — вчерашний чат не воскресает, и сообщения зрителей
 * не оседают на диске навсегда (в отличие от localStorage).
 *
 * sessionStorage принадлежит странице — источник недоверенный, как и prefs
 * выше: каждое поле при чтении санитизируется заново (карта хранилища,
 * AGENTS.md §5). Цвет уходит в inline-style, бейджи в HTML — поэтому цвет
 * строго #rrggbb, бейджи только из нашего словаря BADGE_ICONS.
 */
const HISTORY_KEY = "fp:twitch-panel:history";
/** Потолок длины одного сообщения при сохранении (IRC-строка и так ~500). */
export const HISTORY_MSG_MAX = 600;
/** Сырой JSON больше этого — мусор или атака на парсер, не читаем вовсе. */
const HISTORY_RAW_MAX = 400_000;
/** Дроссель записи: чат строчит часто, диск дёргаем не чаще раза в 2 с. */
const HISTORY_SAVE_MS = 2000;

/** Бейджи → наши эмодзи-префиксы (константы, в HTML попадают только они). */
const BADGE_ICONS: Record<string, string> = {
  broadcaster: "🎥",
  moderator: "🛡",
  vip: "💎",
  subscriber: "★",
  founder: "★",
};

/** Известные значки бейджей — единственные строки, допущенные в HTML. */
const KNOWN_BADGES = new Set(Object.values(BADGE_ICONS));

/**
 * Сериализация буфера. Системные строки («Подключились…») не сохраняем:
 * после восстановления они врали бы о состоянии соединения — шов истории
 * отмечает отдельный разделитель при восстановлении.
 */
export function serializeChatHistory(channel: string, messages: ChatMessage[]): string {
  let chat = messages
    .filter((m) => m.type === "chat")
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      username: (m.username ?? "").slice(0, 100),
      color: m.color,
      badges: m.badges?.filter((b) => KNOWN_BADGES.has(b)).slice(0, 5),
      // Управляющие символы выбрасываются: JSON экранирует их в \uXXXX (×6),
      // и спам из ctrl-байтов раздувал сохранённое за потолок чтения — после
      // F5 восстановление молча отказывало ЦЕЛИКОМ (adversarial 26.08.2026).
      message: m.message.replace(/[\u0000-\u001f]/g, "").slice(0, HISTORY_MSG_MAX),
      timestamp: m.timestamp.getTime(),
      mention: m.mention === true,
    }));
  // Симметрия «что сохранили — то и восстановим»: итог обязан пролезать в
  // HISTORY_RAW_MAX парсера. Перебор — выкидываем старейшую четверть.
  let raw = JSON.stringify({ channel, messages: chat });
  while (raw.length > HISTORY_RAW_MAX && chat.length > 0) {
    chat = chat.slice(Math.max(1, Math.ceil(chat.length / 4)));
    raw = JSON.stringify({ channel, messages: chat });
  }
  return raw;
}

/**
 * Парсер восстановления. Экспорт — тестовый шов: property-тесты кормят его
 * враждебным содержимым (по паттерну loadPrefs). Битая запись отбрасывается
 * ЦЕЛИКОМ, а не «чинится»: недоверенному вводу полусмысла не даём.
 */
export function parseChatHistory(raw: string | null, channel: string): ChatMessage[] {
  if (!raw || raw.length > HISTORY_RAW_MAX || !channel) return [];
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const own = (o: object, k: string): unknown =>
    Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
  // История чужого канала не подмешивается: сменили канал — начали с чистого.
  if (own(data, "channel") !== channel) return [];
  const list = own(data, "messages");
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  const out: ChatMessage[] = [];
  for (const item of list.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const username = own(item, "username");
    const message = own(item, "message");
    const timestamp = own(item, "timestamp");
    if (typeof username !== "string" || username.length > 100 || !username.trim()) continue;
    if (typeof message !== "string" || message.length > HISTORY_MSG_MAX) continue;
    // Метка из будущего или доисторическая — запись битая, не «поправимая».
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
    if (timestamp <= 0 || timestamp > now + 60_000) continue;
    const rawColor = own(item, "color");
    const rawBadges = own(item, "badges");
    out.push({
      username,
      message,
      color: typeof rawColor === "string" && /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : undefined,
      badges: Array.isArray(rawBadges)
        ? // Дедуп — как в живом parseBadges: пять «★» подряд из враждебного
          // хранилища рисовали бы фальшивую важность зрителя.
          [...new Set(rawBadges.filter((b): b is string => typeof b === "string" && KNOWN_BADGES.has(b)))].slice(0, 5)
        : undefined,
      mention: own(item, "mention") === true,
      timestamp: new Date(timestamp),
      type: "chat",
    });
  }
  return out;
}

function loadChatHistory(channel: string): ChatMessage[] {
  try {
    return parseChatHistory(sessionStorage.getItem(HISTORY_KEY), channel);
  } catch {
    return []; // приватный режим — sessionStorage может кидаться
  }
}

function saveChatHistoryNow(channel: string, messages: ChatMessage[]): void {
  try {
    sessionStorage.setItem(HISTORY_KEY, serializeChatHistory(channel, messages));
  } catch {
    /* квота / приватный режим — история просто не переживёт перезагрузку */
  }
}

function clearChatHistory(): void {
  try {
    sessionStorage.removeItem(HISTORY_KEY);
  } catch {
    /* см. выше */
  }
}

/** Дефолтная палитра цветов ников Twitch — когда стример не выбрал свой. */
const NICK_COLORS = [
  "#FF4500",
  "#2E8B57",
  "#DAA520",
  "#D2691E",
  "#5F9EA0",
  "#1E90FF",
  "#FF69B4",
  "#9ACD32",
  "#00FF7F",
  "#B22222",
  "#FF7F50",
  "#8A2BE2",
] as const;

function fallbackNickColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return NICK_COLORS[Math.abs(h) % NICK_COLORS.length];
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Детекция активного игрового интерфейса (порт hasActiveGameInterface). */
/**
 * Где живёт чат: «везде на сайте» (по умолчанию) или «только в игре».
 * Просьба владельца 16.08.2026: стример вне игры (поиск, лобби, профиль)
 * чата не видел, хотя со зрителями разговаривает и там. Режим «только в игре»
 * — прежнее поведение, оставлен как выбор.
 */
export type ChatScope = "site" | "game";
let chatScope: ChatScope = "site";

/** Тестовый шов. */
export function setChatScope(scope: ChatScope): void {
  chatScope = scope;
}

/**
 * Чату здесь место? Единый гейт вместо четырёх route-проверок: в режиме
 * «везде» — любая страница сайта (мы и так инжектимся только на него),
 * в режиме «только игра» — комната с живым игровым UI, как раньше.
 */
export function chatBelongsHere(input: {
  scope: ChatScope;
  pathname: string;
  gameUi: boolean;
}): boolean {
  if (input.scope === "site") return true;
  return isGameRoomPath(input.pathname) && input.gameUi;
}

function hasActiveGameInterface(): boolean {
  const playerCount = document.querySelectorAll(SITE.playerDesktop).length;
  const webcamCount = document.querySelectorAll(SITE.playerVideo).length;
  const gameControlCount = document.querySelectorAll(SITE.obsGameControls).length;

  return (
    (playerCount >= 10 ||
      webcamCount >= 10 ||
      (playerCount >= 8 && webcamCount >= 8)) &&
    gameControlCount > 0
  );
}

// ─────────────────────────── панель ───────────────────────────

class TwitchChatPanel extends FloatingPanel {
  private messagesEl: HTMLElement | null = null;
  private messages: ChatMessage[] = [];
  private prefs: PanelPrefs = loadPrefs();
  /** Пользователь у нижнего края чата (автоскролл включён). */
  private atBottom = true;
  /** Непрочитанные, пока пользователь листает историю. */
  private unseen = 0;
  private newBtn: HTMLElement | null = null;
  private gearMenu: HTMLElement | null = null;
  private hoverStrip: HTMLElement | null = null;
  private unlockChip: HTMLElement | null = null;

  /** Панель смонтирована и видима (не hide()). */
  get isShown(): boolean {
    return this.isMounted && this.root.style.display !== "none";
  }

  // ── история поверх перезагрузки ──

  private historyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Дроссельная запись буфера в sessionStorage (trailing — финал не теряется). */
  private scheduleHistorySave(): void {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      saveChatHistoryNow(channelName, this.messages);
    }, HISTORY_SAVE_MS);
  }

  /** Немедленная запись: pagehide/disable могут не дождаться дросселя. */
  flushHistoryNow(): void {
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    saveChatHistoryNow(channelName, this.messages);
  }

  /**
   * Засеять буфер восстановленной историей. Только в пустую панель и до
   * живого чата: сеять поверх пришедших сообщений значит перемешать порядок.
   */
  seedHistory(restored: ChatMessage[]): void {
    if (restored.length === 0 || this.messages.length > 0) return;
    this.messages = [
      // Вместе с разделителем — ровно MAX_MESSAGES: буфер в 201 строку
      // навсегда ломал инвариант размера (shift снимает по одному).
      ...restored.slice(-(MAX_MESSAGES - 1)),
      { message: "⟲ история восстановлена", timestamp: new Date(), type: "system" },
    ];
    this.renderMessages();
  }

  /**
   * Смена канала: буфер и сохранённая история старого канала обнуляются —
   * иначе следующая запись увезла бы чужие сообщения под ключ нового канала.
   */
  resetForChannel(): void {
    this.messages = [];
    this.unseen = 0;
    this.atBottom = true;
    this.renderMessages();
    this.flushHistoryNow();
  }

  constructor() {
    super({
      storageKey: "twitch-panel",
      title: "Twitch Chat",
      width: 280,
      height: 180,
      minWidth: 220,
      minHeight: 120,
      resizable: true,
      className: "twitch-chat-panel",
    });
  }

  protected renderBody(body: HTMLElement): void {
    this.addHeaderButton("⚙", () => this.toggleGearMenu(), "Настройки панели");
    // Кнопка закрытия в заголовке: прячет панель и выключает фичу в настройках.
    this.addHeaderButton(
      "×",
      () => {
        twitchPanelFeature.requestClose();
      },
      "Закрыть",
    );

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      position: "relative",
    } as CSSStyleDeclaration);

    const messagesEl = document.createElement("div");
    messagesEl.className = "twitch-chat-messages";
    Object.assign(messagesEl.style, {
      flex: "1",
      overflowY: "auto",
      padding: "6px",
      background: "rgba(0,0,0,.12)",
      borderRadius: "8px",
    } as CSSStyleDeclaration);
    messagesEl.addEventListener("scroll", () => {
      const nearBottom =
        messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 24;
      if (nearBottom === this.atBottom) return;
      this.atBottom = nearBottom;
      if (nearBottom) this.unseen = 0;
      this.updateNewBtn();
    });

    // «↓ N новых» — появляется, когда листаешь историю, а чат живёт дальше.
    const newBtn = document.createElement("button");
    Object.assign(newBtn.style, {
      position: "absolute",
      bottom: "6px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "none",
      padding: "3px 10px",
      border: "none",
      borderRadius: "10px",
      background: "rgba(99,102,241,.9)",
      color: "#fff",
      font: "600 11px system-ui, sans-serif",
      cursor: "pointer",
      zIndex: "3",
    } as CSSStyleDeclaration);
    newBtn.addEventListener("click", () => {
      this.atBottom = true;
      this.unseen = 0;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      this.updateNewBtn();
    });

    wrap.append(messagesEl, newBtn);
    body.appendChild(wrap);

    this.messagesEl = messagesEl;
    this.newBtn = newBtn;

    this.buildHoverStrip();
    this.buildUnlockChip();
    this.buildGearMenu();
    this.applyChrome();
    this.renderMessages();
  }

  // ── добавление сообщений ──

  addChatMessage(
    username: string,
    message: string,
    extra?: { color?: string; badges?: string[] },
  ): void {
    // Граница слова обязательна: `@foo` не должен подсвечиваться в `@foobar`
    // (ники твича — [a-z0-9_], поэтому проверка следующего символа достаточна).
    const lower = message.toLowerCase();
    const needle = `@${channelName.toLowerCase()}`;
    let mention = false;
    if (channelName) {
      let from = 0;
      while (!mention) {
        const i = lower.indexOf(needle, from);
        if (i === -1) break;
        const next = lower[i + needle.length];
        if (!next || !/[a-z0-9_]/.test(next)) mention = true;
        from = i + 1;
      }
    }
    this.messages.push({
      username,
      message,
      color: extra?.color,
      badges: extra?.badges,
      mention,
      timestamp: new Date(),
      type: "chat",
    });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    if (!this.atBottom) this.bumpUnseen();
    this.appendLastMessage();
    this.scheduleHistorySave();
  }

  /**
   * Системная строка. С `key` — обновляемая: если ПОСЛЕДНЯЯ строка окна имеет
   * тот же ключ, она переписывается на месте, а не дублируется ниже.
   *
   * Обновляем только последнюю: строка, ушедшая вверх под чужие сообщения,
   * уже прочитана в своём контексте, и менять её задним числом — врать про
   * порядок событий.
   */
  addSystemMessage(message: string, key?: string): void {
    const last = this.messages[this.messages.length - 1];
    if (key && last && last.type === "system" && last.systemKey === key) {
      last.message = message;
      // Метка времени — момент ИТОГА: строка теперь утверждает «подключились».
      last.timestamp = new Date();
      this.replaceLastMessage();
      return;
    }
    this.messages.push({ message, timestamp: new Date(), type: "system", systemKey: key });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    // Тоже «непрочитанное»: иначе системная строка сдвигала окно рендера,
    // не увеличив его (находка ревью №7).
    if (!this.atBottom) this.bumpUnseen();
    this.appendLastMessage();
  }

  /**
   * Переписать последнюю строку на месте. Новых строк не появляется, поэтому
   * ни окно рендера, ни счётчик непрочитанного не трогаем.
   */
  private replaceLastMessage(): void {
    const el = this.messagesEl;
    const msg = this.messages[this.messages.length - 1];
    if (!el || !msg) return;
    const lastEl = el.lastElementChild;
    // Окно пустое (например, после смены prefs) — обычная перерисовка.
    if (!lastEl) {
      this.renderMessages();
      return;
    }
    lastEl.outerHTML = this.messageHtml(msg).trim();
    if (this.atBottom) el.scrollTop = el.scrollHeight;
  }

  /**
   * Инкрементальное добавление ОДНОЙ строки вместо полной перерисовки окна:
   * innerHTML-пересборка на каждое IRC-сообщение пересоздавала до 200 строк
   * и держала общий DOM-наблюдатель насыщенным (аудит 01.08.2026, находка 3).
   * Полный renderMessages остаётся для смены prefs/инициализации/show().
   */
  /** Кадр доскролла уже заказан — второй не нужен. */
  private scrollFrame: number | null = null;

  /**
   * Доскроллить вниз СЛЕДУЮЩИМ кадром.
   *
   * Чтение `scrollHeight` сразу после вставки строки — принудительный
   * пересчёт layout в том же такте, и на живом чате это 5-10 пересчётов в
   * секунду поверх игровой страницы (внешний аудит 28.08.2026). Кадр отдаёт
   * ту же картинку, но платит один раз за пачку сообщений.
   */
  /** Панель уходит — заказанный кадр не должен пережить её (§4 п.7). */
  unmount(): void {
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    super.unmount();
  }

  private scrollToBottomSoon(el: HTMLElement): void {
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      if (el.isConnected && this.atBottom) el.scrollTop = el.scrollHeight;
    });
  }

  private appendLastMessage(): void {
    const el = this.messagesEl;
    const msg = this.messages[this.messages.length - 1];
    if (!el || !msg) return;
    // Заглушка «Чат пуст» — единственный не-message ребёнок; убираем перед
    // первой настоящей строкой.
    el.querySelector(".twitch-no-messages")?.remove();
    // trim(): иначе перед каждым div оседает текстовый узел с отступом, а
    // подрезка окна считает ЭЛЕМЕНТЫ — за длинную трансляцию их копились
    // тысячи (adversarial 27.08.2026).
    el.insertAdjacentHTML("beforeend", this.messageHtml(msg).trim());
    // Инвариант окна: в DOM ровно min(messages.length, windowSize) строк.
    const windowSize =
      Math.max(this.prefs.visibleCount, 1) + (this.atBottom ? 0 : this.unseen);
    const target = Math.min(this.messages.length, windowSize);
    while (el.childElementCount > target) el.firstElementChild?.remove();
    this.scrollToBottomSoon(el);
    this.updateNewBtn();
  }

  /** После show() чат должен стоять на дне, если пользователь его не листал:
   *  рендер в display:none даёт scrollHeight=0, и доскролл терялся. */
  show(): void {
    super.show();
    if (this.atBottom && this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  // ── рендер ──

  /** Перерисовать сообщения. ВСЁ пользовательское — через escapeHtml. */
  private renderMessages(): void {
    const el = this.messagesEl;
    if (!el) return;
    const p = this.prefs;
    const base = FONT_PX[p.fontSize];

    if (this.messages.length === 0) {
      el.innerHTML = `<div class="twitch-no-messages" style="text-align:center;color:#6c757d;font-size:${base}px;padding:20px;font-style:italic;">Чат пуст</div>`;
      return;
    }

    // Позицию скролла сохраняем: innerHTML-перерисовка не должна дёргать
    // историю, которую пользователь читает.
    const keepScrollTop = el.scrollTop;

    // Пока пользователь читает историю, окно рендера РАСШИРЯЕТСЯ на unseen:
    // начало окна стоит на месте, новые строки дописываются снизу — иначе
    // slice(-N) сдвигался с каждым сообщением и текст уезжал из-под глаз
    // (находка ревью №2). После возврата вниз unseen=0 — окно обычное.
    const windowSize = Math.max(p.visibleCount, 1) + (this.atBottom ? 0 : this.unseen);
    const recent = this.messages.slice(-windowSize);
    el.innerHTML = recent.map((msg) => this.messageHtml(msg).trim()).join("");

    if (this.atBottom) el.scrollTop = el.scrollHeight;
    else el.scrollTop = keepScrollTop;
    this.updateNewBtn();
  }

  /** HTML одной строки чата. ВСЁ пользовательское — через escapeHtml. */
  private messageHtml(msg: ChatMessage): string {
    const p = this.prefs;
    const base = FONT_PX[p.fontSize];
    const time = p.timestamps
      ? `<span class="twitch-timestamp" style="color:rgba(255,255,255,.45);font-size:${base - 2}px;margin-left:4px;">${escapeHtml(formatTime(msg.timestamp))}</span>`
      : "";
    if (msg.type === "system") {
      return `
        <div class="twitch-system-message" style="color:rgba(255,255,255,.55);font-size:${base - 1}px;font-style:italic;text-align:center;padding:4px;margin:4px 0;">
          ${escapeHtml(msg.message)}${time}
        </div>`;
    }
    const color = msg.color || fallbackNickColor(msg.username ?? "");
    // Бейджи — только наши эмодзи-константы из BADGE_ICONS, не ввод сети.
    const badges = (msg.badges ?? [])
      .map((b) => `<span style="font-size:${base - 2}px;margin-right:3px;">${b}</span>`)
      .join("");
    const highlight =
      msg.mention && p.highlightMentions
        ? "background:rgba(255,170,0,.16);border-left:2px solid rgba(255,170,0,.65);padding-left:4px;border-radius:3px;"
        : "";
    return `
      <div class="twitch-message" style="margin-bottom:2px;padding:2px 0;${highlight}">
        ${badges}<span class="twitch-username" style="font-weight:600;color:${color};font-size:${base}px;margin-right:6px;">${escapeHtml(
          msg.username ?? "",
        )}:</span>
        <span class="twitch-message-text" style="color:#fff;font-size:${base}px;word-wrap:break-word;line-height:1.4;">${escapeHtml(
          msg.message,
        )}</span>
        ${time}
      </div>`;
  }

  /** unseen не может превышать буфер: дальше якорь окна всё равно теряется
   *  (shift выкидывает старые), а «↓ N нов.» не должен обещать больше,
   *  чем реально можно прочитать. */
  private bumpUnseen(): void {
    this.unseen = Math.min(this.unseen + 1, MAX_MESSAGES - this.prefs.visibleCount);
  }

  private updateNewBtn(): void {
    const btn = this.newBtn;
    if (!btn) return;
    const want = this.unseen > 0 ? "block" : "none";
    if (btn.style.display !== want) btn.style.display = want;
    const label = `↓ ${this.unseen} нов.`;
    if (btn.textContent !== label) btn.textContent = label;
  }

  // ── применение настроек вида ──

  private setPrefs(patch: Partial<PanelPrefs>, rerender = false): void {
    this.prefs = { ...this.prefs, ...patch };
    savePrefs(this.prefs);
    this.applyChrome();
    if (rerender) this.renderMessages();
  }

  /** Фон/заголовок/сквозь-клики. Идемпотентно можно не делать: зовётся только
   *  по действию пользователя в меню, не из наблюдателей DOM. */
  private applyChrome(): void {
    const p = this.prefs;
    applyChrome(p, {
      root: this.root,
      header: this.header,
      hoverStrip: this.hoverStrip,
      unlockChip: this.unlockChip,
      gearMenu: this.gearMenu,
      resizeHandles: this.resizeHandles,
    });
    if (this.messagesEl) {
      // Своё, чатовое: подложка строк исчезает вместе с почти прозрачным фоном.
      this.messagesEl.style.background = p.bgOpacity / 100 < 0.3 ? "transparent" : "rgba(0,0,0,.12)";
    }
  }

  // ── скрытый заголовок: hover-полоска ──

  private buildHoverStrip(): void {
    const strip = buildHoverStrip({
      root: this.root,
      onGear: () => this.toggleGearMenu(),
      onShowHeader: () => this.setPrefs({ headerHidden: false }),
    });
    // Полоска — ручка перетаскивания, когда заголовка нет.
    this.enableDrag(strip, this.root);
    this.hoverStrip = strip;
  }

  // ── сквозь-клики: чип-замок ──

  private buildUnlockChip(): void {
    this.unlockChip = buildUnlockChip(
      this.root,
      "Чат в режиме «сквозь клики». Нажмите, чтобы вернуть управление панелью",
      () => this.setPrefs({ clickThrough: false }),
    );
  }

  // ── меню настроек ──

  private toggleGearMenu(): void {
    const menu = this.gearMenu;
    if (!menu) return;
    const opening = menu.style.display === "none";
    // Контролы пересобираются при КАЖДОМ открытии: prefs меняются и мимо
    // меню (чип-замок, «▾» на полоске), и чекбоксы иначе врали (ревью №3).
    if (opening) this.populateGearMenu(menu);
    menu.style.display = opening ? "block" : "none";
  }

  private buildGearMenu(): void {
    this.gearMenu = buildGearMenu(this.root);
  }

  /** Наполнить меню актуальными значениями prefs (зовётся на каждое открытие). */
  private populateGearMenu(menu: HTMLElement): void {
    menu.replaceChildren();
    menu.appendChild(
      menuRow(
        "Фон",
        menuRange(
          this.prefs.bgOpacity,
          (v) => {
            // Живой предпросмотр без записи на диск; сохранение — по отпусканию.
            this.prefs = { ...this.prefs, bgOpacity: v };
            this.applyChrome();
          },
          () => savePrefs(this.prefs),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Шрифт",
        menuSegmented(
          ["s", "m", "l"] as const,
          this.prefs.fontSize,
          (v) => v.toUpperCase(),
          (v) => this.setPrefs({ fontSize: v }, true),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Сообщений",
        menuSelect(VISIBLE_VARIANTS, this.prefs.visibleCount, (v) =>
          this.setPrefs({ visibleCount: v }, true),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Заголовок",
        menuCheck(!this.prefs.headerHidden, (v) => this.setPrefs({ headerHidden: !v })),
      ),
    );
    menu.appendChild(
      menuRow(
        "Время сообщений",
        menuCheck(this.prefs.timestamps, (v) => this.setPrefs({ timestamps: v }, true)),
      ),
    );
    menu.appendChild(
      menuRow(
        "Подсветка @обращений",
        menuCheck(this.prefs.highlightMentions, (v) =>
          this.setPrefs({ highlightMentions: v }, true),
        ),
      ),
    );
    menu.appendChild(
      menuRow(
        "Сквозь клики",
        menuCheck(this.prefs.clickThrough, (v) => this.setPrefs({ clickThrough: v })),
      ),
    );
    menu.appendChild(
      menuHint("«Сквозь клики»: чат перестаёт ловить мышь; выход — замок в углу панели."),
    );
  }
}

// ─────────────────────────── фича ───────────────────────────

interface TwitchFeature extends Feature {
  /** Закрытие панели по кнопке ×: спрятать и выключить настройку. */
  requestClose(): void;
}

let panel: TwitchChatPanel | null = null;
let socket: WebSocket | null = null;
let isConnected = false;
let channelName = "";

let unsubMessage: (() => void) | null = null;
let unsubDom: (() => void) | null = null;
let onPageHideFlush: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Признак намеренного отключения — чтобы не переподключаться после disconnect(). */
let intentionalClose = false;
/**
 * Чат ПОДТВЕРЖДЁННО готов: мы вошли в канал (IRC 366).
 *
 * Открытый сокет готовности не доказывает — JOIN могут отвергнуть, канала
 * может не быть. Раньше бюджет переподключений обнулялся на каждом открытии
 * транспорта, поэтому у «дёрганья» соединения не было верхнего предела
 * (аудит наблюдаемости 02.08.2026, TW-2).
 */
let ircReady = false;
/** Последний входящий трафик — детект молчаливо умершего сокета. */
let lastActivityAt = 0;
let idleWatchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Twitch пингует каждые ~5 минут. Тишина дольше 6 минут при OPEN-сокете
 * означает мёртвое соединение (Wi-Fi моргнул без TCP RST): onclose может не
 * прийти десятки минут, чат молча замирал на всю трансляцию. Watchdog
 * закрывает такой сокет — дальше штатный onclose → реконнект.
 */
const IDLE_TIMEOUT_MS = 6 * 60 * 1000;

function sendTwitchStatus(connected: boolean, error?: string): void {
  void sendRuntime({ type: "twitch_status", connected, channel: channelName, error });
}

/**
 * Сколько ждём подтверждения входа в канал (IRC 366) после открытия сокета.
 *
 * Замер на живом Twitch: у существующего канала 366 приходит примерно за
 * секунду; у несуществующего JOIN игнорируется МОЛЧА — ни ошибки, ни NOTICE.
 * Без этого таймера самая частая причина жалобы (опечатка в имени канала)
 * выводилась только косвенно, через шестиминутный простой (ревью 02.08.2026).
 */
const JOIN_CONFIRM_TIMEOUT_MS = 10_000;
let joinWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearJoinWatchdog(): void {
  if (joinWatchdog) {
    clearTimeout(joinWatchdog);
    joinWatchdog = null;
  }
}

function startJoinWatchdog(): void {
  clearJoinWatchdog();
  joinWatchdog = setTimeout(() => {
    joinWatchdog = null;
    if (ircReady) return;
    log.warn(
      SCOPE,
      "twitch: вход в канал не подтверждён за",
      `${JOIN_CONFIRM_TIMEOUT_MS / 1000} с —`,
      "вероятно, канала нет или имя набрано с ошибкой",
    );
    // Исход той же попытки — переписываем её строку, а не пишем вторую.
    panel?.addSystemMessage("Канал не отвечает — проверьте имя канала", SYS_CONNECT);
    sendTwitchStatus(false, "Канал не отвечает — проверьте имя канала");
  }, JOIN_CONFIRM_TIMEOUT_MS);
}

function startIdleWatchdog(): void {
  if (idleWatchdog) return;
  idleWatchdog = setInterval(() => {
    // Страховка PERF-7: если уход с игрового маршрута прошёл без единой
    // childList-мутации (и sync его не заметил), тик watchdog'а добивает
    // соединение сам — сокет вне /game не нужен никому.
    if (!chatBelongsHere({ scope: chatScope, pathname: location.pathname, gameUi: hasActiveGameInterface() })) {
      disconnect();
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
      log.warn(SCOPE, "IRC idle timeout, forcing reconnect");
      socket.close();
    }
  }, 60_000);
}

function stopIdleWatchdog(): void {
  if (idleWatchdog) {
    clearInterval(idleWatchdog);
    idleWatchdog = null;
  }
}

/**
 * Пользователи вставляют URL канала или имя с #/пробелами — Twitch на такой
 * JOIN молча не отвечает, а панель писала «Подключились к чату».
 */
function normalizeChannel(raw: string): string {
  let name = raw.trim().toLowerCase();
  const m = name.match(/(?:twitch\.tv\/)([a-z0-9_]+)/);
  if (m) name = m[1];
  return name.replace(/^#+/, "").replace(/[^a-z0-9_]/g, "");
}
/** Последнее известное состояние игрового интерфейса (для дебаунса смены). */
let gameUiVisible = false;
/**
 * Хочет ли пользователь видеть панель (twitch_floating_panel_enabled).
 * Раньше настройка писалась попапом, но НИКЕМ не читалась — тумблер был
 * декоративным, а скрытие панели не переживало перезагрузку вкладки.
 */
let panelWanted = true;

function ensurePanel(): TwitchChatPanel {
  if (!panel) {
    panel = new TwitchChatPanel();
    // Восстановление истории — при СОЗДАНИИ панели, не при show(): show
    // дёргается на каждом переходе, а сеять можно только в пустой буфер.
    panel.seedHistory(loadChatHistory(channelName));
  }
  return panel;
}

/**
 * Сокет уже жив (CONNECTING или OPEN) — второй не нужен.
 *
 * Гейт «не больше одного сокета» обязан смотреть на transport, а не на
 * isConnected: тот становится true только в асинхронном onopen, и пока сокет
 * в CONNECTING, проверка isConnected пропускала второй connectToTwitch(),
 * который убивал первый и открывал новый — две auth-попытки на каждый вход
 * в игру (PERF-7).
 */
function hasLiveSocket(): boolean {
  return (
    socket !== null &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  );
}

// ── видимость в зависимости от игрового интерфейса (порт sync...) ──

function showPanel(): void {
  // Гейт — chatBelongsHere, НЕ hasActiveGameInterface: в режиме «везде»
  // (дефолт с 9.28.0) панель обязана подниматься и на поиске/лобби, где
  // игрового UI нет. Жёсткая проверка на 10 плиток здесь молча глотала
  // показ вне комнаты — «чат везде» не показывался нигде, кроме игры
  // (жалоба 23.08.2026: «пообещали — имеем ничего»).
  if (!chatBelongsHere({ scope: chatScope, pathname: location.pathname, gameUi: hasActiveGameInterface() })) {
    gameUiVisible = false;
    return;
  }
  gameUiVisible = true;
  const p = ensurePanel();
  p.show();
  // Подключаемся к чату при показе, если есть канал и живого сокета ещё нет.
  if (channelName && !hasLiveSocket()) connectToTwitch();
}

function hidePanel(): void {
  panel?.hide();
}

function syncVisibilityWithGameState(): void {
  // Уход с игрового маршрута: панель и сокет не нужны никому — IRC-парсинг,
  // DOM-вставки чата и 60-секундный watchdog продолжались на поиске/лобби всю
  // сессию (PERF-7). Скрытие панели ПОЛЬЗОВАТЕЛЕМ (panelWanted) — отдельная
  // политика и здесь не трогается: она про видимость, а не про маршрут.
  const hasGameUi = hasActiveGameInterface();
  const belongs = chatBelongsHere({ scope: chatScope, pathname: location.pathname, gameUi: hasGameUi });
  if (!belongs) {
    gameUiVisible = false;
    hidePanel();
    if (socket || reconnectTimer || idleWatchdog || joinWatchdog) disconnect();
    return;
  }
  // gameUiVisible — исторически «панели есть где жить». В режиме «везде»
  // это верно на любой странице; имя оставлено ради минимального диффа.
  gameUiVisible = true;
  // Игровой UI есть — показываем, если пользователь панель не скрывал.
  if (panelWanted && (!panel || !panel.isShown)) {
    showPanel();
  }
}

// ── дебаунс сверки видимости (бюджет «Game UI subscribers») ──

/** Не чаще двух полных сверок в секунду: сверка — это до 3 document-QSA. */
const SYNC_MIN_INTERVAL_MS = 500;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncAt = 0;

/** Trailing-дебаунс: последний батч всегда доводит состояние до актуального. */
function scheduleVisibilitySync(): void {
  if (syncTimer) return;
  const delay = Math.max(0, SYNC_MIN_INTERVAL_MS - (Date.now() - lastSyncAt));
  syncTimer = setTimeout(() => {
    syncTimer = null;
    lastSyncAt = Date.now();
    syncVisibilityWithGameState();
  }, delay);
}

function clearVisibilitySync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

/** Запомнить выбор пользователя «показывать/скрывать панель» между сессиями. */
function persistPanelWanted(value: boolean): void {
  if (panelWanted === value) return;
  panelWanted = value;
  void browser.storage.sync.set({ twitch_floating_panel_enabled: value });
}

// ── IRC ──

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (intentionalClose || !channelName) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log.warn(
      SCOPE,
      "twitch: переподключение прекращено — исчерпаны",
      MAX_RECONNECT_ATTEMPTS,
      "попытки; чат остаётся отключённым",
    );
    panel?.addSystemMessage("Не удалось подключиться — проверьте имя канала", SYS_CONNECT);
    sendTwitchStatus(false, "Не удалось подключиться — проверьте имя канала");
    return;
  }
  reconnectAttempts++;
  clearReconnect();
  // Растущая задержка: 5с, 10с, 15с… до 30с.
  const delay = Math.min(RECONNECT_DELAY * reconnectAttempts, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // За время задержки могли уйти с игрового маршрута — переподключаться
    // не к чему, и остаточные watchdog'и здесь же гасим (PERF-7).
    if (!chatBelongsHere({ scope: chatScope, pathname: location.pathname, gameUi: hasActiveGameInterface() })) {
      disconnect();
      return;
    }
    log.info(SCOPE, `twitch: переподключение, попытка ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
    connectToTwitch();
  }, delay);
}

function connectToTwitch(): void {
  if (!channelName) {
    log.debug(SCOPE, "no channel specified");
    // Молчание здесь заставляло попап ждать 5с и врать «Нет ответа от
    // страницы игры» — пользователь перезагружал вкладку вместо исправления
    // имени канала (кириллица/мусор нормализуются в пустую строку).
    sendTwitchStatus(false, "Некорректное имя канала — укажите имя латиницей");
    return;
  }

  // Сокет живёт только на игровом маршруте: панель вне /game всё равно не
  // видна (hasActiveGameInterface требует игровой UI), а соединение «в никуда»
  // жгло сеть и CPU до конца сессии (PERF-7). Явное подключение из попапа на
  // другой странице честно отвечает отказом вместо ложного успеха.
  if (!chatBelongsHere({ scope: chatScope, pathname: location.pathname, gameUi: hasActiveGameInterface() })) {
    log.debug(SCOPE, "twitch: чату здесь не место (режим «только в игре») — подключение не выполняем");
    sendTwitchStatus(false, "Чат подключается только в игре — или включите «Чат везде на сайте»");
    return;
  }

  // Закрываем предыдущий сокет (смена канала / повторное подключение).
  // Флаг intentionalClose для этого НЕ годится: close() асинхронный, а флаг
  // сбрасывался синхронно — onclose старого сокета приходил уже после сброса,
  // видел false и планировал реконнект, который через 5 с убивал свежее
  // рабочее соединение. Получался вечный цикл переподключений.
  // Вместо флага снимаем со старого сокета обработчики: его close нас не касается.
  clearReconnect();
  if (socket) {
    // Включая onopen: без этого open-задача старого CONNECTING-сокета,
    // уже стоявшая в очереди, выполнялась после замены — ставила
    // isConnected=true для мёртвого сокета и ложное «Подключились».
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
  intentionalClose = false;
  // Таймер подтверждения входа от ПРЕЖНЕГО подключения: onclose заменяемого
  // сокета мы намеренно отвязываем, поэтому там он не погаснет и выстрелил бы
  // «Канал не отвечает» уже про исправленное имя (ревью 02.08.2026).
  clearJoinWatchdog();

  log.info(SCOPE, "connecting to channel", channelName);

  try {
    const ws = new WebSocket(IRC_URL);
    socket = ws;

    ws.onopen = () => {
      // Транспорт открыт — это ЕЩЁ НЕ готовность чата: JOIN могут отвергнуть,
      // канала может не быть. Раньше в файле оставалось только «connecting»,
      // и «чат замер» не отличалось от «канал не существует» (аудит
      // наблюдаемости 02.08.2026, TW-1/TW-2).
      log.info(SCOPE, "twitch: сокет открыт, отправляем вход в канал");
      ircReady = false;
      // Теги дают цвет ника, display-name и бейджи. Доступны и анониму.
      ws.send("CAP REQ :twitch.tv/tags");
      // Анонимный вход.
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(Math.random() * 100000)}`);
      ws.send(`JOIN #${channelName.toLowerCase()}`);
      isConnected = true;
      lastActivityAt = Date.now();
      startIdleWatchdog();
      // НЕ «подключились»: вход в канал ещё не подтверждён. Для
      // несуществующего канала Twitch молча игнорирует JOIN, и человек шесть
      // минут видел бы ложный успех (аудит наблюдаемости 02.08.2026, №8
      // раздела «Ответ пользователю»).
      panel?.addSystemMessage("Подключаемся к чату…", SYS_CONNECT);
      startJoinWatchdog();
      // НЕ «подключено»: открытый сокет — это транспорт, а не готовность чата.
      // Попап писал зелёное «Подключено: канал» ровно тогда, когда панель
      // говорила «канал не отвечает», и на опечатке в имени канала это
      // состояние жило вечно (adversarial 27.08.2026).
      sendTwitchStatus(false, "Подключаемся к чату…");
    };

    ws.onmessage = (event) => {
      lastActivityAt = Date.now();
      handleTwitchData(String(event.data));
    };

    ws.onclose = (event) => {
      // Сокет мог смениться, пока ждали close — чужой close игнорируем целиком.
      if (socket !== ws) return;
      log.info(
        SCOPE,
        "twitch: соединение закрыто, код",
        event.code,
        intentionalClose ? "(по нашей команде)" : `(попытка ${reconnectAttempts})`,
        ircReady ? "| чат был готов" : "| до готовности чата",
      );
      // Был ли чат ПОДТВЕРЖДЁННО живым до обрыва: от этого зависит и текст,
      // и то, отдельное это событие или конец текущей попытки.
      const wasReady = ircReady;
      ircReady = false;
      clearJoinWatchdog();
      isConnected = false;
      socket = null;
      sendTwitchStatus(false);
      if (!intentionalClose) {
        if (wasReady) {
          // Живой чат оборвался — самостоятельное событие, затирать им
          // «подключились» нельзя.
          panel?.addSystemMessage("Отключились от чата");
        } else {
          // Подключения не было: «отключились» тут неправда, а пара
          // onerror+onclose давала ДВЕ строки на каждую из десяти попыток —
          // лестница переподключений забивала окно чата (adversarial
          // 27.08.2026).
          panel?.addSystemMessage("Соединение прервано — пробуем снова", SYS_CONNECT);
        }
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // Объект события сериализуется в «{}» и в файле бесполезен — пишем
      // состояние сокета, а не сам объект (TW-1).
      log.error(SCOPE, "twitch: ошибка сокета, readyState =", ws.readyState);
      // Ошибка ДО входа в канал — исход текущей попытки (переписываем строку
      // «подключаемся»). Ошибка на живом чате — отдельное событие: затирать
      // ею «подключились» значило бы стереть факт, что чат работал.
      panel?.addSystemMessage("Ошибка подключения к чату", ircReady ? undefined : SYS_CONNECT);
    };
  } catch (e) {
    log.error(SCOPE, "failed to connect", e);
    scheduleReconnect();
  }
}

function disconnect(): void {
  const hadConnection = isConnected || socket !== null;
  intentionalClose = true;
  clearReconnect();
  stopIdleWatchdog();
  clearJoinWatchdog();
  if (socket) {
    // Полная отвязка: висящие onopen/onerror старого сокета после
    // намеренного отключения давали ложные статусы.
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
  isConnected = false;
  if (hadConnection) sendTwitchStatus(false);
}

/** Команда IRC-строки (PRIVMSG/NOTICE/366/…) без её содержимого. */
function ircCommandOf(line: string): string {
  const noTags = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
  const parts = noTags.startsWith(":") ? noTags.split(" ") : ["", ...noTags.split(" ")];
  return /^[A-Z0-9]{2,12}$/.test(parts[1] || "") ? parts[1] : "?";
}

function handleTwitchData(data: string): void {
  const lines = data.split("\r\n");
  for (const line of lines) {
    if (!line) continue;
    // В лог — только тип IRC-команды и длина: raw-строка содержит ник,
    // display-name и ПОЛНЫЙ текст сообщения зрителя, а буфер логов уезжает в
    // файл для поддержки (аудит безопасности 01.08.2026, находка 10).
    log.debug(SCOPE, "IRC <<", ircCommandOf(line), `len=${line.length}`);

    // Ответ на PING (keep-alive).
    if (line.startsWith("PING")) {
      socket?.send(line.replace("PING", "PONG"));
      continue;
    }

    // Готовность чата подтверждает ТОЛЬКО вход в канал (366 — конец списка
    // имён). Регистрация (001) её не доказывает: JOIN могут отвергнуть.
    if (!ircReady && ircCommandOf(line) === "366") {
      ircReady = true;
      reconnectAttempts = 0;
      clearJoinWatchdog();
      log.info(SCOPE, "twitch: чат готов — вход в канал подтверждён");
      sendTwitchStatus(true);
      // Тот же ключ: строка «подключаемся» превращается в «подключились», а
      // не повисает над ней второй.
      panel?.addSystemMessage("Подключились к чату", SYS_CONNECT);
    }
    // Отказ входа: канала нет, он в бане и т.п. Само сообщение не пишем —
    // это текст сервиса, а нам нужен факт.
    if (ircCommandOf(line) === "NOTICE" && !ircReady) {
      log.warn(SCOPE, "twitch: сервис отклонил вход в канал");
    }

    if (line.includes("PRIVMSG")) parsePrivMsg(line);
  }
}

/** Экранирование значений IRC-тегов (IRCv3): \s → пробел, \: → «;» и т.д. */
function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => {
    if (c === "s") return " ";
    if (c === ":") return ";";
    if (c === "r") return "\r";
    if (c === "n") return "\n";
    return c;
  });
}

function parseTags(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) out[pair] = "";
    else out[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
  }
  return out;
}

function parseBadges(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const item of raw.split(",")) {
    const name = item.split("/")[0];
    const icon = BADGE_ICONS[name];
    if (icon && !out.includes(icon)) out.push(icon);
  }
  return out;
}

function parsePrivMsg(line: string): void {
  try {
    // С CAP tags строка может начинаться с @key=value;…, дальше как раньше:
    // :username!username@username.tmi.twitch.tv PRIVMSG #channel :message
    const match = line.match(/^(?:@(\S+) )?:([^!]+)![^@]+@[^\s]+ PRIVMSG #[^\s]+ :(.+)/);
    if (!match) return;
    const tags = parseTags(match[1]);
    // display-name сохраняет регистр и юникод; пустой (или из одних пробелов
    // после \s-unescape) у части аккаунтов — тогда логин.
    const username = (tags["display-name"] || "").trim() || match[2];
    let message = match[3];
    // /me приходит как \x01ACTION текст\x01 — управляющие байты в чат не пускаем.
    if (message.startsWith("\u0001ACTION ")) {
      message = message.slice(8).replace(/\u0001$/, "").trim();
    }
    // Цвет уходит в inline-style — принимаем СТРОГО #rrggbb, ничего больше.
    const rawColor = tags["color"] || "";
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : undefined;
    panel?.addChatMessage(username, message, { color, badges: parseBadges(tags["badges"]) });
  } catch (e) {
    log.error(SCOPE, "failed to parse PRIVMSG", e);
  }
}

// ── команды popup ──

function handleControlMessage(msg: TwitchControlMsg): void {
  log.debug(SCOPE, "control message", msg.type);
  switch (msg.type) {
    case "twitch_panel_show":
      persistPanelWanted(true);
      showPanel();
      break;
    case "twitch_panel_hide":
      persistPanelWanted(false);
      hidePanel();
      break;
    case "twitch_panel_toggle":
      if (panel?.isShown) {
        persistPanelWanted(false);
        hidePanel();
      } else {
        persistPanelWanted(true);
        showPanel();
      }
      break;
    case "twitch_connect": {
      const next = msg.channel ? normalizeChannel(msg.channel) : channelName;
      if (next !== channelName) {
        channelName = next;
        panel?.resetForChannel();
        if (!panel) clearChatHistory();
      }
      reconnectAttempts = 0; // явное действие пользователя — свежий лимит попыток
      connectToTwitch();
      break;
    }
    case "twitch_disconnect":
      disconnect();
      break;
    case "twitch_get_status":
      // Правда для попапа — подтверждённый вход в канал, а не живой сокет.
      sendTwitchStatus(ircReady);
      break;
  }
}

function isTwitchControlMsg(msg: unknown): msg is TwitchControlMsg {
  const t = (msg as { type?: string } | null)?.type;
  return (
    t === "twitch_panel_show" ||
    t === "twitch_panel_hide" ||
    t === "twitch_panel_toggle" ||
    t === "twitch_connect" ||
    t === "twitch_disconnect" ||
    t === "twitch_get_status"
  );
}

// ─────────────────────────── публичная фича ───────────────────────────

export const twitchPanelFeature: TwitchFeature = {
  id: "twitch-panel",
  settingKey: "twitch_chat_enabled",

  enable(ctx: FeatureContext) {
    channelName = normalizeChannel(ctx.settings.twitch_channel_name || "");
    panelWanted = ctx.settings.twitch_floating_panel_enabled !== false;
    chatScope = ctx.settings.twitch_chat_everywhere === false ? "game" : "site";

    unsubMessage = onMessage((msg) => {
      if (isTwitchControlMsg(msg)) handleControlMessage(msg);
    });

    // Дроссель записи истории может не дожить до конца страницы — флаш на
    // pagehide (тот же урок, что log.flushNow у freeze-watch).
    onPageHideFlush = () => panel?.flushHistoryNow();
    window.addEventListener("pagehide", onPageHideFlush);

    // Слежение за игровым интерфейсом (порт MutationObserver-логики).
    //
    // Бюджет «Game UI subscribers»: сверка видимости — до 3 document-QSA,
    // поэтому (1) attribute-only батчи отсекаются ДО неё — смена class/style
    // не меняет числа плиток/камер, по которым считается видимость;
    // (2) сверка дебаунсится до ≤2/с (trailing — финальное состояние не
    // теряется).
    unsubDom = onDomChange((mutations) => {
      let hasChildList = false;
      for (const m of mutations) {
        if (m.type === "childList") {
          hasChildList = true;
          break;
        }
      }
      if (!hasChildList) return;
      scheduleVisibilitySync();
    });

    // Первичная синхронизация: показать панель и подключиться, если уже в игре.
    // (Раньше здесь был второй безусловный connectToTwitch() — он убивал
    // только что созданный showPanel'ом CONNECTING-сокет и открывал новый:
    // две auth-попытки на каждый вход в игру. Гейт — hasLiveSocket, а не
    // isConnected: CONNECTING-сокет уже «занял место», см. PERF-7.)
    lastSyncAt = Date.now();
    syncVisibilityWithGameState();
    if (channelName && gameUiVisible && !hasLiveSocket()) connectToTwitch();
  },

  update(ctx: FeatureContext) {
    const nextScope: ChatScope = ctx.settings.twitch_chat_everywhere === false ? "game" : "site";
    if (nextScope !== chatScope) {
      chatScope = nextScope;
      // Сменили режим — пересверить, место ли чату здесь; сверка сама
      // поднимет панель/сокет или погасит их.
      syncVisibilityWithGameState();
      if (channelName && gameUiVisible && !hasLiveSocket()) connectToTwitch();
    }
    const next = normalizeChannel(ctx.settings.twitch_channel_name || "");
    if (next !== channelName) {
      channelName = next;
      // Историю старого канала не тащим под новый ключ — буфер с нуля.
      panel?.resetForChannel();
      if (!panel) clearChatHistory();
      reconnectAttempts = 0; // сменили канал — свежий лимит попыток
      // Переподключение к новому каналу (или отключение, если канал убрали).
      if (channelName && gameUiVisible) connectToTwitch();
      else disconnect();
    }
    // Тумблер видимости панели из попапа (или другой вкладки).
    const wanted = ctx.settings.twitch_floating_panel_enabled !== false;
    if (wanted !== panelWanted) {
      panelWanted = wanted;
      if (wanted) syncVisibilityWithGameState();
      else hidePanel();
    }
  },

  disable() {
    disconnect();

    // Сохранить до unmount: выключение фичи не должно стирать историю —
    // повторное включение в той же вкладке восстановит разговор.
    panel?.flushHistoryNow();
    if (onPageHideFlush) {
      window.removeEventListener("pagehide", onPageHideFlush);
      onPageHideFlush = null;
    }

    if (unsubMessage) {
      unsubMessage();
      unsubMessage = null;
    }
    if (unsubDom) {
      unsubDom();
      unsubDom = null;
    }
    clearReconnect();
    clearVisibilitySync();

    panel?.unmount();
    panel = null;

    isConnected = false;
    gameUiVisible = false;
    channelName = "";
  },

  requestClose() {
    hidePanel();
    disconnect();
    // Выключаем тумблер — FeatureManager затем вызовет disable().
    void browser.storage.sync.set({ twitch_chat_enabled: false });
  },
};
