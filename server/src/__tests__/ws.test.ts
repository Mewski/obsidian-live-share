import type { Server } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createApp } from "../index.js";
import { setPermission } from "../permissions.js";
import { noopPersistence } from "../persistence.js";

const MESSAGE_SYNC = 0;
const MESSAGE_FILE_OP = 2;

interface RoomInfo {
  id: string;
  token: string;
}

let server: Server;
let port: number;
let openSockets: WebSocket[] = [];

function listen(s: Server): Promise<number> {
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

function connectWs(
  roomId: string,
  token?: string,
): Promise<{ ws: WebSocket; messages: Uint8Array[] }> {
  const url = token
    ? `ws://localhost:${port}/ws/${roomId}?token=${token}`
    : `ws://localhost:${port}/ws/${roomId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Uint8Array[] = [];
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (Buffer.isBuffer(data)) {
        messages.push(new Uint8Array(data));
      } else if (data instanceof ArrayBuffer) {
        messages.push(new Uint8Array(data));
      } else if (Array.isArray(data)) {
        messages.push(new Uint8Array(Buffer.concat(data)));
      }
    });
    ws.on("open", () => {
      openSockets.push(ws);
      resolve({ ws, messages });
    });
    ws.on("error", reject);
  });
}

function connectWsRaw(roomId: string, token?: string): Promise<WebSocket> {
  const url = token
    ? `ws://localhost:${port}/ws/${roomId}?token=${token}`
    : `ws://localhost:${port}/ws/${roomId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      openSockets.push(ws);
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

function waitForMessages(messages: Uint8Array[], count: number, timeoutMs = 3000): Promise<void> {
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

function sendSyncStep1(ws: WebSocket, doc: Y.Doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
}

function sendUpdate(ws: WebSocket, update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  ws.send(encoding.toUint8Array(encoder));
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

describe("WebSocket handler", () => {
  it("connects to a valid room", async () => {
    const room = await createRoom("ws-test");
    const { ws } = await connectWs(room.id, room.token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects connection to nonexistent room", async () => {
    await expect(connectWsRaw("fake-room-id")).rejects.toThrow();
  });

  it("rejects connection with wrong token", async () => {
    const room = await createRoom("ws-auth-test");
    await expect(connectWsRaw(room.id, "wrong-token")).rejects.toThrow();
  });

  it("allows connection with correct token", async () => {
    const room = await createRoom("ws-auth-ok");
    const { ws } = await connectWs(room.id, room.token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("receives syncStep1 on connect", async () => {
    const room = await createRoom("sync-step1");
    const { messages } = await connectWs(room.id, room.token);

    await waitForMessages(messages, 1);

    const decoder = decoding.createDecoder(messages[0]);
    const msgType = decoding.readVarUint(decoder);
    expect(msgType).toBe(MESSAGE_SYNC);
  });

  it("syncs document between two clients", async () => {
    const room = await createRoom("sync-two");

    const clientA = await connectWs(room.id, room.token);
    await waitForMessages(clientA.messages, 1);

    const docA = new Y.Doc();
    const textA = docA.getText("content");

    docA.on("update", (update: Uint8Array) => {
      sendUpdate(clientA.ws, update);
    });

    sendSyncStep1(clientA.ws, docA);

    const clientB = await connectWs(room.id, room.token);
    await waitForMessages(clientB.messages, 1);

    const docB = new Y.Doc();
    const textB = docB.getText("content");

    sendSyncStep1(clientB.ws, docB);

    await new Promise((r) => setTimeout(r, 150));
    const msgCountBefore = clientB.messages.length;

    textA.insert(0, "hello from A");

    await waitForMessages(clientB.messages, msgCountBefore + 1);
    const msg = clientB.messages[clientB.messages.length - 1];
    const decoder = decoding.createDecoder(msg);
    const msgType = decoding.readVarUint(decoder);
    expect(msgType).toBe(MESSAGE_SYNC);

    const encoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoder, encoder, docB, null);

    expect(textB.toString()).toBe("hello from A");
  });

  it("relays file operations between clients", async () => {
    const room = await createRoom("file-ops");

    const clientA = await connectWs(room.id, room.token);
    await waitForMessages(clientA.messages, 1);

    const clientB = await connectWs(room.id, room.token);
    await waitForMessages(clientB.messages, 1);

    await new Promise((r) => setTimeout(r, 100));
    const msgCountBefore = clientB.messages.length;

    const fileOp = JSON.stringify({
      type: "create",
      path: "test.md",
      content: "# Test",
    });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FILE_OP);
    encoding.writeVarString(encoder, fileOp);
    clientA.ws.send(encoding.toUint8Array(encoder));

    await waitForMessages(clientB.messages, msgCountBefore + 1);
    const msg = clientB.messages[clientB.messages.length - 1];
    const decoder = decoding.createDecoder(msg);
    const type = decoding.readVarUint(decoder);
    expect(type).toBe(MESSAGE_FILE_OP);
    const payload = decoding.readVarString(decoder);
    expect(JSON.parse(payload)).toEqual({
      type: "create",
      path: "test.md",
      content: "# Test",
    });
  });

  it("does not echo file ops back to sender", async () => {
    const room = await createRoom("no-echo");

    const client = await connectWs(room.id, room.token);
    await waitForMessages(client.messages, 1);

    await new Promise((r) => setTimeout(r, 50));
    const msgCountBefore = client.messages.length;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FILE_OP);
    encoding.writeVarString(encoder, '{"type":"delete","path":"x.md"}');
    client.ws.send(encoding.toUint8Array(encoder));

    await new Promise((r) => setTimeout(r, 300));
    expect(client.messages.length).toBe(msgCountBefore);
  });

  it("enforces read-only on Yjs sync updates", async () => {
    const room = await createRoom("read-only-sync");

    const clientA = await connectWs(room.id, room.token);
    await waitForMessages(clientA.messages, 1);

    const docA = new Y.Doc();
    sendSyncStep1(clientA.ws, docA);
    await new Promise((r) => setTimeout(r, 150));

    const readOnlyUserId = "ro-user-123";
    setPermission(room.id, readOnlyUserId, "read-only");
    const readOnlyUrl = `ws://localhost:${port}/ws/${room.id}?token=${room.token}&userId=${readOnlyUserId}`;
    const readOnlyClient = await new Promise<{
      ws: WebSocket;
      messages: Uint8Array[];
    }>((resolve, reject) => {
      const ws = new WebSocket(readOnlyUrl);
      const messages: Uint8Array[] = [];
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (Buffer.isBuffer(data)) {
          messages.push(new Uint8Array(data));
        } else if (data instanceof ArrayBuffer) {
          messages.push(new Uint8Array(data));
        } else if (Array.isArray(data)) {
          messages.push(new Uint8Array(Buffer.concat(data)));
        }
      });
      ws.on("open", () => {
        openSockets.push(ws);
        resolve({ ws, messages });
      });
      ws.on("error", reject);
    });
    await waitForMessages(readOnlyClient.messages, 1);

    await new Promise((r) => setTimeout(r, 150));
    const msgCountBefore = clientA.messages.length;

    const roDoc = new Y.Doc();
    roDoc.getText("content").insert(0, "read-only attempt");
    const roUpdate = Y.encodeStateAsUpdate(roDoc);
    sendUpdate(readOnlyClient.ws, roUpdate);

    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBe(msgCountBefore);

    roDoc.destroy();
    docA.destroy();
  });

  it("live-updates read-only status when permission changes after connect", async () => {
    const room = await createRoom("live-perm-update");
    const userId = "switchable-user";

    setPermission(room.id, userId, "read-write");

    const clientA = await connectWs(room.id, room.token);
    await waitForMessages(clientA.messages, 1);

    const rwUrl = `ws://localhost:${port}/ws/${room.id}?token=${room.token}&userId=${userId}`;
    const clientB = await new Promise<{
      ws: WebSocket;
      messages: Uint8Array[];
    }>((resolve, reject) => {
      const ws = new WebSocket(rwUrl);
      const messages: Uint8Array[] = [];
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (Buffer.isBuffer(data)) messages.push(new Uint8Array(data));
        else if (data instanceof ArrayBuffer) messages.push(new Uint8Array(data));
        else messages.push(new Uint8Array(Buffer.concat(data as Buffer[])));
      });
      ws.on("open", () => {
        openSockets.push(ws);
        resolve({ ws, messages });
      });
      ws.on("error", reject);
    });
    await waitForMessages(clientB.messages, 1);

    const docA = new Y.Doc();
    sendSyncStep1(clientA.ws, docA);
    await new Promise((r) => setTimeout(r, 150));

    const rwDoc = new Y.Doc();
    rwDoc.getText("content").insert(0, "rw-allowed");
    const rwUpdate = Y.encodeStateAsUpdate(rwDoc);
    const msgCountBefore = clientA.messages.length;
    sendUpdate(clientB.ws, rwUpdate);
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
    const roUpdate = Y.encodeStateAsUpdate(roDoc);
    const msgCountAfter = clientA.messages.length;
    sendUpdate(clientB.ws, roUpdate);
    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBe(msgCountAfter);

    rwDoc.destroy();
    roDoc.destroy();
    docA.destroy();
  });

  it("blocks file-op messages for read-only clients", async () => {
    const room = await createRoom("ro-fileop");
    const roUserId = "ro-fileop-user";
    setPermission(room.id, roUserId, "read-only");

    const clientA = await connectWs(room.id, room.token);
    await waitForMessages(clientA.messages, 1);

    const roUrl = `ws://localhost:${port}/ws/${room.id}?token=${room.token}&userId=${roUserId}`;
    const roClient = await new Promise<{
      ws: WebSocket;
      messages: Uint8Array[];
    }>((resolve, reject) => {
      const ws = new WebSocket(roUrl);
      const messages: Uint8Array[] = [];
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (Buffer.isBuffer(data)) messages.push(new Uint8Array(data));
        else if (data instanceof ArrayBuffer) messages.push(new Uint8Array(data));
        else messages.push(new Uint8Array(Buffer.concat(data as Buffer[])));
      });
      ws.on("open", () => {
        openSockets.push(ws);
        resolve({ ws, messages });
      });
      ws.on("error", reject);
    });
    await waitForMessages(roClient.messages, 1);

    await new Promise((r) => setTimeout(r, 150));
    const msgCountBefore = clientA.messages.length;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FILE_OP);
    encoding.writeVarString(encoder, '{"type":"create","path":"hack.md","content":"nope"}');
    roClient.ws.send(encoding.toUint8Array(encoder));

    await new Promise((r) => setTimeout(r, 500));
    expect(clientA.messages.length).toBe(msgCountBefore);
  });
});
