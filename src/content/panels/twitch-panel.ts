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
import { log } from "@core/log";
import { onMessage } from "@core/messaging";
import { SITE } from "@core/selectors";
import type { Feature, FeatureContext } from "@core/feature";
import type { TwitchControlMsg } from "@shared/types";

const SCOPE = "twitch";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
/** Максимум хранимых сообщений (как в оригинале). */
const MAX_MESSAGES = 100;
/** Сколько последних сообщений рисуем (компактность, как в оригинале). */
const VISIBLE_MESSAGES = 3;
/** Базовая задержка переподключения. */
const RECONNECT_DELAY = 5000;
/** Потолок попыток: опечатка в имени канала не должна долбить IRC вечно. */
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectAttempts = 0;

interface ChatMessage {
  username?: string;
  message: string;
  timestamp: Date;
  type: "chat" | "system";
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Детекция активного игрового интерфейса (порт hasActiveGameInterface). */
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

  /** Панель смонтирована и видима (не hide()). */
  get isShown(): boolean {
    return this.isMounted && this.root.style.display !== "none";
  }

  constructor() {
    super({
      storageKey: "twitch-panel",
      title: "Twitch Chat",
      width: 280,
      height: 150,
      minWidth: 250,
      minHeight: 120,
      resizable: true,
      className: "twitch-chat-panel",
    });
  }

  protected renderBody(body: HTMLElement): void {
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

    wrap.appendChild(messagesEl);
    body.appendChild(wrap);

    this.messagesEl = messagesEl;
    this.renderMessages();
  }

  addChatMessage(username: string, message: string): void {
    this.messages.push({ username, message, timestamp: new Date(), type: "chat" });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    this.renderMessages();
  }

  addSystemMessage(message: string): void {
    this.messages.push({ message, timestamp: new Date(), type: "system" });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    this.renderMessages();
  }

