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
  MUX_SYNC_REQUEST,
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

describe("Mux WebSocket relay", () => {
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

  it("receives SUBSCRIBED with peerCount=0 when first subscriber", async () => {
    const room = await createRoom("sub-first");
    const { ws, messages } = await connectMux(room.id, room.token);

    subscribe(ws, "test-doc");
    await waitForMessages(messages, 1);

    const subMsgs = findMessages(messages, "test-doc", MUX_SUBSCRIBED);
    expect(subMsgs.length).toBe(1);

    const decoder = decoding.createDecoder(subMsgs[0].payload);
    const peerCount = decoding.readVarUint(decoder);
    expect(peerCount).toBe(0);
  });

  it("receives SUBSCRIBED with peerCount=1 when second subscriber", async () => {
    const room = await createRoom("sub-second");

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, "test-doc");
    await waitForMessages(clientA.messages, 1); // SUBSCRIBED

    const clientB = await connectMux(room.id, room.token);
    subscribe(clientB.ws, "test-doc");
    await waitForMessages(clientB.messages, 1); // SUBSCRIBED

    const subMsgs = findMessages(clientB.messages, "test-doc", MUX_SUBSCRIBED);
    expect(subMsgs.length).toBe(1);

    const decoder = decoding.createDecoder(subMsgs[0].payload);
    const peerCount = decoding.readVarUint(decoder);
    expect(peerCount).toBe(1);
  });

  it("sends SYNC_REQUEST to existing subscribers when new peer joins", async () => {
    const room = await createRoom("sync-req");

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, "test-doc");
    await waitForMessages(clientA.messages, 1); // SUBSCRIBED

    const msgCountBefore = clientA.messages.length;

    const clientB = await connectMux(room.id, room.token);
    subscribe(clientB.ws, "test-doc");

    await waitForMessages(clientA.messages, msgCountBefore + 1);
    const syncReqs = findMessages(clientA.messages, "test-doc", MUX_SYNC_REQUEST);
    expect(syncReqs.length).toBe(1);
  });

  it("relays sync messages between peers", async () => {
    const room = await createRoom("relay-sync");
    const docId = "notes/test.md";

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    const clientB = await connectMux(room.id, room.token);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 100));
    const msgCountBefore = clientB.messages.length;

    const docA = new Y.Doc();
    docA.getText("content").insert(0, "hello from A");
    const update = Y.encodeStateAsUpdate(docA);
    sendUpdate(clientA.ws, docId, update);

    await waitForMessages(clientB.messages, msgCountBefore + 1);

    const syncMsgs = findMessages(clientB.messages, docId, MUX_SYNC);
    expect(syncMsgs.length).toBeGreaterThan(0);

    const docB = new Y.Doc();
    for (const msg of syncMsgs) {
      const decoder = decoding.createDecoder(msg.payload);
      const enc = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, enc, docB, null);
    }
    expect(docB.getText("content").toString()).toBe("hello from A");

    docA.destroy();
    docB.destroy();
  });

  it("does not echo sync messages back to sender", async () => {
    const room = await createRoom("no-echo");
    const docId = "test-doc";

    const client = await connectMux(room.id, room.token);
    subscribe(client.ws, docId);
    await waitForMessages(client.messages, 1);

    await new Promise((r) => setTimeout(r, 50));
    const msgCountBefore = client.messages.length;

    const doc = new Y.Doc();
    doc.getText("content").insert(0, "no echo");
    sendUpdate(client.ws, docId, Y.encodeStateAsUpdate(doc));

    await new Promise((r) => setTimeout(r, 300));
    expect(client.messages.length).toBe(msgCountBefore);

    doc.destroy();
  });

  it("relays awareness messages between peers", async () => {
    const room = await createRoom("relay-awareness");
    const docId = "test-doc";

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    const clientB = await connectMux(room.id, room.token);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 100));
    const msgCountBefore = clientB.messages.length;

    const awarenessPayload = new Uint8Array([1, 2, 3, 4]);
    clientA.ws.send(encodeMuxMessage(docId, MUX_AWARENESS, awarenessPayload));

    await waitForMessages(clientB.messages, msgCountBefore + 1);

    const awarenessMsgs = findMessages(clientB.messages, docId, MUX_AWARENESS);
    expect(awarenessMsgs.length).toBeGreaterThan(0);
  });

  it("enforces read-only on sync updates via relay", async () => {
    const room = await createRoom("relay-ro");
    const docId = "protected-doc";

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    await new Promise((r) => setTimeout(r, 100));

    const roUserId = "ro-user-123";
    setPermission(room.id, roUserId, "read-only");
    const clientB = await connectMux(room.id, room.token, roUserId);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 200));
    const msgCountBefore = clientA.messages.length;

    const roDoc = new Y.Doc();
    roDoc.getText("content").insert(0, "read-only attempt");
    sendUpdate(clientB.ws, docId, Y.encodeStateAsUpdate(roDoc));

    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBe(msgCountBefore);

    roDoc.destroy();
  });

  it("read-only client can still send SyncStep1", async () => {
    const room = await createRoom("relay-ro-sync1");
    const docId = "ro-doc";

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    const roUserId = "ro-sync1-user";
    setPermission(room.id, roUserId, "read-only");
    const clientB = await connectMux(room.id, room.token, roUserId);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 200));
    const msgCountBefore = clientA.messages.length;

    const roDoc = new Y.Doc();
    sendSyncStep1(clientB.ws, docId, roDoc);

    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBeGreaterThan(msgCountBefore);

    roDoc.destroy();
  });

  it("live-updates read-only status when permission changes after connect", async () => {
    const room = await createRoom("relay-live-perm");
    const docId = "perm-doc";
    const userId = "switchable-user";

    setPermission(room.id, userId, "read-write");

    const clientA = await connectMux(room.id, room.token);
    subscribe(clientA.ws, docId);
    await waitForMessages(clientA.messages, 1);

    const clientB = await connectMux(room.id, room.token, userId);
    subscribe(clientB.ws, docId);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 200));

    const rwDoc = new Y.Doc();
    rwDoc.getText("content").insert(0, "rw-allowed");
    const msgCountBefore = clientA.messages.length;
    sendUpdate(clientB.ws, docId, Y.encodeStateAsUpdate(rwDoc));
    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBeGreaterThan(msgCountBefore);

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

    const roDoc = new Y.Doc();
    roDoc.getText("content").insert(0, "should-be-blocked");
    const msgCountAfter = clientA.messages.length;
    sendUpdate(clientB.ws, docId, Y.encodeStateAsUpdate(roDoc));
    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBe(msgCountAfter);

    rwDoc.destroy();
    roDoc.destroy();
  });
});
