/** Control channel WebSocket client with reconnect, message queue, and encryption. */

import type { E2ECrypto } from "./crypto";
import type { LiveShareSettings } from "./types";
import { toWsUrl } from "./utils";

export type ControlMessageType =
  | "file-op"
  | "file-chunk-start"
  | "file-chunk-data"
  | "file-chunk-end"
  | "presence-update"
  | "presence-leave"
  | "session-end"
  | "join-request"
  | "join-response"
  | "focus-request"
  | "summon"
  | "kick"
  | "kicked"
  | "sync-request"
  | "sync-response"
  | "set-permission"
  | "permission-update"
  | "ping"
  | "pong";

export interface ControlMessage {
  type: ControlMessageType;
  [key: string]: unknown;
}

type Handler = (msg: ControlMessage) => void;

export class ControlChannel {
  private ws: WebSocket | null = null;
  private handlers = new Map<ControlMessageType, Handler[]>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private settings: LiveShareSettings;
  private destroyed = false;
  private reconnectAttempt = 0;
  private e2e: E2ECrypto | null = null;
  private stateChangeCallback:
    | ((state: "connected" | "disconnected" | "reconnecting") => void)
    | null = null;

  private sendQueue: ControlMessage[] = [];
  private reconnectCallback: (() => void) | null = null;

  private hasConnected = false;

  private latencyMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTime = 0;

  constructor(settings: LiveShareSettings, e2e?: E2ECrypto) {
    this.settings = settings;
    this.e2e = e2e ?? null;
  }

  onStateChange(callback: (state: "connected" | "disconnected" | "reconnecting") => void) {
    this.stateChangeCallback = callback;
  }

  onReconnect(callback: () => void) {
    this.reconnectCallback = callback;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  connect(): void {
    if (this.destroyed) return;
    const wsUrl = toWsUrl(this.settings.serverUrl);
    let url = `${wsUrl}/control/${this.settings.roomId}?token=${encodeURIComponent(this.settings.token)}`;
    if (this.settings.jwt) url += `&jwt=${encodeURIComponent(this.settings.jwt)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      const wasReconnect = this.hasConnected;
      this.hasConnected = true;
      this.reconnectDelay = 1000;
      this.reconnectAttempt = 0;
      this.stateChangeCallback?.("connected");

      this.flushQueue();
      this.startPing();

      if (wasReconnect) {
        this.reconnectCallback?.();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        ) as ControlMessage & { encrypted?: boolean };

        if (msg.type === "pong") {
          if (this.lastPingTime > 0) {
            this.latencyMs = Date.now() - this.lastPingTime;
            this.lastPingTime = 0;
          }
        }

        if (msg.encrypted && this.e2e?.enabled) {
          this.decryptAndDispatch(msg);
          return;
        }
        const handlers = this.handlers.get(msg.type);
        if (handlers) {
          for (const handler of handlers) handler(msg);
        }
      } catch {
        // Malformed JSON; ignore non-parseable messages
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {};
  }

  send(msg: ControlMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Queue messages instead of silently dropping them.
      // Presence updates are ephemeral -- only keep the latest one.
      if (msg.type === "presence-update") {
        const idx = this.sendQueue.findIndex((m) => m.type === "presence-update");
        if (idx >= 0) {
          this.sendQueue[idx] = msg;
        } else {
          this.sendQueue.push(msg);
        }
      } else {
        this.sendQueue.push(msg);
      }
      return;
    }
    const encryptable =
      msg.type === "file-op" || msg.type === "file-chunk-data" || msg.type === "file-chunk-end";
    if (this.e2e?.enabled && encryptable) {
      this.encryptAndSend(msg);
    } else {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private flushQueue(): void {
    const queue = this.sendQueue.splice(0);
    for (const msg of queue) {
      this.send(msg);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.lastPingTime = Date.now();
        this.ws.send(JSON.stringify({ type: "ping", timestamp: this.lastPingTime }));
      }
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async encryptAndSend(msg: ControlMessage): Promise<void> {
    if (!this.e2e || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      if (msg.type === "file-chunk-data" && typeof msg.data === "string") {
        const encrypted = await this.e2e.encryptString(msg.data as string);
        this.ws.send(JSON.stringify({ ...msg, data: encrypted, encrypted: true }));
      } else {
        const op = msg.op as Record<string, unknown>;
        if (op && typeof op.content === "string") {
          const encrypted = await this.e2e.encryptString(op.content);
          this.ws.send(
            JSON.stringify({
              ...msg,
              op: { ...op, content: encrypted },
              encrypted: true,
            }),
          );
        } else {
          this.ws.send(JSON.stringify(msg));
        }
      }
    } catch {
      // encryption failed -- drop the message rather than sending plaintext
    }
  }

  private async decryptAndDispatch(msg: ControlMessage): Promise<void> {
    if (!this.e2e) return;
    try {
      let decMsg: ControlMessage;
      if (msg.type === "file-chunk-data" && typeof msg.data === "string") {
        const decrypted = await this.e2e.decryptString(msg.data as string);
        decMsg = { ...msg, data: decrypted, encrypted: undefined };
      } else {
        const op = msg.op as Record<string, unknown> | undefined;
        if (op && typeof op.content === "string") {
          const decrypted = await this.e2e.decryptString(op.content);
          decMsg = {
            ...msg,
            op: { ...op, content: decrypted },
            encrypted: undefined,
          };
        } else {
          decMsg = msg;
        }
      }
      const handlers = this.handlers.get(decMsg.type as ControlMessageType);
      if (handlers) {
        for (const handler of handlers) handler(decMsg as ControlMessage);
      }
    } catch {
      // decryption failed -- ignore malformed/miskeyed message
    }
  }

  on(type: ControlMessageType, handler: Handler): void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(handler);
  }

  off(type: ControlMessageType, handler: Handler): void {
    const list = this.handlers.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stateChangeCallback?.("disconnected");
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
    this.sendQueue.length = 0;
    this.reconnectCallback = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    this.stateChangeCallback?.("reconnecting");
    const jitter = this.reconnectDelay * 0.2 * (Math.random() * 2 - 1);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay + jitter);
  }
}
