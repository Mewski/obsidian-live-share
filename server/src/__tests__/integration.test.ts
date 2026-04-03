import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
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
import { noopPersistence } from "../persistence.js";

interface RoomInfo {
  id: string;
  token: string;
  name: string;
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

async function createRoom(
  name: string,
  opts?: { requireApproval?: boolean },
): Promise<RoomInfo> {
  const res = await fetch(`http://localhost:${port}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...opts }),
  });
  return res.json() as Promise<RoomInfo>;
}

function connectControl(
  roomId: string,
  token: string,
): Promise<{ ws: WebSocket; messages: string[] }> {
  const url = `ws://localhost:${port}/control/${roomId}?token=${token}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const str = Buffer.isBuffer(data)
        ? data.toString()
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString()
          : Buffer.concat(data as Buffer[]).toString();
      messages.push(str);
    });
    ws.on("open", () => {
      openSockets.push(ws);
      resolve({ ws, messages });
    });
    ws.on("error", reject);
  });
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

function waitForCtrlMessages(messages: string[], count: number, timeoutMs = 3000): Promise<void> {
  if (messages.length >= count) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (messages.length >= count) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`expected ${count} ctrl messages, got ${messages.length}`));
      }
    }, 10);
  });
}

function waitForMuxMessages(
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
        reject(new Error(`expected ${count} mux messages, got ${messages.length}`));
      }
    }, 10);
  });
}

