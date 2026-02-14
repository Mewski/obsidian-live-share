import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getDefaultPersistence, type Persistence } from "./persistence.js";

const messageSync = 0;
const messageAwareness = 1;
const messageFileOp = 2;

interface RoomState {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  clientAwarenessIds: Map<WebSocket, Set<number>>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
}

function toUint8Array(raw: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Buffer.isBuffer(raw))
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const buf = Buffer.concat(raw as Buffer[]);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function handleMessage(ws: WebSocket, state: RoomState, data: Uint8Array) {
  const decoder = decoding.createDecoder(data);
  const msgType = decoding.readVarUint(decoder);

  switch (msgType) {
    case messageSync: {
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
      state.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      });
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

function sendAwarenessState(
  ws: WebSocket,
  awareness: awarenessProtocol.Awareness,
) {
  const clients = awareness.getStates();
  if (clients.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        Array.from(clients.keys()),
      ),
    );
    ws.send(encoding.toUint8Array(encoder));
  }
}

export function createYjsWSS(persist?: Persistence) {
  const p = persist ?? getDefaultPersistence();
  const roomStates = new Map<string, RoomState>();
  const pendingRooms = new Map<string, Promise<RoomState>>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 10 * 1024 * 1024,
  });

  async function createRoom(roomId: string): Promise<RoomState> {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    await p.loadDoc(roomId, doc);

    const state: RoomState = {
      doc,
      awareness,
      clients: new Set(),
      clientAwarenessIds: new Map(),
    };
    roomStates.set(roomId, state);
    pendingRooms.delete(roomId);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);

      state.clients.forEach((client) => {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      });

      // Debounced persistence on every update (crash recovery)
      if (state.persistTimer) clearTimeout(state.persistTimer);
      state.persistTimer = setTimeout(() => {
        p.persistDoc(roomId, doc).catch((err) => {
          console.error(`persist error for ${roomId}:`, err);
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
        // Track which awareness clientIDs belong to which WebSocket
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

        state.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        });
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
    await p.persistDoc(roomId, state.doc);
    awarenessProtocol.removeAwarenessStates(
      state.awareness,
      Array.from(state.awareness.getStates().keys()),
      null,
    );
    state.doc.destroy();
    roomStates.delete(roomId);
  }

  wss.on(
    "connection",
    async (ws: WebSocket, _req: IncomingMessage, roomId: string) => {
      const state = await getOrCreateRoom(roomId);
      state.clients.add(ws);

      sendSyncStep1(ws, state.doc);
      sendAwarenessState(ws, state.awareness);

      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const data = toUint8Array(raw);
        try {
          handleMessage(ws, state, data);
        } catch (err) {
          console.error("ws message error:", err);
        }
      });

      ws.on("close", () => {
        state.clients.delete(ws);

        // Remove the correct awareness clientIDs for this connection
        const clientIds = state.clientAwarenessIds.get(ws);
        if (clientIds && clientIds.size > 0) {
          awarenessProtocol.removeAwarenessStates(
            state.awareness,
            Array.from(clientIds),
            null,
          );
        }
        state.clientAwarenessIds.delete(ws);

        if (state.clients.size === 0) {
          state.cleanupTimer = setTimeout(() => {
            if (state.clients.size === 0) {
              cleanupRoom(roomId, state);
            }
          }, 30_000);
        }
      });
    },
  );

  return wss;
}
