import type { LiveShareSettings } from "./types";

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
  private stateChangeCallback:
    | ((state: "connected" | "disconnected" | "reconnecting") => void)
    | null = null;

  constructor(settings: LiveShareSettings) {
    this.settings = settings;
  }

  onStateChange(
    callback: (state: "connected" | "disconnected" | "reconnecting") => void,
  ) {
    this.stateChangeCallback = callback;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  connect(): void {
    if (this.destroyed) return;
    const wsUrl = this.settings.serverUrl.replace(/^http/, "ws");
    let url = `${wsUrl}/control/${this.settings.roomId}?token=${encodeURIComponent(this.settings.token)}`;
    if (this.settings.jwt)
      url += `&jwt=${encodeURIComponent(this.settings.jwt)}`;

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
        ) as ControlMessage;
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
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
