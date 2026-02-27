import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../index.js";
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

async function createRoom(name: string): Promise<RoomInfo> {
  const res = await fetch(`http://localhost:${port}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
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

function waitForMessages(messages: string[], count: number, timeoutMs = 3000): Promise<void> {
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

function sendJSON(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
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

describe("Control WebSocket handler", () => {
  it("broadcasts presence-update to others but not to sender", async () => {
    const room = await createRoom("ctrl-presence");
    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
    });

    await waitForMessages(clientB.messages, 1);
    const msg = JSON.parse(clientB.messages[0]);
    expect(msg.type).toBe("presence-update");
    expect(msg.userId).toBe("userA");
    expect(msg.displayName).toBe("Alice");

    await delay(300);
    expect(clientA.messages.length).toBe(0);
  });

  it("rejects unknown message types and does not broadcast them", async () => {
    const room = await createRoom("ctrl-unknown");
    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientA.ws, { type: "unknown-type", payload: "test" });

    await delay(300);
    expect(clientB.messages.length).toBe(0);
  });

  it("tracks identity from presence-update (verified via kick)", async () => {
    const room = await createRoom("ctrl-identity");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);

    sendJSON(host.ws, { type: "kick", userId: "guest-1" });

    await waitForMessages(guest.messages, 2);

    const kicked = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "kicked";
    });
    expect(kicked).toBeDefined();
    expect(JSON.parse(kicked!).type).toBe("kicked");
  });

  it("kick flow: host kicks guest, guest receives kicked and connection closes", async () => {
    const room = await createRoom("ctrl-kick");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });

    sendJSON(host.ws, { type: "kick", userId: "guest-1" });

    await waitForMessages(guest.messages, 2);

    const kickedMsg = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "kicked";
    });
    expect(kickedMsg).toBeDefined();
    expect(JSON.parse(kickedMsg!)).toEqual({ type: "kicked" });

    await guestClosed;
    expect(guest.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("broadcasts focus-request to all other clients", async () => {
    const room = await createRoom("ctrl-focus");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientA.ws, {
      type: "focus-request",
      filePath: "notes/hello.md",
      userId: "userA",
    });

    await waitForMessages(clientB.messages, 1);
    await waitForMessages(clientC.messages, 1);

    const msgB = JSON.parse(clientB.messages[0]);
    expect(msgB.type).toBe("focus-request");
    expect(msgB.filePath).toBe("notes/hello.md");

    const msgC = JSON.parse(clientC.messages[0]);
    expect(msgC.type).toBe("focus-request");
    expect(msgC.filePath).toBe("notes/hello.md");

    await delay(300);
    expect(clientA.messages.length).toBe(0);
  });

  it("summon with specific targetUserId routes only to that user", async () => {
    const room = await createRoom("ctrl-summon-target");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientC.ws, {
      type: "presence-update",
      userId: "userC",
      displayName: "Charlie",
    });
    await delay(100);

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
    });
    sendJSON(clientB.ws, {
      type: "presence-update",
      userId: "userB",
      displayName: "Bob",
    });

    await delay(100);

    clientA.messages.length = 0;
    clientB.messages.length = 0;
    clientC.messages.length = 0;

    sendJSON(clientC.ws, {
      type: "summon",
      targetUserId: "userA",
      filePath: "vault/important.md",
    });

    await waitForMessages(clientA.messages, 1);
    const msgA = JSON.parse(clientA.messages[0]);
    expect(msgA.type).toBe("summon");
    expect(msgA.targetUserId).toBe("userA");

    await delay(300);
    expect(clientB.messages.length).toBe(0);
  });

  it("summon with __all__ broadcasts to all others", async () => {
    const room = await createRoom("ctrl-summon-all");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientC.ws, {
      type: "presence-update",
      userId: "userC",
      displayName: "Charlie",
    });
    await delay(100);

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
    });
    sendJSON(clientB.ws, {
      type: "presence-update",
      userId: "userB",
      displayName: "Bob",
    });

    await delay(100);

    clientA.messages.length = 0;
    clientB.messages.length = 0;
    clientC.messages.length = 0;

    sendJSON(clientC.ws, {
      type: "summon",
      targetUserId: "__all__",
      filePath: "vault/meeting.md",
    });

    await waitForMessages(clientA.messages, 1);
    await waitForMessages(clientB.messages, 1);

    const msgA = JSON.parse(clientA.messages[0]);
    expect(msgA.type).toBe("summon");
    expect(msgA.targetUserId).toBe("__all__");

    const msgB = JSON.parse(clientB.messages[0]);
    expect(msgB.type).toBe("summon");
    expect(msgB.targetUserId).toBe("__all__");

    await delay(300);
    expect(clientC.messages.length).toBe(0);
  });

  it("blocks file-op from read-only clients via join-request auto-approve", async () => {
    const room = await createRoom("ctrl-readonly");

    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();

    serverRoom!.defaultPermission = "read-write";
    const host = await connectControl(room.id, room.token);
    await delay(50);

    serverRoom!.defaultPermission = "read-only";

    const guest = await connectControl(room.id, room.token);
    await delay(100);

    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "secret.md",
      content: "should not arrive",
    });

    await delay(300);
    expect(host.messages.length).toBe(0);

    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "readonly-guest",
      displayName: "ReadOnly",
    });

    await waitForMessages(host.messages, 1);
    const presenceMsg = JSON.parse(host.messages[0]);
    expect(presenceMsg.type).toBe("presence-update");
    expect(presenceMsg.userId).toBe("readonly-guest");
  });

  it("cleans up room when all clients disconnect", async () => {
    const room = await createRoom("ctrl-cleanup");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
      isHost: true,
    });
    sendJSON(clientB.ws, {
      type: "presence-update",
      userId: "userB",
      displayName: "Bob",
    });

    await delay(100);

    clientA.ws.close();
    clientB.ws.close();

    await delay(300);

    const lateComer = await connectControl(room.id, room.token);
    expect(lateComer.ws.readyState).toBe(WebSocket.OPEN);
    lateComer.ws.close();
  });

  it("auto-approves join-request when room does not require approval", async () => {
    const room = await createRoom("ctrl-join-auto");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    await delay(100);

    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForMessages(guest.messages, 1 + 1);
    const joinResponse = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "join-response";
    });
    expect(joinResponse).toBeDefined();
    const parsed = JSON.parse(joinResponse!);
    expect(parsed.approved).toBe(true);
    expect(parsed.permission).toBe("read-write");

    await delay(300);
    expect(host.messages.length).toBe(0);
  });

  it("non-host cannot kick other clients", async () => {
    const room = await createRoom("ctrl-no-kick");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
    });
    sendJSON(clientB.ws, {
      type: "presence-update",
      userId: "userB",
      displayName: "Bob",
    });

    await delay(100);
    clientA.messages.length = 0;
    clientB.messages.length = 0;

    sendJSON(clientB.ws, { type: "kick", userId: "userA" });

    await delay(300);
    const kickedMsg = clientA.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "kicked";
    });
    expect(kickedMsg).toBeUndefined();
    expect(clientA.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("broadcasts session-end to others", async () => {
    const room = await createRoom("ctrl-session-end");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
    });
    await delay(100);
    clientA.messages.length = 0;
    clientB.messages.length = 0;

    sendJSON(clientA.ws, { type: "session-end", reason: "host-left" });

    await waitForMessages(clientB.messages, 1);
    const msg = JSON.parse(clientB.messages[0]);
    expect(msg.type).toBe("session-end");
    expect(msg.reason).toBe("host-left");

    await delay(300);
    expect(clientA.messages.length).toBe(0);
  });

  it("disconnects client exceeding rate limit", async () => {
    const room = await createRoom("ctrl-rate-limit");

    const client = await connectControl(room.id, room.token);

    await delay(50);

    const closedPromise = new Promise<number>((resolve) => {
      client.ws.on("close", (code: number) => resolve(code));
    });

    for (let i = 0; i < 101; i++) {
      if (client.ws.readyState === WebSocket.OPEN) {
        sendJSON(client.ws, { type: "ping", timestamp: Date.now() });
      }
    }

    const closeCode = await closedPromise;
    expect(closeCode).toBe(1008);
  });

  it("cleans up pending approval on client disconnect", async () => {
    const room = await createRoom("ctrl-pending-cleanup");

    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.requireApproval = true;

    const host = await connectControl(room.id, room.token);
    await delay(50);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    await delay(100);

    const guest = await connectControl(room.id, room.token);
    await delay(50);

    host.messages.length = 0;
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-pending",
      displayName: "PendingGuest",
    });

    await waitForMessages(host.messages, 1);
    const joinReq = JSON.parse(host.messages[0]);
    expect(joinReq.type).toBe("join-request");
    expect(joinReq.userId).toBe("guest-pending");

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    guest.ws.close();
    await guestClosed;

    host.messages.length = 0;
    sendJSON(host.ws, {
      type: "join-response",
      userId: "guest-pending",
      approved: true,
      permission: "read-write",
    });

    await delay(300);
  });

  it("host can change guest permission via set-permission", async () => {
    const room = await createRoom("ctrl-set-perm");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);
    guest.messages.length = 0;
    host.messages.length = 0;

    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "read-only",
    });

    await waitForMessages(guest.messages, 1);
    const permMsg = JSON.parse(guest.messages[0]);
    expect(permMsg.type).toBe("permission-update");
    expect(permMsg.permission).toBe("read-only");

    guest.messages.length = 0;
    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "blocked.md",
      content: "should not arrive",
    });

    await delay(300);
    expect(host.messages.length).toBe(0);

    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "read-write",
    });

    await waitForMessages(guest.messages, 1);
    const permMsg2 = JSON.parse(guest.messages[0]);
    expect(permMsg2.type).toBe("permission-update");
    expect(permMsg2.permission).toBe("read-write");

    guest.messages.length = 0;
    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "allowed.md",
      content: "should arrive",
    });

    await waitForMessages(host.messages, 1);
    const fileOp = JSON.parse(host.messages[0]);
    expect(fileOp.type).toBe("file-op");
    expect(fileOp.path).toBe("allowed.md");
  });

  it("non-host cannot send set-permission", async () => {
    const room = await createRoom("ctrl-set-perm-nonhost");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);
    host.messages.length = 0;
    guest.messages.length = 0;

    sendJSON(guest.ws, {
      type: "set-permission",
      userId: "host-1",
      permission: "read-only",
    });

    await delay(300);
    const permMsg = host.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "permission-update";
    });
    expect(permMsg).toBeUndefined();
  });

  it("unapproved client cannot send file-ops in requireApproval room", async () => {
    const room = await createRoom("ctrl-unapproved-fileop");

    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.requireApproval = true;

    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    await delay(100);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "unapproved-guest",
      displayName: "Guest",
    });
    await delay(100);

    host.messages.length = 0;
    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "sneaky.md",
      content: "should not arrive",
    });

    await delay(300);
    const fileOpMsg = host.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "file-op";
    });
    expect(fileOpMsg).toBeUndefined();
  });

  it("userId cannot be changed via second join-request", async () => {
    const room = await createRoom("ctrl-userid-lock");

    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await delay(100);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "original-id",
      displayName: "Original",
    });
    await delay(100);

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "spoofed-id",
      displayName: "Spoofed",
    });
    await delay(100);

    sendJSON(host.ws, { type: "kick", userId: "spoofed-id" });
    await delay(300);
    expect(guest.ws.readyState).toBe(WebSocket.OPEN);

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    sendJSON(host.ws, { type: "kick", userId: "original-id" });
    await guestClosed;
    expect(guest.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("first client becomes host via join-request (not just presence-update)", async () => {
    const room = await createRoom("ctrl-host-via-join");

    const client = await connectControl(room.id, room.token);
    await delay(50);

    sendJSON(client.ws, {
      type: "join-request",
      userId: "first-user",
      displayName: "First",
    });
    await delay(100);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "second-user",
      displayName: "Second",
    });
    await delay(100);

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    sendJSON(client.ws, { type: "kick", userId: "second-user" });
    await guestClosed;
    expect(guest.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("set-permission with invalid permission value is ignored", async () => {
    const room = await createRoom("ctrl-set-perm-invalid");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);
    guest.messages.length = 0;

    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "admin",
    });

    await delay(300);
    expect(guest.messages.length).toBe(0);
  });

  it("host-transfer-offer forwarded to target guest", async () => {
    const room = await createRoom("ctrl-transfer-offer");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);
    guest.messages.length = 0;

    sendJSON(host.ws, {
      type: "host-transfer-offer",
      userId: "guest-1",
    });

    await waitForMessages(guest.messages, 1);
    const msg = JSON.parse(guest.messages[0]);
    expect(msg.type).toBe("host-transfer-offer");
    expect(msg.userId).toBe("host-1");
    expect(msg.displayName).toBe("Host");
  });

  it("non-host cannot send host-transfer-offer", async () => {
    const room = await createRoom("ctrl-transfer-nonhost");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);
    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "host-transfer-offer",
      userId: "host-1",
    });

    await delay(300);
    const offerMsg = host.messages.find((m) => JSON.parse(m).type === "host-transfer-offer");
    expect(offerMsg).toBeUndefined();
  });

  it("host-transfer-accept swaps roles and broadcasts host-changed", async () => {
    const room = await createRoom("ctrl-transfer-accept");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);

    sendJSON(host.ws, {
      type: "host-transfer-offer",
      userId: "guest-1",
    });

    await delay(300);
    guest.messages.length = 0;
    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "host-transfer-accept",
      userId: "host-1",
    });

    await waitForMessages(guest.messages, 1);
    const completeMsg = JSON.parse(guest.messages[0]);
    expect(completeMsg.type).toBe("host-transfer-complete");

    await waitForMessages(host.messages, 1);
    const changedMsg = JSON.parse(host.messages[0]);
    expect(changedMsg.type).toBe("host-changed");
    expect(changedMsg.userId).toBe("guest-1");
    expect(changedMsg.displayName).toBe("Guest");
  });

  it("host-transfer-decline forwarded to old host", async () => {
    const room = await createRoom("ctrl-transfer-decline");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);

    sendJSON(host.ws, {
      type: "host-transfer-offer",
      userId: "guest-1",
    });

    await delay(300);
    guest.messages.length = 0;
    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "host-transfer-decline",
      userId: "host-1",
    });

    await waitForMessages(host.messages, 1);
    const declineMsg = JSON.parse(host.messages[0]);
    expect(declineMsg.type).toBe("host-transfer-decline");
    expect(declineMsg.userId).toBe("guest-1");
  });

  it("host disconnect broadcasts host-disconnected", async () => {
    const room = await createRoom("ctrl-host-disconnect");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await delay(100);

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await delay(100);
    guest.messages.length = 0;

    host.ws.close();

    await waitForMessages(guest.messages, 2);
    const hostDisconnected = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "host-disconnected";
    });
    expect(hostDisconnected).toBeDefined();
  });

  it("kicked user must be re-approved on rejoin (no requireApproval)", async () => {
    const room = await createRoom("ctrl-kick-rejoin");

    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await delay(100);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });
    await waitForMessages(guest.messages, 1);
    const autoApproval = JSON.parse(guest.messages[0]);
    expect(autoApproval.type).toBe("join-response");
    expect(autoApproval.approved).toBe(true);

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    sendJSON(host.ws, { type: "kick", userId: "guest-1" });
    await guestClosed;
    await delay(100);

    host.messages.length = 0;
    const guest2 = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest2.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForMessages(host.messages, 1);
    const joinReq = JSON.parse(host.messages[0]);
    expect(joinReq.type).toBe("join-request");
    expect(joinReq.userId).toBe("guest-1");

    await delay(200);
    const earlyResponse = guest2.messages.find((m) => JSON.parse(m).type === "join-response");
    expect(earlyResponse).toBeUndefined();

    sendJSON(host.ws, {
      type: "join-response",
      userId: "guest-1",
      approved: true,
      permission: "read-write",
    });

    await waitForMessages(guest2.messages, 1);
    const approval = JSON.parse(guest2.messages[0]);
    expect(approval.type).toBe("join-response");
    expect(approval.approved).toBe(true);
  });

  it("kicked user approval is one-time - second rejoin auto-approves", async () => {
    const room = await createRoom("ctrl-kick-onetime");

    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await delay(100);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });
    await waitForMessages(guest.messages, 1);

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    sendJSON(host.ws, { type: "kick", userId: "guest-1" });
    await guestClosed;

    host.messages.length = 0;
    const guest2 = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest2.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });
    await waitForMessages(host.messages, 1);

    sendJSON(host.ws, {
      type: "join-response",
      userId: "guest-1",
      approved: true,
      permission: "read-write",
    });
    await waitForMessages(guest2.messages, 1);
    expect(JSON.parse(guest2.messages[0]).approved).toBe(true);

    const guest2Closed = new Promise<void>((resolve) => {
      guest2.ws.on("close", () => resolve());
    });
    guest2.ws.close();
    await guest2Closed;
    await delay(100);

    host.messages.length = 0;
    const guest3 = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest3.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForMessages(guest3.messages, 1);
    const autoApproval = JSON.parse(guest3.messages[0]);
    expect(autoApproval.type).toBe("join-response");
    expect(autoApproval.approved).toBe(true);

    await delay(200);
    const hostJoinReq = host.messages.find((m) => JSON.parse(m).type === "join-request");
    expect(hostJoinReq).toBeUndefined();
  });

  it("readOnlyPatterns blocks guest writes to matching files", async () => {
    const res = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ctrl-ro-patterns",
        readOnlyPatterns: ["secret/**", "*.lock"],
      }),
    });
    const room = (await res.json()) as RoomInfo;

    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await waitForMessages(host.messages, 1);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });
    await waitForMessages(guest.messages, 1);
    const joinResp = JSON.parse(guest.messages[0]);
    expect(joinResp.approved).toBe(true);
    expect(joinResp.readOnlyPatterns).toEqual(["secret/**", "*.lock"]);

    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "file-op",
      op: { type: "create", path: "secret/notes.md", content: "blocked" },
    });
    sendJSON(guest.ws, {
      type: "file-op",
      op: { type: "create", path: "data.lock", content: "blocked" },
    });
    await delay(300);
    const guestFileOps = host.messages.filter((m) => JSON.parse(m).type === "file-op");
    expect(guestFileOps.length).toBe(0);

    sendJSON(guest.ws, {
      type: "file-op",
      op: { type: "create", path: "allowed.md", content: "ok" },
    });
    await waitForMessages(host.messages, 1);
    const allowed = JSON.parse(host.messages[0]);
    expect(allowed.type).toBe("file-op");
  });

  it("readOnlyPatterns does not block host writes", async () => {
    const res = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ctrl-ro-host",
        readOnlyPatterns: ["secret/**"],
      }),
    });
    const room = (await res.json()) as RoomInfo;

    const host = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await waitForMessages(host.messages, 1);

    const guest = await connectControl(room.id, room.token);
    await delay(50);
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });
    await waitForMessages(guest.messages, 1);

    guest.messages.length = 0;

    sendJSON(host.ws, {
      type: "file-op",
      op: {
        type: "create",
        path: "secret/notes.md",
        content: "host can write",
      },
    });
    await waitForMessages(guest.messages, 1);
    const fileOp = JSON.parse(guest.messages[0]);
    expect(fileOp.type).toBe("file-op");
  });
});
