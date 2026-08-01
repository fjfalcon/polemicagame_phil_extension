/**
 * OBS WebSocket (obs-websocket v5) клиент, живущий в background.
 * Порт прежнего BackgroundOBSWebSocket с фиксами:
 *  - нет стэкающихся таймеров (reconnect/heartbeat гасятся перед новым запуском);
 *  - browser.* вместо chrome.*;
 *  - рассылка событий через типизированную шину messaging.
 */
import { browser } from "@core/env";
import { log } from "@core/log";
import { broadcastToGameTabs, sendRuntime } from "@core/messaging";
import type { ObsConnectionState, ObsScene, ObsSceneData } from "@shared/types";

interface ConnSettings {
  url: string;
  password: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
export const OBS_RETRY_BLOCKED_KEY = "obs_retry_blocked";
/**
 * Причина блокировки: "auth" — неверный пароль (сбрасывать можно только при
 * смене кредов или ручном подключении), "protocol" — несовместимость версий
 * (её чинит обновление расширения, поэтому onInstalled вправе сбросить).
 * Раньше причина не хранилась, и после апдейта, исправившего протокол,
 * блокировка держалась до перезапуска браузера (аудит lifecycle, находка 13).
 */
export const OBS_RETRY_BLOCK_REASON_KEY = "obs_retry_block_reason";
/** Пережившее выгрузку число попыток переподключения (см. reconnectAttempts). */
export const OBS_RECONNECT_ATTEMPTS_KEY = "obs_reconnect_attempts";

/** base64(SHA-256(text)) — примитив challenge-response аутентификации v5. */
async function sha256b64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class ObsClient {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private isConnected = false;
  private requestId = 1;
  private pending = new Map<number, Pending>();
  private scenes: ObsScene[] = [];
  private currentScene: string | null = null;
  private settings: ConnSettings | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Счётчик попыток переподключения. Живёт в памяти + в storage: при
   * выгрузке service worker он обнулялся, и лимит в 10 попыток фактически
   * становился бесконечным — недоступный OBS долбился вечно (аудит
   * lifecycle 01.08.2026, находка 13).
   */
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  /**
   * 20с, а не 30: Chrome убивает service worker после 30 секунд без
   * активности, и heartbeat, назначенный ровно на границу, конкурировал с
   * завершением воркера (официальный пример Chrome тоже шлёт keepalive раз в
   * 20с). Аудит lifecycle 01.08.2026, находка 4.
   */
  private readonly heartbeatInterval = 20_000;
  private readonly connectionTimeout = 10_000;
  private connecting = false;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private retryBlocked = false;

  /** Подтянуть счётчик попыток с диска (воркер мог выгружаться). */
  private async restoreReconnectAttempts(): Promise<void> {
    try {
      const r = (await browser.storage.local.get({ [OBS_RECONNECT_ATTEMPTS_KEY]: 0 })) as Record<
        string,
        unknown
      >;
      const n = Number(r[OBS_RECONNECT_ATTEMPTS_KEY]);
      if (Number.isFinite(n) && n > this.reconnectAttempts) this.reconnectAttempts = n;
    } catch {
      /* недоступно — работаем со счётчиком в памяти */
    }
  }

  async connect(url: string, password = ""): Promise<boolean> {
    await this.restoreReconnectAttempts();
    if (this.connecting) {
      if (this.settings?.url === url && this.settings.password === password) return false;
      this.closeCurrentSocket("Superseded by new connection");
      while (this.connecting) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
    }
    this.connecting = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.settings = { url, password };
    // Старый сокет отвязываем ДО замены: его onclose иначе убивал учёт нового.
    if (this.socket) {
      this.closeCurrentSocket("Superseded by new connection");
    }
    try {
      return await new Promise<boolean>((resolve, reject) => {
        this.connectionReject = reject;
        const socket = new WebSocket(url);
        this.socket = socket;

        const timeout = setTimeout(() => {
          if (!this.isConnected) {
            this.clearConnectionAttempt();
            socket.close();
            reject(new Error("Connection timeout"));
          }
        }, this.connectionTimeout);
        this.connectionTimer = timeout;

        // Identify уходит ТОЛЬКО после Hello (op:0) — раньше он слался в onopen
        // с сырым паролем, без challenge-response. OBS с включённой
        // аутентификацией закрывал соединение кодом 4009, и парольное
        // подключение не работало никогда (унаследовано от legacy).
        socket.onmessage = (event) => {
          this.lastHeartbeat = Date.now();
          let msg: any;
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            log.warn("obs", "malformed frame ignored");
            return;
          }
          if (msg.op === 0) {
            void this.identify(socket, password, msg.d?.authentication);
            return;
          }
          // Identified (op:2) => соединение готово
          if (msg.op === 2 && !this.isConnected) {
            this.clearConnectionAttempt();
            this.isConnected = true;
            this.sessionId = this.makeSessionId();
            this.reconnectAttempts = 0;
            void browser.storage.local
              .set({ [OBS_RECONNECT_ATTEMPTS_KEY]: 0 })
              .catch(() => undefined);
            void this.setRetryBlocked(false);
            this.lastHeartbeat = Date.now();
            this.startHeartbeat();
            void this.saveConnectionState(true);
            this.notifyAll("obs_connected");
            resolve(true);
          }
          this.handleMessage(msg);
        };
        socket.onclose = (event) => {
          log.info("obs", "disconnected", event.code, event.reason);
          const wasConnected = this.isConnected;
          this.teardownSocket();
          const authBlocked = [4008, 4009].includes(event.code);
          const protocolBlocked = [4010, 4011].includes(event.code);
          if (authBlocked || protocolBlocked) {
            void this.setRetryBlocked(true, authBlocked ? "auth" : "protocol");
          }
          void this.saveConnectionState(false);
          this.notifyAll("obs_disconnected");
          // До Identified закрытие — это ОТКАЗ подключения: реджектим сразу,
          // а не висим 10 секунд с connecting=true (4009 = неверный пароль).
          if (!wasConnected) {
            this.clearConnectionAttempt();
            reject(
              new Error(
                event.code === 4009
                  ? "Неверный пароль OBS"
                  : `OBS закрыл соединение (код ${event.code})`,
              ),
            );
          }
          // 4008/4009 — проблема аутентификации, 4010/4011 — несовместимость:
          // с теми же кредами/версией повтор бессмыслен, не долбим OBS.
          const noRetry = [1000, 4008, 4009, 4010, 4011];
          if (!noRetry.includes(event.code)) this.attemptReconnect();
        };
        socket.onerror = (err) => {
          log.error("obs", "socket error", err);
          if (!this.isConnected) {
            this.clearConnectionAttempt();
            this.stopHeartbeat();
            reject(new Error("WebSocket error"));
          }
        };
      });
    } finally {
      this.clearConnectionAttempt();
      this.connecting = false;
    }
  }

