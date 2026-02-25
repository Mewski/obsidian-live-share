import type { E2ECrypto } from "./crypto";
import type { LiveShareSettings } from "./types";
import { toWsUrl } from "./utils";

export type ControlMessageType =
  | "file-op"
  | "presence-update"
  | "presence-leave"
  | "follow-update"
  | "session-end"
  | "join-request"
  | "join-response"
  | "focus-request"
  | "summon"
  | "kick"
  | "kicked";

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

  constructor(settings: LiveShareSettings, e2e?: E2ECrypto) {
    this.settings = settings;
    this.e2e = e2e ?? null;
  }

  onStateChange(callback: (state: "connected" | "disconnected" | "reconnecting") => void) {
    this.stateChangeCallback = callback;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  connect(): void {
    if (this.destroyed) return;
    const wsUrl = toWsUrl(this.settings.serverUrl);
    let url = `${wsUrl}/control/${this.settings.roomId}?token=${encodeURIComponent(this.settings.token)}`;
    if (this.settings.jwt) url += `&jwt=${encodeURIComponent(this.settings.jwt)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.reconnectAttempt = 0;
      this.stateChangeCallback?.("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        ) as ControlMessage & { encrypted?: boolean };
        if (msg.encrypted && this.e2e?.enabled) {
          this.decryptAndDispatch(msg);
          return;
        }
        const handlers = this.handlers.get(msg.type);
        if (handlers) {
          for (const h of handlers) h(msg);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  send(msg: ControlMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.e2e?.enabled && msg.type === "file-op") {
      // Encrypt file operation content — structure stays intact for server routing
      this.encryptAndSend(msg);
    } else {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async encryptAndSend(msg: ControlMessage): Promise<void> {
    if (!this.e2e || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const op = msg.op as Record<string, unknown>;
      if (op && typeof op.content === "string") {
        const encrypted = await this.e2e.encryptString(op.content);
        const encMsg = {
          ...msg,
          op: { ...op, content: encrypted },
          encrypted: true,
        };
        this.ws.send(JSON.stringify(encMsg));
      } else {
        this.ws.send(JSON.stringify(msg));
      }
    } catch {
      // Fallback to plaintext if encryption fails
      this.ws?.send(JSON.stringify(msg));
    }
  }

  private async decryptAndDispatch(msg: ControlMessage): Promise<void> {
    if (!this.e2e) return;
    try {
      const op = msg.op as Record<string, unknown> | undefined;
      if (op && typeof op.content === "string") {
        const decrypted = await this.e2e.decryptString(op.content);
        const decMsg = {
          ...msg,
          op: { ...op, content: decrypted },
          encrypted: undefined,
        };
        const handlers = this.handlers.get(decMsg.type as ControlMessageType);
        if (handlers) {
          for (const h of handlers) h(decMsg as ControlMessage);
        }
      } else {
        const handlers = this.handlers.get(msg.type);
        if (handlers) {
          for (const h of handlers) h(msg);
        }
      }
    } catch {
      // Decryption failed — drop the message (wrong key or tampered)
      console.warn("Live Share: failed to decrypt control message");
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    this.stateChangeCallback?.("reconnecting");
    // Add jitter: +/- 20%
    const jitter = this.reconnectDelay * 0.2 * (Math.random() * 2 - 1);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay + jitter);
  }
}
