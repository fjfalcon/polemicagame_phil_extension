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
import type { ObsScene, ObsSceneData } from "@shared/types";

interface ConnSettings {
  url: string;
  password: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

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
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private readonly heartbeatInterval = 30_000;
  private readonly connectionTimeout = 10_000;
  private connecting = false;

  async connect(url: string, password = ""): Promise<boolean> {
    if (this.connecting) return false;
    this.connecting = true;
    this.settings = { url, password };
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const socket = new WebSocket(url);
        this.socket = socket;

        const timeout = setTimeout(() => {
          if (!this.isConnected) {
            socket.close();
            reject(new Error("Connection timeout"));
          }
        }, this.connectionTimeout);

        socket.onopen = () => {
          this.identify(password);
        };
        socket.onmessage = (event) => {
          this.lastHeartbeat = Date.now();
          const msg = JSON.parse(event.data);
          // Identified (op:2) => соединение готово
          if (msg.op === 2 && !this.isConnected) {
            clearTimeout(timeout);
            this.isConnected = true;
            this.sessionId = this.makeSessionId();
            this.reconnectAttempts = 0;
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
          this.teardownSocket();
          void this.saveConnectionState(false);
          this.notifyAll("obs_disconnected");
          if (event.code !== 1000) this.attemptReconnect();
        };
        socket.onerror = (err) => {
          log.error("obs", "socket error", err);
          if (!this.isConnected) {
            clearTimeout(timeout);
            this.stopHeartbeat();
            reject(new Error("WebSocket error"));
          }
        };
      });
    } finally {
      this.connecting = false;
    }
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

  private attemptReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.settings) return;
    this.reconnectAttempts++;
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
        this.request("GetVersion").catch(() => undefined);
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
    this.socket?.close();
    this.teardownSocket();
    this.notifyAll("obs_disconnected");
    this.attemptReconnect();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.socket?.close(1000, "Manual disconnect");
    this.socket = null;
    this.isConnected = false;
    this.sessionId = null;
    this.scenes = [];
    this.currentScene = null;
    this.settings = null;
    this.reconnectAttempts = 0;
    this.notifyAll("obs_disconnected");
    void this.saveConnectionState(false);
  }

  private identify(password: string): void {
    this.send({
      op: 1,
      d: {
        rpcVersion: 1,
        authentication: password || undefined,
        eventSubscriptions: 1023,
      },
    });
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

  private async saveConnectionState(connected: boolean): Promise<void> {
    await browser.storage.local.set({
      obs_connection_state: {
        connected,
        scenes: this.scenes,
        currentScene: this.currentScene,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      },
    });
  }

  /** Уведомить и popup, и все вкладки игры одним вызовом. */
  private notifyAll(eventType: any, data: unknown = null): void {
    void sendRuntime({ type: "obs_event", eventType, data });
    void broadcastToGameTabs({ type: "obs_event", eventType, data });
  }
}
