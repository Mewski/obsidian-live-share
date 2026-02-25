/** Yjs WebSocket handler with per-room Y.Doc persistence and awareness relay. */

import type { IncomingMessage } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { getPermission } from "./permissions.js";
import { type Persistence, getDefaultPersistence } from "./persistence.js";

const messageSync = 0; // Yjs sync protocol
const messageAwareness = 1; // Awareness state (cursors, presence)
const messageFileOp = 2; // Non-Yjs file operations broadcast

interface RoomState {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  clientAwarenessIds: Map<WebSocket, Set<number>>;
  readOnlyClients: Set<WebSocket>;
  clientUserIds: Map<WebSocket, string>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
}

function toUint8Array(raw: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const buf = Buffer.concat(raw as Buffer[]);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const syncStep1 = 0;
const syncStep2 = 1;
const syncUpdate = 2;

function handleMessage(ws: WebSocket, state: RoomState, data: Uint8Array) {
  const decoder = decoding.createDecoder(data);
  const msgType = decoding.readVarUint(decoder);

  switch (msgType) {
    case messageSync: {
      // Peek at the sync sub-type to enforce read-only permissions.
      // Step2 and Update carry document mutations; block them for read-only clients.
      const syncType = decoding.peekVarUint(decoder);
      if (state.readOnlyClients.has(ws) && (syncType === syncStep2 || syncType === syncUpdate)) {
        break;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, state.doc, ws);
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder));
      }
      break;
    }
    case messageAwareness: {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(state.awareness, update, ws);
      break;
    }
    case messageFileOp: {
      if (state.readOnlyClients.has(ws)) break;
      for (const client of state.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
      break;
    }
  }
}

function sendSyncStep1(ws: WebSocket, doc: Y.Doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
}

function sendAwarenessState(ws: WebSocket, awareness: awarenessProtocol.Awareness) {
  const clients = awareness.getStates();
  if (clients.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(clients.keys())),
    );
    ws.send(encoding.toUint8Array(encoder));
  }
}

export function createYjsWSS(persist?: Persistence) {
  const persistence = persist ?? getDefaultPersistence();
  const roomStates = new Map<string, RoomState>();
  const pendingRooms = new Map<string, Promise<RoomState>>();
  const wss = new WebSocketServer({
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
      clientUserIds: new Map(),
    };
    roomStates.set(roomId, state);
    pendingRooms.delete(roomId);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);

      for (const client of state.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          client.send(msg);
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
        if (origin instanceof WebSocket) {
          let ids = state.clientAwarenessIds.get(origin);
          if (!ids) {
            ids = new Set();
            state.clientAwarenessIds.set(origin, ids);
          }
          for (const id of added) ids.add(id);
          for (const id of updated) ids.add(id);
        }

        const changedClients = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
        );
        const msg = encoding.toUint8Array(encoder);

        for (const client of state.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
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

    // Prevent TOCTOU race: reuse pending promise if another connection
    // is already creating this room
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

  async function closeAllRooms() {
    for (const [roomId, state] of roomStates) {
      if (state.persistTimer) clearTimeout(state.persistTimer);
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      try {
        await persistence.persistDoc(roomId, state.doc);
      } catch (err) {
        console.error(`[yjs] failed to persist doc ${roomId} during shutdown:`, err);
      }
      for (const ws of state.clients) {
        ws.close(1000, "server shutting down");
      }
      state.doc.destroy();
    }
    roomStates.clear();
  }

  function getStats() {
    let connections = 0;
    for (const state of roomStates.values()) {
      connections += state.clients.size;
    }
    return { rooms: roomStates.size, connections };
  }

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage, roomId: string) => {
    let state: RoomState;
    try {
      state = await getOrCreateRoom(roomId);
    } catch (err) {
      console.error(`[yjs] failed to get/create room ${roomId}:`, err);
      ws.close(1011, "internal error");
      return;
    }
    state.clients.add(ws);

    const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
    const userId = reqUrl.searchParams.get("userId");
    // Extract base room ID (strip `:encodedPath` suffix from Yjs room names)
    const colonIdx = roomId.indexOf(":");
    const baseRoomId = colonIdx >= 0 ? roomId.slice(0, colonIdx) : roomId;
    if (userId) {
      state.clientUserIds.set(ws, userId);
      const perm = getPermission(baseRoomId, userId);
      if (perm === "read-only") {
        state.readOnlyClients.add(ws);
      }
    }

    sendSyncStep1(ws, state.doc);
    sendAwarenessState(ws, state.awareness);

    ws.on("error", (err) => {
      console.error(`[yjs] ws error for room ${roomId}:`, err.message);
      ws.close();
    });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const data = toUint8Array(raw);
      try {
        handleMessage(ws, state, data);
      } catch (err) {
        console.error("[yjs] failed to handle message:", err);
      }
    });

    ws.on("close", () => {
      state.clients.delete(ws);
      state.readOnlyClients.delete(ws);
      state.clientUserIds.delete(ws);

      const clientIds = state.clientAwarenessIds.get(ws);
      if (clientIds && clientIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(state.awareness, Array.from(clientIds), null);
      }
      state.clientAwarenessIds.delete(ws);

      if (state.clients.size === 0) {
        state.cleanupTimer = setTimeout(() => {
          if (state.clients.size === 0) {
            cleanupRoom(roomId, state).catch((err) => {
              console.error(`[yjs] failed to cleanup room ${roomId}:`, err);
            });
          }
        }, 30_000);
      }
    });
  });

  /** Update read-only status for a userId across all Yjs rooms matching a base room ID. */
  function updatePermission(
    baseRoomId: string,
    userId: string,
    permission: "read-write" | "read-only",
  ) {
    for (const [rid, state] of roomStates) {
      const colonIdx = rid.indexOf(":");
      const base = colonIdx >= 0 ? rid.slice(0, colonIdx) : rid;
      if (base !== baseRoomId) continue;
      for (const [ws, uid] of state.clientUserIds) {
        if (uid === userId) {
          if (permission === "read-only") {
            state.readOnlyClients.add(ws);
          } else {
            state.readOnlyClients.delete(ws);
          }
        }
      }
    }
  }

  return { wss, closeAllRooms, getStats, updatePermission };
}
