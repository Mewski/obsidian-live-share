import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  MUX_AWARENESS,
  MUX_SUBSCRIBE,
  MUX_SUBSCRIBED,
  MUX_SYNC,
  MUX_SYNC_REQUEST,
  MUX_UNSUBSCRIBE,
  decodeMuxMessage,
  encodeMuxMessage,
} from "./mux-protocol";
import type { LiveShareSettings } from "./types";
import { normalizePath, toWsUrl } from "./utils";

const SYNC_STEP2 = 1;
const RECONNECT_BASE_MS = 100;
const RECONNECT_MAX_MS = 30_000;

export interface DocHandle {
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
}

type SyncListener = (synced: boolean) => void;

export class SyncManager {
  private docs = new Map<string, Y.Doc>();
  private awarenessMap = new Map<string, awarenessProtocol.Awareness>();
  private synced = new Map<string, boolean>();
  private syncListeners = new Map<string, Set<SyncListener>>();
  private updateHandlers = new Map<string, (update: Uint8Array, origin: unknown) => void>();
  private awarenessHandlers = new Map<
    string,
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void
  >();
  private settings: LiveShareSettings;
  private isConnected = false;
  private ws: WebSocket | null = null;
  private shouldConnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(settings: LiveShareSettings) {
    this.settings = settings;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  connect(): void {
    this.isConnected = true;
    this.shouldConnect = true;
    this.reconnectAttempts = 0;
    this.openWebSocket();
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.isConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const path of [...this.docs.keys()]) {
      this.releaseDoc(path);
    }
  }

  destroy(): void {
    this.disconnect();
  }

  getDoc(rawPath: string): DocHandle | null {
    if (!this.isConnected || !this.settings.roomId) return null;

    const filePath = normalizePath(rawPath);

    const existingDoc = this.docs.get(filePath);
    const existingAwareness = this.awarenessMap.get(filePath);
    if (existingDoc && existingAwareness) {
      return {
        doc: existingDoc,
        text: existingDoc.getText("content"),
        awareness: existingAwareness,
      };
    }

    const doc = new Y.Doc();
    this.docs.set(filePath, doc);

    const awareness = new awarenessProtocol.Awareness(doc);
    this.awarenessMap.set(filePath, awareness);

    this.synced.set(filePath, false);

    const updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const syncEncoder = encoding.createEncoder();
      syncProtocol.writeUpdate(syncEncoder, update);
      this.sendMux(filePath, MUX_SYNC, encoding.toUint8Array(syncEncoder));
    };
    doc.on("update", updateHandler);
    this.updateHandlers.set(filePath, updateHandler);

