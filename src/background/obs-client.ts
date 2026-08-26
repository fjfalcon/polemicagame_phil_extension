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

/**
 * Адрес OBS для лога: только схема, хост и порт.
 *
 * В `obs_host` пользователь может вписать `ws://user:pass@host:4455/?token=…`
 * — логин, пароль и query оттуда в файл поддержки уезжать не должны (аудит
 * наблюдаемости 02.08.2026, LOG-3).
 */
import { safeEndpoint } from "@shared/safe-endpoint";
export { safeEndpoint };

/**
 * Категория неудачной попытки подключения — вместо сырого `Error.message`.
 * Текст ошибки может содержать адрес с логином и паролем, а нам нужен только
 * класс отказа (аудит наблюдаемости 02.08.2026, OC-1).
 */
export function failureCategory(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/timeout/i.test(msg)) return "таймаут подключения";
  if (/Неверный пароль/i.test(msg)) return "неверный пароль";
  if (/код 4010|код 4011/i.test(msg)) return "несовместимая версия obs-websocket";
  if (/закрыл соединение|closed/i.test(msg)) return "OBS закрыл соединение";
  if (/WebSocket error|socket/i.test(msg)) return "ошибка сокета";
  if (/Superseded/i.test(msg)) return "заменено новым подключением";
  return "прочее";
}