function sendJSON(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

function findMuxMessages(
  messages: { docId: string; msgType: number; payload: Uint8Array }[],
  docId: string,
  msgType: number,
) {
  return messages.filter((m) => m.docId === docId && m.msgType === msgType);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe("Multi-client integration", () => {
  // ─── Scenario 1: Host identity — host sends join-request first, then guest joins ───
  it("host sends join-request first, gets isHost: true; guest gets isHost: false", async () => {
    const room = await createRoom("int-host-first");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });

    await waitForCtrlMessages(host.messages, 1);
    const hostResp = JSON.parse(host.messages[0]);
    expect(hostResp.type).toBe("join-response");
    expect(hostResp.approved).toBe(true);
    expect(hostResp.isHost).toBe(true);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForCtrlMessages(guest.messages, 1);
    const guestResp = JSON.parse(guest.messages[0]);
    expect(guestResp.type).toBe("join-response");
    expect(guestResp.approved).toBe(true);
    expect(guestResp.isHost).toBe(false);
  });

  // ─── Scenario 2: Host identity — guest connects before host sends join-request ───
  it("first client to send join-request becomes host regardless of connect order", async () => {
    const room = await createRoom("int-guest-first");

    // Both connect, but "guest" sends join-request first
    const laterHost = await connectControl(room.id, room.token);
    const earlyBird = await connectControl(room.id, room.token);

    await delay(100);

    // earlyBird sends join-request first — becomes host
    sendJSON(earlyBird.ws, {
      type: "join-request",
      userId: "early-bird",
      displayName: "EarlyBird",
    });

    await waitForCtrlMessages(earlyBird.messages, 1);
    const earlyResp = JSON.parse(earlyBird.messages[0]);
    expect(earlyResp.type).toBe("join-response");
    expect(earlyResp.isHost).toBe(true);

    // laterHost sends join-request second — should NOT be host
    sendJSON(laterHost.ws, {
      type: "join-request",
      userId: "later-host",
      displayName: "LaterHost",
    });

    await waitForCtrlMessages(laterHost.messages, 1);
    const laterResp = JSON.parse(laterHost.messages[0]);
    expect(laterResp.type).toBe("join-response");
    expect(laterResp.isHost).toBe(false);
  });

  // ─── Scenario 3: Host disconnect → auto-election → original host reconnects ───
  it("host disconnects, guest is auto-elected, reconnecting host gets isHost: false", async () => {
    const room = await createRoom("int-host-disconnect");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await delay(50);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForCtrlMessages(host.messages, 1);
    await waitForCtrlMessages(guest.messages, 1);

    // Clear guest messages before host disconnect
    guest.messages.length = 0;

    // Host disconnects
    const hostClosed = new Promise<void>((resolve) => {
      host.ws.on("close", () => resolve());
    });
    host.ws.close();
    await hostClosed;

    // Guest should receive presence-leave + host-transfer-complete
    await waitForCtrlMessages(guest.messages, 2);

    const transferMsg = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "host-transfer-complete";
    });
    expect(transferMsg).toBeDefined();
    const transferParsed = JSON.parse(transferMsg!);
    expect(transferParsed.userId).toBe("guest-1");
    expect(transferParsed.displayName).toBe("Guest");

    // Original host reconnects
    const reconnected = await connectControl(room.id, room.token);
    await delay(100);

    sendJSON(reconnected.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });

    await waitForCtrlMessages(reconnected.messages, 1);
    const reconnResp = JSON.parse(reconnected.messages[0]);
    expect(reconnResp.type).toBe("join-response");
    expect(reconnResp.approved).toBe(true);
    expect(reconnResp.isHost).toBe(false);
  });

  // ─── Scenario 4: requireApproval — guest must wait for host approval ───
  it("requireApproval room: guest waits for host to approve join-request", async () => {
    const room = await createRoom("int-require-approval");

    // Set requireApproval on the server room
    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.requireApproval = true;

    const host = await connectControl(room.id, room.token);
    await delay(50);

    // Host sends join-request — auto-approved as host
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });

    await waitForCtrlMessages(host.messages, 1);
    const hostResp = JSON.parse(host.messages[0]);
    expect(hostResp.type).toBe("join-response");
    expect(hostResp.approved).toBe(true);
    expect(hostResp.isHost).toBe(true);

    host.messages.length = 0;

    // Guest connects and sends join-request
    const guest = await connectControl(room.id, room.token);
    await delay(50);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    // Host should receive the guest's join-request
    await waitForCtrlMessages(host.messages, 1);
    const joinReq = JSON.parse(host.messages[0]);
    expect(joinReq.type).toBe("join-request");
    expect(joinReq.userId).toBe("guest-1");
    expect(joinReq.displayName).toBe("Guest");

    // Guest should NOT have received any response yet
    await delay(200);
    expect(guest.messages.length).toBe(0);

    // Host approves the guest
    sendJSON(host.ws, {
      type: "join-response",
      userId: "guest-1",
      approved: true,
      permission: "read-write",
    });

    await waitForCtrlMessages(guest.messages, 1);
    const guestResp = JSON.parse(guest.messages[0]);
    expect(guestResp.type).toBe("join-response");
    expect(guestResp.approved).toBe(true);
    expect(guestResp.permission).toBe("read-write");
    expect(guestResp.isHost).toBe(false);
  });

  // ─── Scenario 5: requireApproval — unapproved guest can't send file-ops ───
  it("unapproved guest file-ops are dropped in requireApproval room", async () => {
    const room = await createRoom("int-unapproved-fileop");

    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.requireApproval = true;

    const host = await connectControl(room.id, room.token);
    await delay(50);

    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await waitForCtrlMessages(host.messages, 1);

    const guest = await connectControl(room.id, room.token);
    await delay(50);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    // Wait for host to receive the guest's join-request
    await waitForCtrlMessages(host.messages, 2);
    host.messages.length = 0;

    // Guest sends file-op BEFORE being approved
    sendJSON(guest.ws, {
      type: "file-op",
      op: { type: "create", path: "sneaky.md", content: "should not arrive" },
    });

    await delay(300);

    // Host should NOT receive the file-op
    const fileOpMsg = host.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "file-op";
    });
    expect(fileOpMsg).toBeUndefined();
  });

  // ─── Scenario 6: Permission persistence across reconnect ───
  it("guest permission persists as read-only across reconnect", async () => {
    const room = await createRoom("int-perm-persist");

    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.requireApproval = true;

    // Host joins
    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await waitForCtrlMessages(host.messages, 1);
    host.messages.length = 0;

    // Guest joins and gets approved
    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForCtrlMessages(host.messages, 1);
    host.messages.length = 0;

    sendJSON(host.ws, {
      type: "join-response",
      userId: "guest-1",
      approved: true,
      permission: "read-write",
    });

    await waitForCtrlMessages(guest.messages, 1);
    expect(JSON.parse(guest.messages[0]).approved).toBe(true);

    // Host changes guest to read-only
    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "read-only",
    });

    await waitForCtrlMessages(guest.messages, 2);
    const permUpdate = JSON.parse(guest.messages[1]);
    expect(permUpdate.type).toBe("permission-update");
    expect(permUpdate.permission).toBe("read-only");

    // Guest disconnects
    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    guest.ws.close();
    await guestClosed;
    await delay(100);

    // Guest reconnects
    host.messages.length = 0;
    const guest2 = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest2.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    // Guest should be auto-approved (permission persisted)
    await waitForCtrlMessages(guest2.messages, 1);
    const rejoinResp = JSON.parse(guest2.messages[0]);
    expect(rejoinResp.type).toBe("join-response");
    expect(rejoinResp.approved).toBe(true);
    // Permission should be read-only (persisted from earlier change)
    expect(rejoinResp.permission).toBe("read-only");

    // Host should NOT have received a join-request (auto-approved)
    await delay(200);
    const hostJoinReq = host.messages.find((m) => JSON.parse(m).type === "join-request");
    expect(hostJoinReq).toBeUndefined();

    // Guest tries to send file-op — should be blocked
    host.messages.length = 0;
    sendJSON(guest2.ws, {
      type: "file-op",
      op: { type: "create", path: "blocked.md", content: "should not arrive" },
    });

    await delay(300);
    const fileOpMsg = host.messages.find((m) => JSON.parse(m).type === "file-op");
    expect(fileOpMsg).toBeUndefined();
  });

  // ─── Scenario 7: File-op relay — guest creates file, host receives it ───
  it("guest file-op is relayed to host but not echoed back to guest", async () => {
    const room = await createRoom("int-file-relay");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await delay(50);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForCtrlMessages(host.messages, 1);
    await waitForCtrlMessages(guest.messages, 1);

    host.messages.length = 0;
    guest.messages.length = 0;

    // Guest sends file-op (create)
    sendJSON(guest.ws, {
      type: "file-op",
      op: { type: "create", path: "notes/new-file.md", content: "hello world" },
    });

    // Host should receive the file-op
    await waitForCtrlMessages(host.messages, 1);
    const fileOp = JSON.parse(host.messages[0]);
    expect(fileOp.type).toBe("file-op");
    expect(fileOp.op.type).toBe("create");
    expect(fileOp.op.path).toBe("notes/new-file.md");
    expect(fileOp.op.content).toBe("hello world");

    // Guest should NOT receive its own file-op back (no echo)
    await delay(300);
    expect(guest.messages.length).toBe(0);
  });

  // ─── Scenario 8: Folder-create relay ───
  it("guest folder-create file-op is relayed to host", async () => {
    const room = await createRoom("int-folder-create");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await delay(50);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForCtrlMessages(host.messages, 1);
    await waitForCtrlMessages(guest.messages, 1);

    host.messages.length = 0;
    guest.messages.length = 0;

    // Guest sends file-op with a folder-create operation
    sendJSON(guest.ws, {
      type: "file-op",
      op: { type: "folder-create", path: "notes/subfolder" },
    });

    // Host should receive it
    await waitForCtrlMessages(host.messages, 1);
    const folderOp = JSON.parse(host.messages[0]);
    expect(folderOp.type).toBe("file-op");
    expect(folderOp.op.type).toBe("folder-create");
    expect(folderOp.op.path).toBe("notes/subfolder");

    // Guest should NOT receive its own op back
    await delay(300);
    expect(guest.messages.length).toBe(0);
  });

  // ─── Scenario 9: Mux sync — both clients subscribe to same doc ───
  it("mux sync message relayed to peer but not echoed to sender", async () => {
    const room = await createRoom("int-mux-sync");
    const docId = "test.md";

    const clientA = await connectMux(room.id, room.token);
    clientA.ws.send(encodeMuxMessage(docId, MUX_SUBSCRIBE));
    await waitForMuxMessages(clientA.messages, 1); // SUBSCRIBED

    const clientB = await connectMux(room.id, room.token);
    clientB.ws.send(encodeMuxMessage(docId, MUX_SUBSCRIBE));
    await waitForMuxMessages(clientB.messages, 1); // SUBSCRIBED

    // Wait for SYNC_REQUEST to settle
    await delay(100);
    const beforeA = clientA.messages.length;
    const beforeB = clientB.messages.length;

    // Client A sends MUX_SYNC update
    const docA = new Y.Doc();
    docA.getText("content").insert(0, "sync from A");
    const update = Y.encodeStateAsUpdate(docA);

    const syncEncoder = encoding.createEncoder();
    syncProtocol.writeUpdate(syncEncoder, update);
    const syncPayload = encoding.toUint8Array(syncEncoder);

    clientA.ws.send(encodeMuxMessage(docId, MUX_SYNC, syncPayload));

    // Client B should receive it
    await waitForMuxMessages(clientB.messages, beforeB + 1);

    const syncMsgs = findMuxMessages(clientB.messages, docId, MUX_SYNC);
    expect(syncMsgs.length).toBeGreaterThan(0);

    // Verify client B can decode the content
    const docB = new Y.Doc();
    for (const msg of syncMsgs) {
      const decoder = decoding.createDecoder(msg.payload);
      const enc = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, enc, docB, null);
    }
    expect(docB.getText("content").toString()).toBe("sync from A");

    // Client A should NOT receive its own message back
    await delay(300);
    expect(clientA.messages.length).toBe(beforeA);

    docA.destroy();
    docB.destroy();
  });

  // ─── Scenario 10: Mux subscribe with clientID for awareness cleanup ───
  it("awareness cleanup sent to peers when client with clientID disconnects", async () => {
    const room = await createRoom("int-mux-awareness-cleanup");
    const docId = "awareness-doc";
    const CLIENT_A_ID = 42;

    const clientA = await connectMux(room.id, room.token);

    // Subscribe with clientID in payload
    const subEncoder = encoding.createEncoder();
    encoding.writeVarUint(subEncoder, CLIENT_A_ID);
    const subPayload = encoding.toUint8Array(subEncoder);
    clientA.ws.send(encodeMuxMessage(docId, MUX_SUBSCRIBE, subPayload));
    await waitForMuxMessages(clientA.messages, 1); // SUBSCRIBED

    const clientB = await connectMux(room.id, room.token);
    clientB.ws.send(encodeMuxMessage(docId, MUX_SUBSCRIBE));
    await waitForMuxMessages(clientB.messages, 1); // SUBSCRIBED

    // Wait for any SYNC_REQUEST messages to settle
    await delay(200);
    const beforeB = clientB.messages.length;

    // Client A disconnects
    const aClosed = new Promise<void>((resolve) => {
      clientA.ws.on("close", () => resolve());
    });
    clientA.ws.close();
    await aClosed;

    // Client B should receive awareness removal for client A
    await waitForMuxMessages(clientB.messages, beforeB + 1);

    const awarenessMsgs = findMuxMessages(clientB.messages, docId, MUX_AWARENESS);
    expect(awarenessMsgs.length).toBeGreaterThan(0);

    // Decode the last awareness message and verify it contains client A's ID with null state
    const lastAwareness = awarenessMsgs[awarenessMsgs.length - 1];
    const decoder = decoding.createDecoder(lastAwareness.payload);
    const count = decoding.readVarUint(decoder);
    expect(count).toBe(1);
    const removedId = decoding.readVarUint(decoder);
    expect(removedId).toBe(CLIENT_A_ID);
    const clockOrState = decoding.readVarUint(decoder);
    expect(clockOrState).toBe(0);
    const stateStr = decoding.readVarString(decoder);
    expect(stateStr).toBe("null");
  });
});