    const awarenessHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === "remote") return;
      const changedClients = changes.added.concat(changes.updated, changes.removed);
      if (changedClients.length === 0) return;
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
      this.sendMux(filePath, MUX_AWARENESS, awarenessUpdate);
    };
    awareness.on("update", awarenessHandler);
    this.awarenessHandlers.set(filePath, awarenessHandler);

    this.sendSubscribe(filePath);

    const text = doc.getText("content");
    return { doc, text, awareness };
  }

  releaseDoc(rawPath: string): void {
    const filePath = normalizePath(rawPath);

    this.sendUnsubscribe(filePath);

    const awareness = this.awarenessMap.get(filePath);
    const awarenessHandler = this.awarenessHandlers.get(filePath);
    if (awareness && awarenessHandler) {
      awareness.off("update", awarenessHandler);
      awarenessProtocol.removeAwarenessStates(awareness, [awareness.doc.clientID], null);
      awareness.destroy();
    }
    this.awarenessMap.delete(filePath);
    this.awarenessHandlers.delete(filePath);

    const doc = this.docs.get(filePath);
    const updateHandler = this.updateHandlers.get(filePath);
    if (doc && updateHandler) {
      doc.off("update", updateHandler);
      doc.destroy();
    }
    this.docs.delete(filePath);
    this.updateHandlers.delete(filePath);

    this.synced.delete(filePath);
    this.syncListeners.delete(filePath);
  }

  waitForSync(rawPath: string, timeoutMs = 10_000): Promise<void> {
    const filePath = normalizePath(rawPath);
    if (this.synced.get(filePath)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners?.delete(listener);
        reject(new Error(`Sync timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      let listeners = this.syncListeners.get(filePath);
      if (!listeners) {
        listeners = new Set();
        this.syncListeners.set(filePath, listeners);
      }

      const listener: SyncListener = (isSynced) => {
        if (!isSynced) return;
        listeners?.delete(listener);
        clearTimeout(timer);
        resolve();
      };
      listeners.add(listener);

      if (this.synced.get(filePath)) {
        listeners.delete(listener);
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private openWebSocket(): void {
    if (!this.settings.roomId || !this.settings.serverUrl) return;

    const wsUrl = toWsUrl(this.settings.serverUrl);
    const params = new URLSearchParams({ token: this.settings.token });
    if (this.settings.jwt) params.set("jwt", this.settings.jwt);
    if (this.settings.serverPassword) params.set("password", this.settings.serverPassword);
    const userId = this.settings.githubUserId || this.settings.clientId;
    if (userId) params.set("userId", userId);

    const url = `${wsUrl}/ws-mux/${this.settings.roomId}?${params.toString()}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      for (const filePath of this.docs.keys()) {
        this.synced.set(filePath, false);
        this.sendSubscribe(filePath);
      }
    };

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.handleMessage(data);
    };

    ws.onclose = () => {
      this.ws = null;
      for (const filePath of this.docs.keys()) {
        this.setSynced(filePath, false);
      }
      if (this.shouldConnect) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldConnect) {
        this.openWebSocket();
      }
    }, delay);
  }

  private handleMessage(data: Uint8Array): void {
    const { docId, msgType, payload } = decodeMuxMessage(data);

    switch (msgType) {
      case MUX_SUBSCRIBED:
        this.handleSubscribed(docId, payload);
        break;
      case MUX_SYNC:
        this.handleSync(docId, payload);
        break;
      case MUX_SYNC_REQUEST:
        this.handleSyncRequest(docId);
        break;
      case MUX_AWARENESS:
        this.handleAwareness(docId, payload);
        break;
    }
  }

  private handleSubscribed(docId: string, payload: Uint8Array): void {
    const doc = this.docs.get(docId);
    if (!doc) return;

    const syncEncoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(syncEncoder, doc);
    this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));

    let peerCount = 0;
    if (payload.length > 0) {
      const decoder = decoding.createDecoder(payload);
      peerCount = decoding.readVarUint(decoder);
    }

    if (peerCount === 0) {
      this.setSynced(docId, true);
    }
  }

  private handleSyncRequest(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;

    const syncEncoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(syncEncoder, doc);
    this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
  }

  private handleSync(docId: string, payload: Uint8Array): void {
    const doc = this.docs.get(docId);
    if (!doc) return;

    const decoder = decoding.createDecoder(payload);
    const syncEncoder = encoding.createEncoder();
    const syncType = decoding.peekVarUint(decoder);

    syncProtocol.readSyncMessage(decoder, syncEncoder, doc, this);

    if (encoding.length(syncEncoder) > 0) {
      this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
    }

    if (syncType === SYNC_STEP2) {
      this.setSynced(docId, true);
    }
  }

  private handleAwareness(docId: string, payload: Uint8Array): void {
    const awareness = this.awarenessMap.get(docId);
    if (!awareness) return;
    awarenessProtocol.applyAwarenessUpdate(awareness, payload, "remote");
  }

  private setSynced(docId: string, value: boolean): void {
    const prev = this.synced.get(docId);
    this.synced.set(docId, value);
    if (value && !prev) {
      const listeners = this.syncListeners.get(docId);
      if (listeners) {
        for (const listener of listeners) {
          listener(true);
        }
      }
    }
  }

  private sendMux(docId: string, msgType: number, payload?: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMuxMessage(docId, msgType, payload));
    }
  }

  private sendSubscribe(filePath: string): void {
    this.sendMux(filePath, MUX_SUBSCRIBE);
  }

  private sendUnsubscribe(filePath: string): void {
    this.sendMux(filePath, MUX_UNSUBSCRIBE);
  }
}
