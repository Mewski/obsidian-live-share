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

    // Sender should NOT receive an echo
    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });

  it("rejects unknown message types and does not broadcast them", async () => {
    const room = await createRoom("ctrl-unknown");
    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientA.ws, { type: "unknown-type", payload: "test" });

    // Wait and confirm B receives nothing
    await new Promise((r) => setTimeout(r, 300));
    expect(clientB.messages.length).toBe(0);
  });

  it("tracks identity from presence-update (verified via kick)", async () => {
    const room = await createRoom("ctrl-identity");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    // Host identifies itself
    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    // Guest identifies itself
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await new Promise((r) => setTimeout(r, 100));

    // Host kicks guest by userId -- this only works if identity was tracked
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

    // Host sends presence-update with isHost
    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    // Guest sends presence-update with userId
    sendJSON(guest.ws, {
      type: "presence-update",
      userId: "guest-1",
      displayName: "Guest",
    });

    await new Promise((r) => setTimeout(r, 100));

    // Track when guest connection closes
    const guestClosed = new Promise<void>((resolve) => {
      guest.ws.on("close", () => resolve());
    });

    // Host kicks guest
    sendJSON(host.ws, { type: "kick", userId: "guest-1" });

    // Guest should receive "kicked" message
    await waitForMessages(guest.messages, 2); // presence from host + kicked

    const kickedMsg = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "kicked";
    });
    expect(kickedMsg).toBeDefined();
    expect(JSON.parse(kickedMsg!)).toEqual({ type: "kicked" });

    // Guest connection should close
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

    // Sender should NOT receive it
    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });

  it("summon with specific targetUserId routes only to that user", async () => {
    const room = await createRoom("ctrl-summon-target");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    // Set userIds via presence-update
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

    // Clear messages from presence broadcasts
    clientA.messages.length = 0;
    clientB.messages.length = 0;
    clientC.messages.length = 0;

    // C sends summon targeting userA
    sendJSON(clientC.ws, {
      type: "summon",
      targetUserId: "userA",
      filePath: "vault/important.md",
    });

    await waitForMessages(clientA.messages, 1);
    const msgA = JSON.parse(clientA.messages[0]);
    expect(msgA.type).toBe("summon");
    expect(msgA.targetUserId).toBe("userA");

    // B should NOT receive the summon
    await new Promise((r) => setTimeout(r, 300));
    expect(clientB.messages.length).toBe(0);
  });

  it("summon with __all__ broadcasts to all others", async () => {
    const room = await createRoom("ctrl-summon-all");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);
    const clientC = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    // Set userIds
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

    // Clear messages
    clientA.messages.length = 0;
    clientB.messages.length = 0;
    clientC.messages.length = 0;

    // C sends summon targeting __all__
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

    // Sender should NOT receive it
    await new Promise((r) => setTimeout(r, 300));
    expect(clientC.messages.length).toBe(0);
  });

  it("blocks file-op from read-only clients via join-request auto-approve", async () => {
    // To get a read-only client, we need the room's defaultPermission to be "read-only".
    // Since the REST API doesn't expose this field, we create a room and then
    // mutate it via the rooms module. Instead, we can test through the join-request flow:
    // A room with requireApproval where the host sets permission to "read-only" in the
    // join-response. However, since the REST API doesn't let us set requireApproval either,
    // we test this differently:
    //
    // We create a room, then use the internal getRoom to set defaultPermission.
    // But since we can't import getRoom in tests easily without side effects,
    // we use a workaround: the control handler reads serverRoom?.defaultPermission
    // at connection time. We need to set it before connecting.
    //
    // Alternative approach: Use the requireApproval + join-response flow.
    // We'll test by importing getRoom and mutating the room directly.

    const room = await createRoom("ctrl-readonly");

    // Directly mutate the room to set defaultPermission to read-only
    // We need to import getRoom for this
    const { getRoom } = await import("../rooms.js");
    const serverRoom = getRoom(room.id);
    expect(serverRoom).toBeDefined();
    serverRoom!.defaultPermission = "read-only";

    // Connect host (before the mutation would ideally be "read-write" but we need
    // host to be read-write). Let's set up host first, then set permission, then guest.
    // Actually, the permission is read at connection time. So let's connect host first.
    serverRoom!.defaultPermission = "read-write";

    const host = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 50));

    // Now set room to read-only for subsequent connections
    serverRoom!.defaultPermission = "read-only";

    const guest = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 100));

    // Guest sends file-op -- should be blocked
    sendJSON(guest.ws, {
      type: "file-op",
      op: "create",
      path: "secret.md",
      content: "should not arrive",
    });

    // Wait and confirm host receives nothing
    await new Promise((r) => setTimeout(r, 300));
    expect(host.messages.length).toBe(0);

    // Verify that a non-file-op message from guest still works
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

  it("cleans up room when all clients disconnect and fresh connects work", async () => {
    const room = await createRoom("ctrl-cleanup");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    // Both identify themselves
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

    // Disconnect both clients
    clientA.ws.close();
    clientB.ws.close();

    // Wait for close handlers to fire and room cleanup to happen
    await new Promise((r) => setTimeout(r, 300));

    // Reconnect fresh -- if the room was properly cleaned up, this should
    // create a new ControlRoom internally with no stale state
    const freshClient = await connectControl(room.id, room.token);
    await new Promise((r) => setTimeout(r, 100));

    // The fresh client should be able to connect and operate normally
    expect(freshClient.ws.readyState).toBe(WebSocket.OPEN);

    // Send a presence-update -- no one else to receive it, but it shouldn't error
    sendJSON(freshClient.ws, {
      type: "presence-update",
      userId: "freshUser",
      displayName: "Fresh",
      isHost: true,
    });

    // Confirm no messages arrive (no ghost clients from the old room)
    await new Promise((r) => setTimeout(r, 300));
    expect(freshClient.messages.length).toBe(0);
  });

  it("auto-approves join-request when room does not require approval", async () => {
    const room = await createRoom("ctrl-join-auto");

    const host = await connectControl(room.id, room.token);
    const guest = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    // Host identifies
    sendJSON(host.ws, {
      type: "presence-update",
      userId: "host-1",
      displayName: "Host",
      isHost: true,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Clear host messages from guest's presence broadcast
    host.messages.length = 0;

    // Guest sends join-request
    sendJSON(guest.ws, {
      type: "join-request",
      userId: "guest-1",
      displayName: "Guest",
    });

    // Guest should get auto-approved join-response
    await waitForMessages(guest.messages, 1 + 1); // presence from host + join-response
    const joinResponse = guest.messages.find((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === "join-response";
    });
    expect(joinResponse).toBeDefined();
    const parsed = JSON.parse(joinResponse!);
    expect(parsed.approved).toBe(true);
    expect(parsed.permission).toBe("read-write");

    // Host should NOT receive the join-request (auto-approved, not forwarded)
    await new Promise((r) => setTimeout(r, 300));
    expect(host.messages.length).toBe(0);
  });

  it("non-host cannot kick other clients", async () => {
    const room = await createRoom("ctrl-no-kick");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    // A identifies first — becomes host via fallback logic (no hostUserId on room)
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

    // B (non-host guest) tries to kick A
    sendJSON(clientB.ws, { type: "kick", userId: "userA" });

    // The kick handler only executes for hosts, so the kick is NOT processed.
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

    sendJSON(clientA.ws, { type: "session-end", reason: "host-left" });

    await waitForMessages(clientB.messages, 1);
    const msg = JSON.parse(clientB.messages[0]);
    expect(msg.type).toBe("session-end");
    expect(msg.reason).toBe("host-left");

    // Sender doesn't get it back
    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });

  it("broadcasts follow-update to others", async () => {
    const room = await createRoom("ctrl-follow");

    const clientA = await connectControl(room.id, room.token);
    const clientB = await connectControl(room.id, room.token);

    await new Promise((r) => setTimeout(r, 100));

    sendJSON(clientA.ws, {
      type: "follow-update",
      followingUserId: "userB",
      filePath: "notes/today.md",
    });

    await waitForMessages(clientB.messages, 1);
    const msg = JSON.parse(clientB.messages[0]);
    expect(msg.type).toBe("follow-update");
    expect(msg.followingUserId).toBe("userB");

    await new Promise((r) => setTimeout(r, 300));
    expect(clientA.messages.length).toBe(0);
  });
});