  /** Перерисовать последние сообщения. ВСЁ пользовательское — через escapeHtml. */
  private renderMessages(): void {
    const el = this.messagesEl;
    if (!el) return;

    if (this.messages.length === 0) {
      el.innerHTML =
        '<div class="twitch-no-messages" style="text-align:center;color:#6c757d;font-size:12px;padding:20px;font-style:italic;">Чат пуст</div>';
      return;
    }

    const recent = this.messages.slice(-VISIBLE_MESSAGES);
    el.innerHTML = recent
      .map((msg) => {
        const time = escapeHtml(formatTime(msg.timestamp));
        if (msg.type === "system") {
          return `
            <div class="twitch-system-message" style="color:rgba(255,255,255,.55);font-size:11px;font-style:italic;text-align:center;padding:4px;margin:4px 0;">
              ${escapeHtml(msg.message)}
              <span class="twitch-timestamp" style="color:rgba(255,255,255,.45);font-size:10px;margin-left:4px;">${time}</span>
            </div>`;
        }
        return `
          <div class="twitch-message" style="margin-bottom:2px;padding:2px 0;">
            <span class="twitch-username" style="font-weight:600;color:rgba(210,190,255,.95);font-size:12px;margin-right:6px;">${escapeHtml(
              msg.username ?? "",
            )}:</span>
            <span class="twitch-message-text" style="color:#fff;font-size:12px;word-wrap:break-word;line-height:1.4;">${escapeHtml(
              msg.message,
            )}</span>
            <span class="twitch-timestamp" style="color:rgba(255,255,255,.45);font-size:10px;margin-left:4px;">${time}</span>
          </div>`;
      })
      .join("");

    el.scrollTop = el.scrollHeight;
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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Признак намеренного отключения — чтобы не переподключаться после disconnect(). */
let intentionalClose = false;
/** Последнее известное состояние игрового интерфейса (для дебаунса смены). */
let gameUiVisible = false;
/**
 * Хочет ли пользователь видеть панель (twitch_floating_panel_enabled).
 * Раньше настройка писалась попапом, но НИКЕМ не читалась — тумблер был
 * декоративным, а скрытие панели не переживало перезагрузку вкладки.
 */
let panelWanted = true;

function ensurePanel(): TwitchChatPanel {
  if (!panel) panel = new TwitchChatPanel();
  return panel;
}

// ── видимость в зависимости от игрового интерфейса (порт sync...) ──

function showPanel(): void {
  if (!hasActiveGameInterface()) {
    gameUiVisible = false;
    return;
  }
  const p = ensurePanel();
  p.show();
  // Подключаемся к чату при показе, если есть канал и ещё не подключены.
  if (channelName && !isConnected) connectToTwitch();
}

function hidePanel(): void {
  panel?.hide();
}

function syncVisibilityWithGameState(): void {
  const hasGameUi = hasActiveGameInterface();
  gameUiVisible = hasGameUi;

  if (!hasGameUi) {
    hidePanel();
    return;
  }
  // Игровой UI есть — показываем, если пользователь панель не скрывал.
  if (panelWanted && (!panel || !panel.isShown)) {
    showPanel();
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
    log.warn(SCOPE, "reconnect limit reached, giving up");
    panel?.addSystemMessage("Не удалось подключиться — проверьте имя канала");
    return;
  }
  reconnectAttempts++;
  clearReconnect();
  // Растущая задержка: 5с, 10с, 15с… до 30с.
  const delay = Math.min(RECONNECT_DELAY * reconnectAttempts, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    log.debug(SCOPE, "reconnecting to", channelName, `attempt ${reconnectAttempts}`);
    connectToTwitch();
  }, delay);
}

function connectToTwitch(): void {
  if (!channelName) {
    log.debug(SCOPE, "no channel specified");
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
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
  intentionalClose = false;

  log.info(SCOPE, "connecting to channel", channelName);

  try {
    const ws = new WebSocket(IRC_URL);
    socket = ws;

    ws.onopen = () => {
      log.debug(SCOPE, "IRC websocket open");
      // Анонимный вход.
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(Math.random() * 100000)}`);
      ws.send(`JOIN #${channelName.toLowerCase()}`);
      isConnected = true;
      reconnectAttempts = 0;
      panel?.addSystemMessage("Подключились к чату");
    };

    ws.onmessage = (event) => {
      handleTwitchData(String(event.data));
    };

    ws.onclose = () => {
      // Сокет мог смениться, пока ждали close — чужой close игнорируем целиком.
      if (socket !== ws) return;
      log.debug(SCOPE, "IRC disconnected");
      isConnected = false;
      socket = null;
      if (!intentionalClose) {
        panel?.addSystemMessage("Отключились от чата");
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      log.error(SCOPE, "IRC websocket error", err);
      panel?.addSystemMessage("Ошибка подключения к чату");
    };
  } catch (e) {
    log.error(SCOPE, "failed to connect", e);
    scheduleReconnect();
  }
}

function disconnect(): void {
  intentionalClose = true;
  clearReconnect();
  if (socket) {
    socket.close();
    socket = null;
  }
  isConnected = false;
}

function handleTwitchData(data: string): void {
  const lines = data.split("\r\n");
  for (const line of lines) {
    if (!line) continue;
    log.debug(SCOPE, "IRC <<", line);

    // Ответ на PING (keep-alive).
    if (line.startsWith("PING")) {
      socket?.send(line.replace("PING", "PONG"));
      continue;
    }

    if (line.includes("PRIVMSG")) parsePrivMsg(line);
  }
}

function parsePrivMsg(line: string): void {
  try {
    // :username!username@username.tmi.twitch.tv PRIVMSG #channel :message
    const match = line.match(/:([^!]+)![^@]+@[^\s]+ PRIVMSG #[^\s]+ :(.+)/);
    if (match) {
      const username = match[1];
      const message = match[2];
      panel?.addChatMessage(username, message);
    }
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
    case "twitch_connect":
      if (msg.channel) channelName = msg.channel;
      reconnectAttempts = 0; // явное действие пользователя — свежий лимит попыток
      connectToTwitch();
      break;
    case "twitch_disconnect":
      disconnect();
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
    t === "twitch_disconnect"
  );
}

// ─────────────────────────── публичная фича ───────────────────────────

export const twitchPanelFeature: TwitchFeature = {
  id: "twitch-panel",
  settingKey: "twitch_chat_enabled",

  enable(ctx: FeatureContext) {
    channelName = ctx.settings.twitch_channel_name || "";
    panelWanted = ctx.settings.twitch_floating_panel_enabled !== false;

    unsubMessage = onMessage((msg) => {
      if (isTwitchControlMsg(msg)) handleControlMessage(msg);
    });

    // Слежение за игровым интерфейсом (порт MutationObserver-логики).
    unsubDom = onDomChange(() => syncVisibilityWithGameState());

    // Первичная синхронизация: показать панель и подключиться, если уже в игре.
    syncVisibilityWithGameState();
    if (channelName && gameUiVisible) connectToTwitch();
  },

  update(ctx: FeatureContext) {
    const next = ctx.settings.twitch_channel_name || "";
    if (next !== channelName) {
      channelName = next;
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

    if (unsubMessage) {
      unsubMessage();
      unsubMessage = null;
    }
    if (unsubDom) {
      unsubDom();
      unsubDom = null;
    }
    clearReconnect();

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
