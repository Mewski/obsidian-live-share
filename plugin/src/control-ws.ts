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
  | "present-start"
  | "present-stop"
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
  private settings: LiveShareSettings;
  private isDestroyed = false;
  private e2e: E2ECrypto | null = null;
  private stateChangeCallback: ((state: "connected" | "disconnected") => void) | null = null;

  private latencyMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTime = 0;

  constructor(settings: LiveShareSettings, e2e?: E2ECrypto) {
    this.settings = settings;
    this.e2e = e2e ?? null;
  }

  onStateChange(callback: (state: "connected" | "disconnected") => void) {
    this.stateChangeCallback = callback;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  connect(): void {
    if (this.isDestroyed) return;
    const wsUrl = toWsUrl(this.settings.serverUrl);
    let url = `${wsUrl}/control/${this.settings.roomId}?token=${encodeURIComponent(this.settings.token)}`;
    if (this.settings.jwt) url += `&jwt=${encodeURIComponent(this.settings.jwt)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.stateChangeCallback?.("connected");
      this.startPing();
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
      if (!this.isDestroyed) {
        this.isDestroyed = true;
        this.stateChangeCallback?.("disconnected");
      }
    };

    this.ws.onerror = () => {};
  }

  send(msg: ControlMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const encryptable =
      msg.type === "file-op" ||
      msg.type === "file-chunk-start" ||
      msg.type === "file-chunk-data" ||
      msg.type === "file-chunk-end";
    if (this.e2e?.enabled && encryptable) {
      this.encryptAndSend(msg);
    } else {
      this.ws.send(JSON.stringify(msg));
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
      if (
        (msg.type === "file-chunk-start" || msg.type === "file-chunk-end") &&
        typeof msg.path === "string"
      ) {
        const encrypted = await this.e2e.encryptString(msg.path);
        this.ws.send(JSON.stringify({ ...msg, path: encrypted, encrypted: true }));
      } else if (msg.type === "file-chunk-data" && typeof msg.data === "string") {
        const encryptedData = await this.e2e.encryptString(msg.data);
        const encryptedPath =
          typeof msg.path === "string" ? await this.e2e.encryptString(msg.path) : msg.path;
        this.ws.send(
          JSON.stringify({
            ...msg,
            data: encryptedData,
            path: encryptedPath,
            encrypted: true,
          }),
        );
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
      // Encryption failed; drop the message rather than sending plaintext
    }
  }

  private async decryptAndDispatch(msg: ControlMessage): Promise<void> {
    if (!this.e2e) return;
    try {
      let decryptedMsg: ControlMessage;
      if (
        (msg.type === "file-chunk-start" || msg.type === "file-chunk-end") &&
        typeof msg.path === "string"
      ) {
        const decryptedPath = await this.e2e.decryptString(msg.path);
        decryptedMsg = { ...msg, path: decryptedPath, encrypted: undefined };
      } else if (msg.type === "file-chunk-data" && typeof msg.data === "string") {
        const decryptedData = await this.e2e.decryptString(msg.data);
        const decryptedPath =
          typeof msg.path === "string" ? await this.e2e.decryptString(msg.path) : msg.path;
        decryptedMsg = {
          ...msg,
          data: decryptedData,
          path: decryptedPath,
          encrypted: undefined,
        };
      } else {
        const op = msg.op as Record<string, unknown> | undefined;
        if (op && typeof op.content === "string") {
          const decrypted = await this.e2e.decryptString(op.content);
          decryptedMsg = {
            ...msg,
            op: { ...op, content: decrypted },
            encrypted: undefined,
          };
        } else {
          decryptedMsg = msg;
        }
      }
      const handlers = this.handlers.get(decryptedMsg.type as ControlMessageType);
      if (handlers) {
        for (const handler of handlers) handler(decryptedMsg as ControlMessage);
      }
    } catch {
      // Decryption failed; ignore malformed/miskeyed message
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
    this.isDestroyed = true;
    this.stateChangeCallback?.("disconnected");
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
  }
}
