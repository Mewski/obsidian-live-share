import type { IncomingMessage } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";

import {
  MUX_AWARENESS,
  MUX_SUBSCRIBE,
  MUX_SUBSCRIBED,
  MUX_SYNC,
  MUX_SYNC_REQUEST,
  MUX_UNSUBSCRIBE,
  decodeMuxMessage,
  encodeMuxMessage,
} from "./mux-protocol.js";
import { getPermission } from "./permissions.js";
import type { Permission } from "./persistence.js";

const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

interface MuxClient {
  ws: WebSocket;
  subscribedRooms: Set<string>;
  userId: string | null;
  baseRoomId: string;
}

interface RoomState {
  clients: Set<MuxClient>;
  readOnlyClients: Set<MuxClient>;
  clientAwarenessIds: Map<MuxClient, Set<number>>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

function toUint8Array(raw: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const buf = Buffer.concat(raw as Buffer[]);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function createYjsWSS() {
  const roomStates = new Map<string, RoomState>();
  const muxWss = new WebSocketServer({
    noServer: true,
    maxPayload: 10 * 1024 * 1024,
  });

  function getOrCreateRoom(roomId: string): RoomState {
    const existing = roomStates.get(roomId);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      return existing;
    }
    const state: RoomState = {
      clients: new Set(),
      readOnlyClients: new Set(),
      clientAwarenessIds: new Map(),
    };
    roomStates.set(roomId, state);
    return state;
  }

  function scheduleRoomCleanup(roomId: string, state: RoomState) {
    if (state.clients.size === 0) {
      state.cleanupTimer = setTimeout(() => {
        if (state.clients.size === 0) {
          roomStates.delete(roomId);
        }
      }, 30_000);
    }
  }

  function handleSubscribe(client: MuxClient, docId: string) {
    const roomId = `${client.baseRoomId}:${docId}`;
    const state = getOrCreateRoom(roomId);

    const peerCount = state.clients.size;

    state.clients.add(client);
    client.subscribedRooms.add(roomId);

    if (client.userId) {
      const permission = getPermission(client.baseRoomId, client.userId);
      if (permission === "read-only") {
        state.readOnlyClients.add(client);
      }
    }

    const peerCountEncoder = encoding.createEncoder();
    encoding.writeVarUint(peerCountEncoder, peerCount);
    const msg = encodeMuxMessage(docId, MUX_SUBSCRIBED, encoding.toUint8Array(peerCountEncoder));
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }

    if (peerCount > 0) {
      const syncRequestMsg = encodeMuxMessage(docId, MUX_SYNC_REQUEST);
      for (const peer of state.clients) {
        if (peer !== client && peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(syncRequestMsg);
        }
      }
    }
  }

  function handleUnsubscribe(client: MuxClient, docId: string) {
    const roomId = `${client.baseRoomId}:${docId}`;
    removeClientFromRoom(client, roomId);
  }

  function handleSync(client: MuxClient, docId: string, payload: Uint8Array) {
    const roomId = `${client.baseRoomId}:${docId}`;
    const state = roomStates.get(roomId);
    if (!state || !state.clients.has(client)) return;

    if (state.readOnlyClients.has(client) && payload.length > 0) {
      const decoder = decoding.createDecoder(payload);
      const syncType = decoding.peekVarUint(decoder);
      if (syncType === SYNC_STEP2 || syncType === SYNC_UPDATE) {
        return;
      }
    }

    const msg = encodeMuxMessage(docId, MUX_SYNC, payload);
    for (const peer of state.clients) {
      if (peer !== client && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(msg);
      }
    }
  }

  function handleAwareness(client: MuxClient, docId: string, payload: Uint8Array) {
    const roomId = `${client.baseRoomId}:${docId}`;
    const state = roomStates.get(roomId);
    if (!state || !state.clients.has(client)) return;

    try {
      const decoder = decoding.createDecoder(payload);
      const len = decoding.readVarUint(decoder);
      let ids = state.clientAwarenessIds.get(client);
      if (!ids) {
        ids = new Set();
        state.clientAwarenessIds.set(client, ids);
      }
      for (let i = 0; i < len; i++) {
        const clientId = decoding.readVarUint(decoder);
        ids.add(clientId);
      }
    } catch {}

    const msg = encodeMuxMessage(docId, MUX_AWARENESS, payload);
    for (const peer of state.clients) {
      if (peer !== client && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(msg);
      }
    }
  }

