import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createApp } from "../index.js";
import {
  MUX_AWARENESS,
  MUX_SUBSCRIBE,
  MUX_SUBSCRIBED,
  MUX_SYNC,
  decodeMuxMessage,
  encodeMuxMessage,
} from "../mux-protocol.js";
import { setPermission } from "../permissions.js";
import { noopPersistence } from "../persistence.js";

interface RoomInfo {
  id: string;
  token: string;
}

let server: Server<typeof IncomingMessage, typeof ServerResponse>;
let port: number;
let openSockets: WebSocket[] = [];

function listen(s: Server<typeof IncomingMessage, typeof ServerResponse>): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, () => {
      const addr = s.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function createRoom(name: string): Promise<RoomInfo> {
  const res = await fetch(`http://localhost:${port}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<RoomInfo>;
}

function connectMux(
  roomId: string,
  token?: string,
  userId?: string,
): Promise<{
  ws: WebSocket;
  messages: { docId: string; msgType: number; payload: Uint8Array }[];
}> {
  let url = `ws://localhost:${port}/ws-mux/${roomId}`;
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (userId) params.set("userId", userId);
  const qs = params.toString();
  if (qs) url += `?${qs}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: { docId: string; msgType: number; payload: Uint8Array }[] = [];
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      let raw: Uint8Array;
      if (Buffer.isBuffer(data)) {
        raw = new Uint8Array(data);
      } else if (data instanceof ArrayBuffer) {
        raw = new Uint8Array(data);
      } else {
        raw = new Uint8Array(Buffer.concat(data));
      }
      messages.push(decodeMuxMessage(raw));
    });
    ws.on("open", () => {
      openSockets.push(ws);
      resolve({ ws, messages });
    });
    ws.on("error", reject);
  });
}

function connectMuxRaw(roomId: string, token?: string): Promise<WebSocket> {
  const url = token
    ? `ws://localhost:${port}/ws-mux/${roomId}?token=${token}`
    : `ws://localhost:${port}/ws-mux/${roomId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      openSockets.push(ws);
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

function waitForMessages(
  messages: { docId: string; msgType: number; payload: Uint8Array }[],
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  if (messages.length >= count) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (messages.length >= count) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`expected ${count} messages, got ${messages.length}`));
      }
    }, 10);
  });
}

function subscribe(ws: WebSocket, docId: string) {
  ws.send(encodeMuxMessage(docId, MUX_SUBSCRIBE));
}

function sendMuxSync(ws: WebSocket, docId: string, syncPayload: Uint8Array) {
  ws.send(encodeMuxMessage(docId, MUX_SYNC, syncPayload));
}

function sendSyncStep1(ws: WebSocket, docId: string, doc: Y.Doc) {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(encoder, doc);
  sendMuxSync(ws, docId, encoding.toUint8Array(encoder));
}

function sendUpdate(ws: WebSocket, docId: string, update: Uint8Array) {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  sendMuxSync(ws, docId, encoding.toUint8Array(encoder));
}

function findMessages(
  messages: { docId: string; msgType: number; payload: Uint8Array }[],
  docId: string,
  msgType: number,
) {
  return messages.filter((m) => m.docId === docId && m.msgType === msgType);
}

beforeEach(async () => {
  openSockets = [];
  const { server: s } = createApp(noopPersistence);
  server = s;
  port = await listen(server);
});

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  openSockets = [];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Mux WebSocket handler", () => {
  it("connects to a valid room via /ws-mux/", async () => {
    const room = await createRoom("mux-test");
    const { ws } = await connectMux(room.id, room.token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects connection to nonexistent room", async () => {
    await expect(connectMuxRaw("fake-room-id")).rejects.toThrow();
  });

  it("rejects connection with wrong token", async () => {
    const room = await createRoom("mux-auth-test");
    await expect(connectMuxRaw(room.id, "wrong-token")).rejects.toThrow();
  });

  it("allows connection with correct token", async () => {
    const room = await createRoom("mux-auth-ok");
    const { ws } = await connectMux(room.id, room.token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("receives SUBSCRIBED with syncStep1 after subscribing", async () => {
    const room = await createRoom("sub-test");
    const { ws, messages } = await connectMux(room.id, room.token);

    subscribe(ws, "test-doc");

    await waitForMessages(messages, 1);

    const subMsgs = findMessages(messages, "test-doc", MUX_SUBSCRIBED);
    expect(subMsgs.length).toBe(1);

    // The payload should be a valid sync step 1
    const decoder = decoding.createDecoder(subMsgs[0].payload);
    const syncMsgType = decoding.readVarUint(decoder);
    expect(syncMsgType).toBe(0); // syncProtocol.messageYjsSyncStep1
  });

  it("syncs document between two clients via mux", async () => {
    const room = await createRoom("mux-sync-two");
    const docId = "notes/test.md";

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1); // SUBSCRIBED

    const docA = new Y.Doc();
    const textA = docA.getText("content");
    docA.on("update", (update: Uint8Array) => {
      sendUpdate(clientA.ws, docId, update);
    });
    sendSyncStep1(clientA.ws, docId, docA);

    const clientB = await connectMux(room.id, room.token);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1); // SUBSCRIBED

    const docB = new Y.Doc();
    const textB = docB.getText("content");
    sendSyncStep1(clientB.ws, docId, docB);

    await new Promise((r) => setTimeout(r, 150));
    const msgCountBefore = clientB.messages.length;

    textA.insert(0, "hello from A");

    await waitForMessages(clientB.messages, msgCountBefore + 1);

    // Find the sync message for this doc
    const syncMsgs = findMessages(clientB.messages, docId, MUX_SYNC);
    expect(syncMsgs.length).toBeGreaterThan(0);

    // Apply all sync messages to docB
    for (const msg of syncMsgs) {
      const decoder = decoding.createDecoder(msg.payload);
      const enc = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, enc, docB, null);
    }

    expect(textB.toString()).toBe("hello from A");
  });

  it("isolates sync between different docIds", async () => {
    const room = await createRoom("mux-isolate");

    const client = await connectMux(room.id, room.token);
    subscribe(client.ws, "doc-a");
    subscribe(client.ws, "doc-b");

    // Wait for both SUBSCRIBED messages
    await waitForMessages(client.messages, 2);

    const docA = new Y.Doc();
    docA.getText("content").insert(0, "content for A");
    const updateA = Y.encodeStateAsUpdate(docA);
    sendUpdate(client.ws, "doc-a", updateA);

    await new Promise((r) => setTimeout(r, 200));

    // Connect second client, subscribe only to doc-b
    const client2 = await connectMux(room.id, room.token);
    subscribe(client2.ws, "doc-b");
    await waitForMessages(client2.messages, 1); // SUBSCRIBED

    const docB2 = new Y.Doc();
    sendSyncStep1(client2.ws, "doc-b", docB2);

    await new Promise((r) => setTimeout(r, 200));

    // Apply sync messages for doc-b
    const syncMsgs = findMessages(client2.messages, "doc-b", MUX_SYNC);
    for (const msg of syncMsgs) {
      const decoder = decoding.createDecoder(msg.payload);
      const enc = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, enc, docB2, null);
    }

    // doc-b should be empty since only doc-a had content
    expect(docB2.getText("content").toString()).toBe("");
  });

  it("enforces read-only on Yjs sync updates via mux", async () => {
    const room = await createRoom("mux-read-only");
    const docId = "protected-doc";

    // Client A (host)
    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    const docA = new Y.Doc();
    sendSyncStep1(clientA.ws, docId, docA);
    await new Promise((r) => setTimeout(r, 150));

    // Client B (read-only)
    const roUserId = "ro-user-123";
    setPermission(room.id, roUserId, "read-only");
    const clientB = await connectMux(room.id, room.token, roUserId);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 150));
    const msgCountBefore = clientA.messages.length;

    // Read-only client tries to send an update
    const roDoc = new Y.Doc();
    roDoc.getText("content").insert(0, "read-only attempt");
    const roUpdate = Y.encodeStateAsUpdate(roDoc);
    sendUpdate(clientB.ws, docId, roUpdate);

    await new Promise((r) => setTimeout(r, 500));
    // Host should NOT receive the update
    expect(clientA.messages.length).toBe(msgCountBefore);

    roDoc.destroy();
    docA.destroy();
  });

  it("live-updates read-only status when permission changes after connect", async () => {
    const room = await createRoom("mux-live-perm");
    const docId = "perm-doc";
    const userId = "switchable-user";

    setPermission(room.id, userId, "read-write");

    // Client A (host)
    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    const docA = new Y.Doc();
    sendSyncStep1(clientA.ws, docId, docA);
    await new Promise((r) => setTimeout(r, 150));

    // Client B (initially read-write)
    const clientB = await connectMux(room.id, room.token, userId);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 150));

    // Verify read-write works
    const rwDoc = new Y.Doc();
    rwDoc.getText("content").insert(0, "rw-allowed");
    const rwUpdate = Y.encodeStateAsUpdate(rwDoc);
    const msgCountBefore = clientA.messages.length;
    sendUpdate(clientB.ws, docId, rwUpdate);
    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBeGreaterThan(msgCountBefore);

    // Change permission to read-only via control channel
    setPermission(room.id, userId, "read-only");

    const ctrlHost = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/control/${room.id}?token=${room.token}`);
      ws.on("open", () => {
        openSockets.push(ws);
        resolve(ws);
      });
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    ctrlHost.send(
      JSON.stringify({
        type: "presence-update",
        userId: "ctrl-host",
        displayName: "Host",
        isHost: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    ctrlHost.send(
      JSON.stringify({
        type: "set-permission",
        userId,
        permission: "read-only",
      }),
    );
    await new Promise((r) => setTimeout(r, 200));

    // Now read-only update should be blocked
    const roDoc = new Y.Doc();
    roDoc.getText("content").insert(0, "should-be-blocked");
    const roUpdate = Y.encodeStateAsUpdate(roDoc);
    const msgCountAfter = clientA.messages.length;
    sendUpdate(clientB.ws, docId, roUpdate);
    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBe(msgCountAfter);

    rwDoc.destroy();
    roDoc.destroy();
    docA.destroy();
  });
});