/** Человеческая категория кода закрытия WebSocket — вместо текста от сервера. */
export function closeCategory(code: number): string {
  if (code === 1000) return "штатное закрытие";
  if (code === 4009 || code === 4008) return "аутентификация отклонена";
  if (code === 4010 || code === 4011) return "несовместимая версия obs-websocket";
  if (code === 1006) return "обрыв связи";
  return "прочее";
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** Таймер «ответа нет 10с»: гасится при ответе, иначе каждый успешный
   * запрос оставлял no-op callback — 240 пустых пробуждений/час на одних
   * heartbeat'ах (перф-аудит 06.08.2026, PERF-8). */
  timer: ReturnType<typeof setTimeout>;
};
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
  /** Когда obs_connection_state писался в последний раз (см. refreshConnectionState). */
  private lastStateWrite = 0;
  /**
   * Минимальный интервал между ЧИСТО freshness-записями obs_connection_state.
   *
   * Heartbeat раз в 20с освежал timestamp на каждом успехе — 240 записей
   * storage.local в час на пустом месте (перф-аудит 06.08.2026, PERF-8).
   * 45с при шаге heartbeat 20с даёт фактическую запись раз в 60с — с
   * двукратным запасом до OBS_STATE_MAX_AGE_MS (2 мин) в obs-panel, иначе
   * restore автосцены в content счёл бы state протухшим. Записи-СОБЫТИЯ
   * (подключение, обрыв, смена сцены, список сцен) не троттлятся.
   */
  private readonly stateRefreshMinIntervalMs = 45_000;

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
            log.info("obs", "подключено", safeEndpoint(url));
            this.notifyAll("obs_connected");
            resolve(true);
          }
          this.handleMessage(msg);
        };
        socket.onclose = (event) => {
          const wasConnected = this.isConnected;
          this.teardownSocket();
          const authBlocked = [4008, 4009].includes(event.code);
          const protocolBlocked = [4010, 4011].includes(event.code);
          // Одна строка с ПРИНЯТЫМ РЕШЕНИЕМ: из голого «disconnected code
          // reason» нельзя было понять, на какой стадии оборвалось и будет ли
          // повтор (аудит наблюдаемости 02.08.2026, OC-4). Текст причины от
          // сервера не пишем — в него может попасть что угодно (LOG-3).
          const willBlock = authBlocked || protocolBlocked;
          log.info(
            "obs",
            "соединение закрыто:",
            wasConnected ? "стадия=рабочая" : "стадия=рукопожатие",
            `код=${event.code}`,
            closeCategory(event.code),
            "| дальше:",
            willBlock ? "блокируем автоповторы" : event.code === 1000 ? "не повторяем" : "повтор",
          );
          if (willBlock) {
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
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private attemptReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.settings) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Молчаливая остановка автоповторов = «всё вдруг перестало работать» без
      // единого следа в логе. Бюджет переживает выгрузку воркера, поэтому
      // строка обязана быть на info (разбор жалобы 02.08.2026).
      log.info(
        "obs",
        `бюджет переподключений исчерпан (${this.reconnectAttempts}/${this.maxReconnectAttempts}) —`,
        "автоповторы остановлены до ручного подключения или правки настроек",
      );
      return;
    }
    this.reconnectAttempts++;
    void browser.storage.local
      .set({ [OBS_RECONNECT_ATTEMPTS_KEY]: this.reconnectAttempts })
      .catch(() => undefined);
    const delay = Math.min(2000 * this.reconnectAttempts, 30_000);
    log.info("obs", `reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(this.settings!.url, this.settings!.password);
      } catch (e) {
        // Итог КАЖДОЙ попытки: раньше reject внутри таймера поглощался
        // целиком, и по логу нельзя было понять, чем закончилась попытка №4
        // — таймаутом, отказом сокета или закрытием (OC-1). Ни адреса, ни
        // пароля, ни сырого текста ошибки: только категория.
        log.warn(
          "obs",
          `переподключение не удалось: попытка ${this.reconnectAttempts}/${this.maxReconnectAttempts},`,
          "причина:",
          failureCategory(e),
        );
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
      case "CurrentProgramSceneChanged": {
        const name = eventData.eventData.sceneName;
        // Эхо нашего же setCurrentScene: state уже применён и разослан —
        // второй notifyAll давал 2×tabs.query и 2N сообщений вкладкам на
        // каждую смену фазы (PERF26-17). Внешняя смена на ту же сцену —
        // no-op и для нас, и для подписчиков.
        if (name === this.currentScene) break;
        this.currentScene = name;
        this.notifyAll("obs_scene_changed", this.currentScene);
        void this.saveConnectionState(true);
        break;
      }
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
    clearTimeout(p.timer);
    if (data.requestStatus?.result) p.resolve(data.responseData);
    else p.reject(new Error(data.requestStatus?.comment || "OBS request failed"));
  }

  private request<T = any>(requestType: string, requestData: object = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = this.requestId++;
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error("Request timeout"));
        }
      }, 10_000);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send({ op: 6, d: { requestType, requestId, requestData } });
      } catch (e) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(e as Error);
        return;
      }
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

  // ── запись и буфер повторов (стримерский пакет 26.08.2026) ──

  /** Идёт ли сейчас запись в OBS. */
  async isRecording(): Promise<boolean> {
    const res = await this.request<{ outputActive?: boolean }>("GetRecordStatus");
    return res?.outputActive === true;
  }

  async startRecord(): Promise<void> {
    await this.request("StartRecord");
  }

  /** Останавливает запись; OBS возвращает путь готового файла (если отдал). */
  async stopRecord(): Promise<string | null> {
    const res = await this.request<{ outputPath?: string }>("StopRecord");
    return typeof res?.outputPath === "string" ? res.outputPath : null;
  }

  /** Активен ли буфер повторов (Replay Buffer). */
  async isReplayBufferActive(): Promise<boolean> {
    const res = await this.request<{ outputActive?: boolean }>("GetReplayBufferStatus");
    return res?.outputActive === true;
  }

  async startReplayBuffer(): Promise<void> {
    await this.request("StartReplayBuffer");
  }

  async stopReplayBuffer(): Promise<void> {
    await this.request("StopReplayBuffer");
  }

  async saveReplayBuffer(): Promise<void> {
    await this.request("SaveReplayBuffer");
  }

  async getProfileParameter(category: string, name: string): Promise<string | null> {
    const res = await this.request<{ parameterValue?: string | null }>("GetProfileParameter", {
      parameterCategory: category,
      parameterName: name,
    });
    return typeof res?.parameterValue === "string" ? res.parameterValue : null;
  }

  async setProfileParameter(category: string, name: string, value: string): Promise<void> {
    await this.request("SetProfileParameter", {
      parameterCategory: category,
      parameterName: name,
      parameterValue: value,
    });
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

  /**
   * Свежо ли последнее подтверждение живости (входящий кадр или успешная
   * проба)? Порог — тот же, что у самого heartbeat: пока он не считает
   * соединение потерянным, внешняя alarm-проба не добавляет знания.
   *
   * Нужен watchdog'у: его минутная GetVersion-проба поверх живого heartbeat
   * давала 4-ю пробу в минуту (перф-аудит 06.08.2026, PERF-8, бюджет ≤3/мин).
   */
  hasFreshHeartbeat(): boolean {
    return this.isConnected && Date.now() - this.lastHeartbeat <= this.heartbeatInterval * 2;
  }

  /**
   * Исчерпан ли ОБЩИЙ бюджет попыток подключения — с учётом диска (воркер
   * мог перезапуститься). Раньше лимит в 10 попыток останавливал только
   * цепочку attemptReconnect, а watchdog/restore заходили через connect()
   * заново каждую минуту — бесконечно (перф-аудит 06.08.2026, PERF-8).
   */
  async isAttemptBudgetExhausted(): Promise<boolean> {
    await this.restoreReconnectAttempts();
    return this.reconnectAttempts >= this.maxReconnectAttempts;
  }

  /** Проверка живого сокета; успешный ответ освежает persisted timestamp. */
  async verifyConnection(): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      await this.request("GetVersion");
      this.lastHeartbeat = Date.now();
      await this.refreshConnectionState();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Freshness-запись с троттлингом: содержимое state не меняется, обновляется
   * только timestamp — писать его на каждый heartbeat (раз в 20с) незачем.
   * Событийные записи идут напрямую через saveConnectionState и сбрасывают
   * отсчёт интервала.
   */
  private async refreshConnectionState(): Promise<void> {
    if (Date.now() - this.lastStateWrite < this.stateRefreshMinIntervalMs) return;
    await this.saveConnectionState(true);
  }

  private async saveConnectionState(connected: boolean): Promise<void> {
    this.lastStateWrite = Date.now();
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
    if (blocked !== this.retryBlocked) {
      // Блокировка гасит и watchdog: без соединения будить воркер каждую
      // минуту незачем. Значит это состояние «само не починится» — и в логе
      // оно обязано быть видно вместе с причиной.
      log.info(
        "obs",
        blocked
          ? `автоповторы заблокированы (${reason ?? "auth"}): ${
              reason === "protocol"
                ? "несовместимая версия obs-websocket"
                : "OBS отверг аутентификацию"
            }`
          : "автоповторы разблокированы",
      );
    }
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
