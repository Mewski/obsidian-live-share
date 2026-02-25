import type { IncomingMessage } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  MUX_AWARENESS,
  MUX_ERROR,
  MUX_SUBSCRIBE,
  MUX_SUBSCRIBED,
  MUX_SYNC,
  MUX_UNSUBSCRIBE,
  decodeMuxMessage,
  encodeMuxMessage,
} from "./mux-protocol.js";
import { getPermission } from "./permissions.js";
import { type Permission, type Persistence, getDefaultPersistence } from "./persistence.js";

const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

interface MuxClient {
  ws: WebSocket;
  subscribedRooms: Set<string>;
  userId: string | null;
  baseRoomId: string;
}

interface RoomState {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<MuxClient>;
  clientAwarenessIds: Map<MuxClient, Set<number>>;
  readOnlyClients: Set<MuxClient>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
}

function toUint8Array(raw: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const buf = Buffer.concat(raw as Buffer[]);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function createYjsWSS(persist?: Persistence) {
  const persistence = persist ?? getDefaultPersistence();
  const roomStates = new Map<string, RoomState>();
  const pendingRooms = new Map<string, Promise<RoomState>>();
  const muxWss = new WebSocketServer({
    noServer: true,
    maxPayload: 10 * 1024 * 1024,
  });

  async function createRoom(roomId: string): Promise<RoomState> {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    await persistence.loadDoc(roomId, doc);

    const state: RoomState = {
      doc,
      awareness,
      clients: new Set(),
      clientAwarenessIds: new Map(),
      readOnlyClients: new Set(),
    };
    roomStates.set(roomId, state);
    pendingRooms.delete(roomId);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const syncEncoder = encoding.createEncoder();
      syncProtocol.writeUpdate(syncEncoder, update);
      const payload = encoding.toUint8Array(syncEncoder);
      const docId = extractDocId(roomId);
      const msg = encodeMuxMessage(docId, MUX_SYNC, payload);

      for (const client of state.clients) {
        if (client !== origin && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(msg);
        }
      }

      if (state.persistTimer) clearTimeout(state.persistTimer);
      state.persistTimer = setTimeout(() => {
        persistence.persistDoc(roomId, doc).catch((err) => {
          console.error(`[yjs] failed to persist doc ${roomId}:`, err);
        });
      }, 5_000);
    });

    awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: {
          added: number[];
          updated: number[];
          removed: number[];
        },
        origin: unknown,
      ) => {
        if (origin instanceof MuxClientMarker) {
          const muxClient = origin.client;
          let ids = state.clientAwarenessIds.get(muxClient);
          if (!ids) {
            ids = new Set();
            state.clientAwarenessIds.set(muxClient, ids);
          }
          for (const id of added) ids.add(id);
          for (const id of updated) ids.add(id);
        }

        const changedClients = added.concat(updated, removed);
        const docId = extractDocId(roomId);
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
        const msg = encodeMuxMessage(docId, MUX_AWARENESS, awarenessUpdate);

        for (const client of state.clients) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg);
          }
        }
      },
    );

    return state;
  }

  async function getOrCreateRoom(roomId: string): Promise<RoomState> {
    const existing = roomStates.get(roomId);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      return existing;
    }

    const pending = pendingRooms.get(roomId);
    if (pending) return pending;

    const promise = createRoom(roomId).catch((err) => {
      pendingRooms.delete(roomId);
      throw err;
    });
    pendingRooms.set(roomId, promise);
    return promise;
  }

  async function cleanupRoom(roomId: string, state: RoomState) {
    if (state.persistTimer) clearTimeout(state.persistTimer);
    try {
      await persistence.persistDoc(roomId, state.doc);
    } catch (err) {
      console.error(`[yjs] failed to persist doc ${roomId} during cleanup:`, err);
    }
    awarenessProtocol.removeAwarenessStates(
      state.awareness,
      Array.from(state.awareness.getStates().keys()),
      null,
    );
    state.doc.destroy();
    roomStates.delete(roomId);
  }

  function scheduleRoomCleanup(roomId: string, state: RoomState) {
    if (state.clients.size === 0) {
      state.cleanupTimer = setTimeout(() => {
        if (state.clients.size === 0) {
          cleanupRoom(roomId, state).catch((err) => {
            console.error(`[yjs] failed to cleanup room ${roomId}:`, err);
          });
        }
      }, 30_000);
    }
  }

  async function handleSubscribe(client: MuxClient, docId: string) {
    const roomId = `${client.baseRoomId}:${docId}`;
    let state: RoomState;
    try {
      state = await getOrCreateRoom(roomId);
    } catch (err) {
      console.error(`[yjs] failed to get/create room ${roomId}:`, err);
      const msg = encodeMuxMessage(docId, MUX_ERROR);
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
      return;
    }

    state.clients.add(client);
    client.subscribedRooms.add(roomId);

    if (client.userId) {
      const permission = getPermission(client.baseRoomId, client.userId);
      if (permission === "read-only") {
        state.readOnlyClients.add(client);
      }
    }

    const syncEncoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(syncEncoder, state.doc);
    const syncStep1Payload = encoding.toUint8Array(syncEncoder);

    const msg = encodeMuxMessage(docId, MUX_SUBSCRIBED, syncStep1Payload);
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }

    const awarenessStates = state.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
        state.awareness,
        Array.from(awarenessStates.keys()),
      );
      const awarenessMsg = encodeMuxMessage(docId, MUX_AWARENESS, awarenessUpdate);
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(awarenessMsg);
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

    const decoder = decoding.createDecoder(payload);
    const syncType = decoding.peekVarUint(decoder);

    if (
      state.readOnlyClients.has(client) &&
      (syncType === SYNC_STEP2 || syncType === SYNC_UPDATE)
    ) {
      return;
    }

    const syncEncoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoder, syncEncoder, state.doc, client);

    if (encoding.length(syncEncoder) > 0) {
      const responsePayload = encoding.toUint8Array(syncEncoder);
      const msg = encodeMuxMessage(docId, MUX_SYNC, responsePayload);
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  function handleAwareness(client: MuxClient, docId: string, payload: Uint8Array) {
    const roomId = `${client.baseRoomId}:${docId}`;
    const state = roomStates.get(roomId);
    if (!state || !state.clients.has(client)) return;

    awarenessProtocol.applyAwarenessUpdate(state.awareness, payload, new MuxClientMarker(client));
  }

  function removeClientFromRoom(client: MuxClient, roomId: string) {
    const state = roomStates.get(roomId);
    if (!state) return;

    state.clients.delete(client);
    state.readOnlyClients.delete(client);
    client.subscribedRooms.delete(roomId);

    const clientIds = state.clientAwarenessIds.get(client);
    if (clientIds && clientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(state.awareness, Array.from(clientIds), null);
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

  async function closeAllRooms() {
    const pending = Array.from(pendingRooms.values());
    await Promise.allSettled(pending);
    pendingRooms.clear();

    for (const [roomId, state] of roomStates) {
      if (state.persistTimer) clearTimeout(state.persistTimer);
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      try {
        await persistence.persistDoc(roomId, state.doc);
      } catch (err) {
        console.error(`[yjs] failed to persist doc ${roomId} during shutdown:`, err);
      }
      for (const client of state.clients) {
        client.ws.close(1000, "server shutting down");
      }
      state.doc.destroy();
    }
    roomStates.clear();
  }

  function getStats() {
    const muxConnections = new Set<WebSocket>();
    for (const state of roomStates.values()) {
      for (const client of state.clients) {
        muxConnections.add(client.ws);
      }
    }
    return { rooms: roomStates.size, connections: muxConnections.size };
  }

  function updatePermission(baseRoomId: string, userId: string, permission: Permission) {
    for (const [rid, state] of roomStates) {
      if (!rid.startsWith(`${baseRoomId}:`)) continue;
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

  return { muxWss, closeAllRooms, getStats, updatePermission };
}

function extractDocId(roomId: string): string {
  const colonIndex = roomId.indexOf(":");
  return colonIndex >= 0 ? roomId.slice(colonIndex + 1) : roomId;
}

class MuxClientMarker {
  constructor(public client: MuxClient) {}
}
