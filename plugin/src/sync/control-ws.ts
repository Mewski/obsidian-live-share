import type {
  ControlMessage,
  ControlMessageMap,
  ControlMessageType,
  LiveShareSettings,
} from "../types";
import { toWsUrl } from "../utils";
import type { E2ECrypto } from "./crypto";

export type { ControlMessage, ControlMessageType };

type Handler<T extends ControlMessageType = ControlMessageType> = (
  msg: ControlMessageMap[T],
) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export class ControlChannel {
  private ws: WebSocket | null = null;
  private handlers = new Map<ControlMessageType, Handler<ControlMessageType>[]>();
  private settings: LiveShareSettings;
  private isDestroyed = false;
  private e2e: E2ECrypto | null = null;
  private stateChangeCallback:
    | ((state: "connected" | "reconnecting" | "disconnected" | "auth-required") => void)
    | null = null;
  private everConnected = false;
  private errorCallback: ((context: string, err: unknown) => void) | null = null;

  private latencyMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTime = 0;

  private shouldConnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(settings: LiveShareSettings, e2e?: E2ECrypto) {
    this.settings = settings;
    this.e2e = e2e ?? null;
  }

  onStateChange(
    callback: (state: "connected" | "reconnecting" | "disconnected" | "auth-required") => void,
  ) {
    this.stateChangeCallback = callback;
  }

  onError(callback: (context: string, err: unknown) => void) {
    this.errorCallback = callback;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  connect(): void {
    if (this.isDestroyed) return;
    this.shouldConnect = true;
    this.reconnectAttempts = 0;
    this.everConnected = false;
    this.openWebSocket();
  }

  private openWebSocket(): void {
    if (this.isDestroyed || !this.shouldConnect) return;
    const wsUrl = toWsUrl(this.settings.serverUrl);
    let url = `${wsUrl}/control/${encodeURIComponent(this.settings.roomId)}?token=${encodeURIComponent(this.settings.token)}`;
    if (this.settings.jwt) url += `&jwt=${encodeURIComponent(this.settings.jwt)}`;
    if (this.settings.serverPassword)
      url += `&password=${encodeURIComponent(this.settings.serverPassword)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.everConnected = true;
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
          for (const handler of handlers) handler(msg as never);
        }
      } catch (err) {
        this.errorCallback?.("message", err);
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.isDestroyed) return;
      if (!this.everConnected && this.reconnectAttempts === 0) {
        this.shouldConnect = false;
        this.stateChangeCallback?.("auth-required");
        return;
      }
      if (this.shouldConnect) {
        this.stateChangeCallback?.("reconnecting");
        this.scheduleReconnect();
      } else {
        this.stateChangeCallback?.("disconnected");
      }
    };

    this.ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.shouldConnect = false;
      this.stateChangeCallback?.("disconnected");
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldConnect) this.openWebSocket();
    }, delay);
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

  on<T extends ControlMessageType>(type: T, handler: (msg: ControlMessageMap[T]) => void): void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(handler as Handler<ControlMessageType>);
  }

  off<T extends ControlMessageType>(type: T, handler: (msg: ControlMessageMap[T]) => void): void {
    const list = this.handlers.get(type);
    if (list) {
      const idx = list.indexOf(handler as Handler<ControlMessageType>);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.shouldConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    const wasOpen = this.ws !== null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (wasOpen) {
      this.stateChangeCallback?.("disconnected");
    }
    this.handlers.clear();
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
      } else if (msg.type === "file-op") {
        const op = msg.op as unknown as Record<string, unknown>;
        if (op && typeof op.content === "string") {
          const encryptedOp: Record<string, unknown> = {
            ...op,
            content: await this.e2e.encryptString(op.content),
          };
          if (typeof op.path === "string") encryptedOp.path = await this.e2e.encryptString(op.path);
          if (typeof op.oldPath === "string")
            encryptedOp.oldPath = await this.e2e.encryptString(op.oldPath);
          if (typeof op.newPath === "string")
            encryptedOp.newPath = await this.e2e.encryptString(op.newPath);
          this.ws.send(
            JSON.stringify({
              ...msg,
              op: encryptedOp,
              encrypted: true,
            }),
          );
        } else if (op) {
          const encryptedOp: Record<string, unknown> = { ...op };
          if (typeof op.path === "string") encryptedOp.path = await this.e2e.encryptString(op.path);
          if (typeof op.oldPath === "string")
            encryptedOp.oldPath = await this.e2e.encryptString(op.oldPath);
          if (typeof op.newPath === "string")
            encryptedOp.newPath = await this.e2e.encryptString(op.newPath);
          this.ws.send(JSON.stringify({ ...msg, op: encryptedOp, encrypted: true }));
        } else {
          this.ws.send(JSON.stringify(msg));
        }
      }
    } catch (err) {
      this.errorCallback?.("encrypt", err);
    }
  }

  private async decryptAndDispatch(raw: ControlMessage & { encrypted?: boolean }): Promise<void> {
    if (!this.e2e) return;
    try {
      const { encrypted: _, ...msg } = raw;
      let decryptedMsg: ControlMessage;
      if (
        (msg.type === "file-chunk-start" || msg.type === "file-chunk-end") &&
        typeof msg.path === "string"
      ) {
        const decryptedPath = await this.e2e.decryptString(msg.path);
        decryptedMsg = { ...msg, path: decryptedPath };
      } else if (msg.type === "file-chunk-data" && typeof msg.data === "string") {
        const decryptedData = await this.e2e.decryptString(msg.data);
        const decryptedPath =
          typeof msg.path === "string" ? await this.e2e.decryptString(msg.path) : msg.path;
        decryptedMsg = {
          ...msg,
          data: decryptedData,
          path: decryptedPath,
        };
      } else if (msg.type === "file-op") {
        const op = msg.op as unknown as Record<string, unknown>;
        if (op && typeof op.content === "string") {
          const decryptedOp: Record<string, unknown> = {
            ...op,
            content: await this.e2e.decryptString(op.content),
          };
          if (typeof op.path === "string") decryptedOp.path = await this.e2e.decryptString(op.path);
          if (typeof op.oldPath === "string")
            decryptedOp.oldPath = await this.e2e.decryptString(op.oldPath);
          if (typeof op.newPath === "string")
            decryptedOp.newPath = await this.e2e.decryptString(op.newPath);
          decryptedMsg = {
            ...msg,
            op: decryptedOp,
          } as unknown as ControlMessage;
        } else if (op) {
          const decryptedOp: Record<string, unknown> = { ...op };
          if (typeof op.path === "string") decryptedOp.path = await this.e2e.decryptString(op.path);
          if (typeof op.oldPath === "string")
            decryptedOp.oldPath = await this.e2e.decryptString(op.oldPath);
          if (typeof op.newPath === "string")
            decryptedOp.newPath = await this.e2e.decryptString(op.newPath);
          decryptedMsg = {
            ...msg,
            op: decryptedOp,
          } as unknown as ControlMessage;
        } else {
          decryptedMsg = msg;
        }
      } else {
        decryptedMsg = msg;
      }
      const handlers = this.handlers.get(decryptedMsg.type);
      if (handlers) {
        for (const handler of handlers) handler(decryptedMsg as never);
      }
    } catch (err) {
      this.errorCallback?.("decrypt", err);
    }
  }
}