  /** Явное действие пользователя — свежий лимит реконнектов. */
  /**
   * Обнулить бюджет попыток — И В ПАМЯТИ, И НА ДИСКЕ.
   *
   * Без сброса персистентного счётчика ручное «Подключиться» после серии
   * неудач становилось одноразовым: connect() подтягивал с диска старые 10
   * попыток, и первый же неуспех (OBS ещё грузится — обычное дело) лишал
   * автоповторов до перезапуска браузера (ревью пакета C, находка 2).
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
    void browser.storage.local
      .set({ [OBS_RECONNECT_ATTEMPTS_KEY]: 0 })
      .catch(() => undefined);
  }

  async allowAutoReconnect(): Promise<void> {
    await this.setRetryBlocked(false);
    // Пользователь исправил креды/хост — бюджет попыток обязан ожить.
    this.resetReconnectAttempts();
  }

  private makeSessionId(): string {
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `obs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private teardownSocket(): void {
    this.isConnected = false;
    this.sessionId = null;
    this.socket = null;
    this.stopHeartbeat();
  }

  private clearConnectionAttempt(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
    this.connectionReject = null;
  }

  private closeCurrentSocket(reason: string): void {
    const socket = this.socket;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, reason);
      } catch {
        /* уже закрыт */
      }
    }
    const reject = this.connectionReject;
    this.clearConnectionAttempt();
    this.teardownSocket();
    reject?.(new Error(reason));
    for (const [, pending] of this.pending) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private attemptReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.settings) return;
    this.reconnectAttempts++;
    void browser.storage.local
      .set({ [OBS_RECONNECT_ATTEMPTS_KEY]: this.reconnectAttempts })
      .catch(() => undefined);
    const delay = Math.min(2000 * this.reconnectAttempts, 30_000);
    log.info("obs", `reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(this.settings!.url, this.settings!.password);
      } catch {
        this.attemptReconnect();
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > this.heartbeatInterval * 2) {
        this.handleConnectionLost();
      } else {
        void this.verifyConnection();
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleConnectionLost(): void {
    log.warn("obs", "connection lost (heartbeat timeout)");
    // Немедленный teardown, не дожидаясь onclose: на мёртвом TCP браузер
    // отдаёт close-событие с задержкой, и всё это окно панель врала бы
    // «Подключено». (Прежний вариант держал cleanup в catch-ветке, куда
    // close(4000) никогда не попадает — она была мертва.)
    this.closeCurrentSocket("Heartbeat timeout");
    void this.saveConnectionState(false);
    this.notifyAll("obs_disconnected");
    this.attemptReconnect();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeCurrentSocket("Manual disconnect");
    this.scenes = [];
    this.currentScene = null;
    this.settings = null;
    this.reconnectAttempts = 0;
    this.notifyAll("obs_disconnected");
    void this.saveConnectionState(false);
  }

  /**
   * Identify (op:1) по спеке obs-websocket v5.
   * При включённой в OBS аутентификации Hello приносит {salt, challenge}, и в
   * ответе должен уйти base64(SHA256( base64(SHA256(password+salt)) + challenge )).
   */
  private async identify(
    socket: WebSocket,
    password: string,
    auth?: { challenge: string; salt: string },
  ): Promise<void> {
    let authentication: string | undefined;
    if (auth?.challenge && auth?.salt) {
      if (!password) {
        log.warn("obs", "OBS требует пароль, а он не задан");
        // Отправляем Identify без auth — OBS ответит 4008, onclose покажет ошибку.
      } else {
        const secret = await sha256b64(password + auth.salt);
        authentication = await sha256b64(secret + auth.challenge);
      }
    }
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({
        op: 1,
        d: {
          rpcVersion: 1,
          authentication,
          eventSubscriptions: 1023,
        },
      }));
    } catch (e) {
      log.error("obs", "identify failed", e);
    }
  }

  private send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(message: any): void {
    switch (message.op) {
      case 2: // Identified
        void this.requestSceneList();
        break;
      case 5: // Event
        this.handleEvent(message.d);
        break;
      case 7: // RequestResponse
        this.handleResponse(message.d);
        break;
      default:
        break;
    }
  }

  private handleEvent(eventData: any): void {
    switch (eventData.eventType) {
      case "CurrentProgramSceneChanged":
        this.currentScene = eventData.eventData.sceneName;
        this.notifyAll("obs_scene_changed", this.currentScene);
        void this.saveConnectionState(true);
        break;
      case "SceneListChanged":
      case "SceneNameChanged":
      case "SceneCreated":
      case "SceneRemoved":
        void this.requestSceneList();
        break;
      default:
        break;
    }
  }

  private handleResponse(data: any): void {
    const p = this.pending.get(data.requestId);
    if (!p) return;
    this.pending.delete(data.requestId);
    if (data.requestStatus?.result) p.resolve(data.responseData);
    else p.reject(new Error(data.requestStatus?.comment || "OBS request failed"));
  }

  private request<T = any>(requestType: string, requestData: object = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = this.requestId++;
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.send({ op: 6, d: { requestType, requestId, requestData } });
      } catch (e) {
        this.pending.delete(requestId);
        reject(e as Error);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error("Request timeout"));
        }
      }, 10_000);
    });
  }

  async requestSceneList(): Promise<ObsScene[]> {
    const res = await this.request<{ scenes: ObsScene[]; currentProgramSceneName: string }>(
      "GetSceneList",
    );
    this.scenes = res.scenes || [];
    this.currentScene = res.currentProgramSceneName;
    this.notifyAll("obs_scenes_updated", this.sceneData());
    void this.saveConnectionState(true);
    return this.scenes;
  }

  async setCurrentScene(sceneName: string): Promise<boolean> {
    await this.request("SetCurrentProgramScene", { sceneName });
    this.currentScene = sceneName;
    this.notifyAll("obs_scene_changed", sceneName);
    void this.saveConnectionState(true);
    return true;
  }

  private sceneData(): ObsSceneData {
    return { scenes: this.scenes, currentScene: this.currentScene };
  }

  getStatus() {
    return {
      connected: this.isConnected,
      scenes: this.scenes,
      currentScene: this.currentScene,
      sessionId: this.sessionId,
    };
  }

  isConnectedTo(url: string, password: string): boolean {
    return (
      this.isConnected && this.settings?.url === url && this.settings.password === password
    );
  }

  hasConnectionActivity(): boolean {
    return this.isConnected || this.connecting || this.socket !== null || this.reconnectTimer !== null;
  }

  isAutoReconnectBlocked(): boolean {
    return this.retryBlocked;
  }

  /** Проверка живого сокета; успешный ответ освежает persisted timestamp. */
  async verifyConnection(): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      await this.request("GetVersion");
      this.lastHeartbeat = Date.now();
      await this.saveConnectionState(true);
      return true;
    } catch {
      return false;
    }
  }

  private async saveConnectionState(connected: boolean): Promise<void> {
    const state: ObsConnectionState = {
      connected,
      scenes: connected ? this.scenes : [],
      currentScene: connected ? this.currentScene : null,
      sessionId: connected ? this.sessionId : null,
      timestamp: Date.now(),
    };
    try {
      await browser.storage.local.set({ obs_connection_state: state });
    } catch (e) {
      log.error("obs", "failed to persist connection state", e);
    }
  }

  private async setRetryBlocked(blocked: boolean, reason?: "auth" | "protocol"): Promise<void> {
    this.retryBlocked = blocked;
    try {
      await browser.storage.local.set({
        [OBS_RETRY_BLOCKED_KEY]: blocked,
        [OBS_RETRY_BLOCK_REASON_KEY]: blocked ? (reason ?? "auth") : null,
      });
    } catch (e) {
      log.error("obs", "failed to persist retry state", e);
    }
  }

  /** Уведомить и popup, и все вкладки игры одним вызовом. */
  private notifyAll(eventType: any, data: unknown = null): void {
    void sendRuntime({ type: "obs_event", eventType, data });
    void broadcastToGameTabs({ type: "obs_event", eventType, data });
  }
}
