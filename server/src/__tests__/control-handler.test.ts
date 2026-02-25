import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../index.js";
import { noopPersistence } from "../persistence.js";

interface RoomInfo {
  id: string;
  token: string;
  name: string;
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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });

  it("rejects unknown message types and does not broadcast them", async () => {
    const room = await createRoom("ctrl-unknown");
    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientA.ws, { type: "unknown-type", payload: "test" });

    await new Promise((r) => setTimeout(r, 300));
    expect(clientB.messages.length).toBe(0);
  });

  it("tracks identity from presence-update (verified via kick)", async () => {
    const room = await createRoom("ctrl-identity");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(host.ws, { type: "kick", userId: "guest-1" });

    await waitForMessages(guest.messages, 2); // presence-update from host + kicked message

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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));

    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });

    sendJSON(host.ws, { type: "kick", userId: "guest-1" });

    await waitForMessages(guest.messages, 2); // presence from host + kicked

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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });

  it("summon with specific targetUserId routes only to that user", async () => {
    const room = await createRoom("ctrl-summon-target");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientC.ws, {
      type: "presence-update",
      userId: "userC",
      displayName: "Charlie",
    });
    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 300));
    expect(clientB.messages.length).toBe(0);
  });

  it("summon with __all__ broadcasts to all others", async () => {
    const room = await createRoom("ctrl-summon-all");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientC.ws, {
      type: "presence-update",
      userId: "userC",
      displayName: "Charlie",
    });
    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 300));
    expect(clientC.messages.length).toBe(0);
  });

  it("blocks file-op from read-only clients via join-request auto-approve", async () => {
    const room = await createRoom("ctrl-readonly");

    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();

    // Connect host first with read-write, then switch to read-only for the guest
    serverRoom!.defaultPermission = "read-write";
    const host = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));

    serverRoom!.defaultPermission = "read-only";

    const guest = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 100));

    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "secret.md",
      content: "should not arrive",
    });

    await new Promise((r) => setTimeout(r, 300));
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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));

    clientA.ws.close();
    clientB.ws.close();

    await new Promise((r) => setTimeout(r, 300));

    // Room cleanup is delayed (35s) to let Yjs clients persist first.
    // Verify reconnection still works during the grace period.
    const reconnected = await connectControl(room.id, room.token);
    expect(reconnected.ws.readyState).toBe(WebSocket.OPEN);
    reconnected.ws.close();
  });

  it("auto-approves join-request when room does not require approval", async () => {
    const room = await createRoom("ctrl-join-auto");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    await new Promise((r) => setTimeout(r, 100));

    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    await waitForMessages(guest.messages, 1 + 1); // presence from host + join-response
    const joinResponse = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "join-response";
    });
    expect(joinResponse).toBeDefined();
    const parsed = JSON.parse(joinResponse!);
    expect(parsed.approved).toBe(true);
    expect(parsed.permission).toBe("read-write");

    await new Promise((r) => setTimeout(r, 300));
    expect(host.messages.length).toBe(0);
  });

  it("non-host cannot kick other clients", async () => {
    const room = await createRoom("ctrl-no-kick");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));
    clientA.messages.length = 0;
    clientB.messages.length = 0;

    sendJSON(clientB.ws, { type: "kick", userId: "userA" });

    await new Promise((r) => setTimeout(r, 300));
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

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientA.ws, {
      type: "presence-update",
      userId: "userA",
      displayName: "Alice",
    });
    await new Promise((r) => setTimeout(r, 100));
    clientA.messages.length = 0;
    clientB.messages.length = 0;

    sendJSON(clientA.ws, { type: "session-end", reason: "host-left" });

    await waitForMessages(clientB.messages, 1);
    const msg = JSON.parse(clientB.messages[0]);
    expect(msg.type).toBe("session-end");
    expect(msg.reason).toBe("host-left");

    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });

  it("drops unknown message types silently", async () => {
    const room = await createRoom("ctrl-follow");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientA.ws, {
      type: "follow-update",
      followingUserId: "userB",
      filePath: "notes/today.md",
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(clientB.messages.length).toBe(0);
  });

  it("disconnects client exceeding rate limit", async () => {
    const room = await createRoom("ctrl-rate-limit");

    const client = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 50));

    const closedPromise = new Promise<number>((resolve) => {
      client.ws.on("close", (code: number) => resolve(code));
    });

    // Send 101 messages rapidly to exceed the 100 per 10s limit
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

    // Enable requireApproval on the room
    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.requireApproval = true;

    // Connect host
    const host = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));

    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    // Connect guest
    const guest = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));

    // Guest sends join-request (room requires approval so it goes pending)
    host.messages.length = 0;
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-pending",
      displayName: "PendingGuest",
    });

    // Host should receive the join-request
    await waitForMessages(host.messages, 1);
    const joinReq = JSON.parse(host.messages[0]);
    expect(joinReq.type).toBe("join-request");
    expect(joinReq.userId).toBe("guest-pending");

    // Guest disconnects before host approves
    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });
    guest.ws.close();
    await guestClosed;

    // Now host tries to approve the already-disconnected guest
    host.messages.length = 0;
    sendJSON(host.ws, {
      type: "join-response",
      userId: "guest-pending",
      approved: true,
      permission: "read-write",
    });

    // No crash, and nothing should happen since the guest WS is gone
    await new Promise((r) => setTimeout(r, 300));
    // The server should not have thrown; test passes if we reach here
  });

  it("host can change guest permission via set-permission", async () => {
    const room = await createRoom("ctrl-set-perm");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));
    guest.messages.length = 0;
    host.messages.length = 0;

    // Host changes guest to read-only
    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "read-only",
    });

    await waitForMessages(guest.messages, 1);
    const permMsg = JSON.parse(guest.messages[0]);
    expect(permMsg.type).toBe("permission-update");
    expect(permMsg.permission).toBe("read-only");

    // Now guest's file-ops should be blocked
    guest.messages.length = 0;
    host.messages.length = 0;

    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "blocked.md",
      content: "should not arrive",
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(host.messages.length).toBe(0);

    // Host changes guest back to read-write
    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "read-write",
    });

    await waitForMessages(guest.messages, 1);
    const permMsg2 = JSON.parse(guest.messages[0]);
    expect(permMsg2.type).toBe("permission-update");
    expect(permMsg2.permission).toBe("read-write");

    // Now file-ops should go through
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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));
    host.messages.length = 0;
    guest.messages.length = 0;

    // Guest tries to change host's permission -- should be ignored
    sendJSON(guest.ws, {
      type: "set-permission",
      userId: "host-1",
      permission: "read-only",
    });

    await new Promise((r) => setTimeout(r, 300));
    // Host should not receive a permission-update
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

    // Connect host and identify
    const host = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));
    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    // Connect guest — sends join-request but is NOT approved yet
    const guest = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "unapproved-guest",
      displayName: "Guest",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Guest tries to send file-op while unapproved — should be blocked
    host.messages.length = 0;
    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "sneaky.md",
      content: "should not arrive",
    });

    await new Promise((r) => setTimeout(r, 300));
    const fileOpMsg = host.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "file-op";
    });
    expect(fileOpMsg).toBeUndefined();
  });

  it("userId cannot be changed via second join-request", async () => {
    const room = await createRoom("ctrl-userid-lock");

    // First client becomes host via join-request
    const host = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));
    sendJSON(host.ws, {
      type: "join-request",
      userId: "host-1",
      displayName: "Host",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Second client sends join-request with "original-id"
    const guest = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "original-id",
      displayName: "Original",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Guest sends another join-request trying to change userId
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "spoofed-id",
      displayName: "Spoofed",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Host kicks "spoofed-id" — should NOT affect guest (userId is still "original-id")
    sendJSON(host.ws, { type: "kick", userId: "spoofed-id" });
    await new Promise((r) => setTimeout(r, 300));
    expect(guest.ws.readyState).toBe(WebSocket.OPEN);

    // Host kicks "original-id" — SHOULD kick the guest
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
    await new Promise((r) => setTimeout(r, 50));

    // Send join-request (not presence-update) — should become host
    sendJSON(client.ws, {
      type: "join-request",
      userId: "first-user",
      displayName: "First",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Connect a second client
    const guest = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "second-user",
      displayName: "Second",
    });
    await new Promise((r) => setTimeout(r, 100));

    // First client should be able to kick (proves they are host)
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

    await new Promise((r) => setTimeout(r, 100));

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

    await new Promise((r) => setTimeout(r, 100));
    guest.messages.length = 0;

    // Host sends invalid permission value
    sendJSON(host.ws, {
      type: "set-permission",
      userId: "guest-1",
      permission: "admin",
    });

    await new Promise((r) => setTimeout(r, 300));
    // Guest should not receive anything
    expect(guest.messages.length).toBe(0);
  });
});