  function removeClientFromRoom(client: MuxClient, roomId: string) {
    const state = roomStates.get(roomId);
    if (!state) return;

    state.clients.delete(client);
    state.readOnlyClients.delete(client);
    client.subscribedRooms.delete(roomId);

    const clientIds = state.clientAwarenessIds.get(client);
    if (clientIds && clientIds.size > 0 && state.clients.size > 0) {
      const removalEncoder = encoding.createEncoder();
      encoding.writeVarUint(removalEncoder, clientIds.size);
      for (const id of clientIds) {
        encoding.writeVarUint(removalEncoder, id);
        encoding.writeVarUint(removalEncoder, 0);
        encoding.writeVarString(removalEncoder, "null");
      }
      const removalPayload = encoding.toUint8Array(removalEncoder);
      const docId = extractDocId(roomId);
      const msg = encodeMuxMessage(docId, MUX_AWARENESS, removalPayload);
      for (const peer of state.clients) {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(msg);
        }
      }
    }
    state.clientAwarenessIds.delete(client);

    scheduleRoomCleanup(roomId, state);
  }

  function removeClientFromAllRooms(client: MuxClient) {
    for (const roomId of [...client.subscribedRooms]) {
      removeClientFromRoom(client, roomId);
    }
  }

  muxWss.on("connection", (ws: WebSocket, req: IncomingMessage, baseRoomId: string) => {
    const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
    const userId = reqUrl.searchParams.get("userId");

    const client: MuxClient = {
      ws,
      subscribedRooms: new Set(),
      userId,
      baseRoomId,
    };

    ws.on("error", (err) => {
      console.error(`[yjs-mux] ws error for room ${baseRoomId}:`, err.message);
      ws.close();
    });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const data = toUint8Array(raw);
      try {
        const { docId, msgType, payload } = decodeMuxMessage(data);
        switch (msgType) {
          case MUX_SUBSCRIBE:
            handleSubscribe(client, docId);
            break;
          case MUX_UNSUBSCRIBE:
            handleUnsubscribe(client, docId);
            break;
          case MUX_SYNC:
            handleSync(client, docId, payload);
            break;
          case MUX_AWARENESS:
            handleAwareness(client, docId, payload);
            break;
        }
      } catch (err) {
        console.error("[yjs-mux] failed to handle message:", err);
      }
    });

    ws.on("close", () => {
      removeClientFromAllRooms(client);
    });
  });

  function closeAll() {
    for (const state of roomStates.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      for (const client of state.clients) {
        client.ws.close(1000, "server shutting down");
      }
    }
    roomStates.clear();
  }

  function getStats() {
    const uniqueClients = new Set<WebSocket>();
    const sessions = new Set<string>();
    for (const [roomId, state] of roomStates) {
      const baseRoomId = roomId.substring(0, roomId.indexOf(":"));
      if (baseRoomId) sessions.add(baseRoomId);
      for (const client of state.clients) {
        uniqueClients.add(client.ws);
      }
    }
    return {
      sessions: sessions.size,
      documents: roomStates.size,
      clients: uniqueClients.size,
    };
  }

  function updatePermission(baseRoomId: string, userId: string, permission: Permission) {
    for (const [fullRoomId, state] of roomStates) {
      if (!fullRoomId.startsWith(`${baseRoomId}:`)) continue;
      for (const client of state.clients) {
        if (client.userId === userId) {
          if (permission === "read-only") {
            state.readOnlyClients.add(client);
          } else {
            state.readOnlyClients.delete(client);
          }
        }
      }
    }
  }

  return { muxWss, closeAll, getStats, updatePermission };
}

function extractDocId(roomId: string): string {
  const colonIndex = roomId.indexOf(":");
  return colonIndex >= 0 ? roomId.slice(colonIndex + 1) : roomId;
}
