import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { verifyJWT } from "./github-auth.js";
import { clearPermission, clearRoomPermissions, setPermission } from "./permissions.js";
import type { Permission } from "./persistence.js";
import { getRoom, removeRoom, touchRoom } from "./rooms.js";

const ALLOWED_TYPES = new Set([
  "file-op",
  "file-chunk-start",
  "file-chunk-data",
  "file-chunk-end",
  "presence-update",
  "session-end",
  "join-request",
  "join-response",
  "focus-request",
  "summon",
  "kick",
  "sync-request",
  "sync-response",
  "set-permission",
  "permission-update",
  "present-start",
  "present-stop",
  "ping",
  "pong",
]);

const MSG_RATE_WINDOW = 10_000;
const MSG_RATE_LIMIT = 100;

interface ControlClient {
  ws: WebSocket;
  userId: string;
  verifiedUserId: string | null;
  displayName: string;
  isHost: boolean;
  isApproved: boolean;
  permission: Permission;
  msgTimestamps: number[];
}

interface ControlRoom {
  clients: Map<WebSocket, ControlClient>;
  pendingApprovals: Map<string, WebSocket>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface ControlWSSOptions {
  onPermissionChange?: (roomId: string, userId: string, permission: Permission) => void;
}

export function createControlWSS(options?: ControlWSSOptions) {
  const rooms = new Map<string, ControlRoom>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });

  function getOrCreateRoom(roomId: string): ControlRoom {
    let room = rooms.get(roomId);
    if (!room) {
      room = { clients: new Map(), pendingApprovals: new Map() };
      rooms.set(roomId, room);
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }
    return room;
  }

  function broadcast(room: ControlRoom, data: Buffer | string, exclude?: WebSocket) {
    const str = typeof data === "string" ? data : data.toString("utf-8");
    for (const [ws, client] of room.clients) {
      if (ws !== exclude && client.isApproved && ws.readyState === WebSocket.OPEN) {
        ws.send(str);
      }
    }
  }

  function sendTo(ws: WebSocket, msg: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function findHost(room: ControlRoom): ControlClient | undefined {
    for (const client of room.clients.values()) {
      if (client.isHost) return client;
    }
    return undefined;
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage, roomId: string) => {
    const room = getOrCreateRoom(roomId);
    const serverRoom = getRoom(roomId);

    let verifiedUserId: string | null = null;
    try {
      const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
      const jwtToken = reqUrl.searchParams.get("jwt");
      if (jwtToken) {
        const payload = verifyJWT(jwtToken);
        if (payload) verifiedUserId = payload.sub;
      }
    } catch {}

    const client: ControlClient = {
      ws,
      userId: "",
      verifiedUserId,
      displayName: "",
      isHost: false,
      isApproved: true,
      permission: serverRoom?.defaultPermission || "read-write",
      msgTimestamps: [],
    };
    room.clients.set(ws, client);

    ws.on("error", (err) => {
      console.error(`[control] ws error for room ${roomId}:`, err.message);
      ws.close();
    });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const now = Date.now();
      client.msgTimestamps.push(now);
      while (client.msgTimestamps.length > 0 && client.msgTimestamps[0] < now - MSG_RATE_WINDOW) {
        client.msgTimestamps.shift();
      }
      if (client.msgTimestamps.length > MSG_RATE_LIMIT) {
        ws.close(1008, "rate limit exceeded");
        return;
      }

      const data =
        raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw instanceof Buffer
            ? raw
            : Buffer.concat(raw as Buffer[]);

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (typeof msg.type !== "string" || !ALLOWED_TYPES.has(msg.type)) {
        return;
      }

      touchRoom(roomId);

      if (msg.type === "ping") {
        sendTo(ws, { type: "pong", timestamp: msg.timestamp });
        return;
      }

      if (msg.type === "join-request") {
        if (!client.userId) {
          client.userId = typeof msg.userId === "string" ? msg.userId.slice(0, 128) : "";

          if (client.verifiedUserId && serverRoom?.hostUserId) {
            client.isHost = client.verifiedUserId === serverRoom.hostUserId;
          } else {
            client.isHost = !findHost(room);
          }
        }
        client.displayName =
          typeof msg.displayName === "string" ? msg.displayName.slice(0, 100) : "";

        if (serverRoom?.requireApproval) {
          client.isApproved = false;
          room.pendingApprovals.set(client.userId, ws);

          const host = findHost(room);
          if (host) {
            sendTo(host.ws, {
              type: "join-request",
              userId: client.userId,
              displayName: client.displayName,
              avatarUrl: msg.avatarUrl || "",
            });
          }
        } else {
          client.isApproved = true;
          setPermission(roomId, client.userId, client.permission);
          sendTo(ws, {
            type: "join-response",
            approved: true,
            permission: client.permission,
          });
        }
        return;
      }

      if (msg.type === "join-response" && client.isHost) {
        const targetUserId = msg.userId as string;
        const targetWs = room.pendingApprovals.get(targetUserId);
        if (targetWs) {
          room.pendingApprovals.delete(targetUserId);
          const targetClient = room.clients.get(targetWs);
          if (targetClient) {
            targetClient.isApproved = msg.approved as boolean;
            if (msg.permission) {
              targetClient.permission = msg.permission as Permission;
            }
            if (targetClient.isApproved && targetClient.userId) {
              setPermission(roomId, targetClient.userId, targetClient.permission);
            }
            sendTo(targetWs, {
              type: "join-response",
              approved: targetClient.isApproved,
              permission: targetClient.permission,
            });
          }
        }
        return;
      }

      if (msg.type === "kick" && client.isHost) {
        const targetUserId = msg.userId;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        for (const [clientWs, targetClient] of room.clients) {
          if (targetClient.userId === targetUserId) {
            sendTo(clientWs, { type: "kicked" });
            clientWs.close();
          }
        }
        return;
      }

      if (msg.type === "set-permission" && client.isHost) {
        const targetUserId = msg.userId;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        const permission = msg.permission;
        if (permission !== "read-write" && permission !== "read-only") return;
        setPermission(roomId, targetUserId, permission);
        options?.onPermissionChange?.(roomId, targetUserId, permission);
        for (const [clientWs, targetClient] of room.clients) {
          if (targetClient.userId === targetUserId) {
            targetClient.permission = permission;
            sendTo(clientWs, { type: "permission-update", permission });
          }
        }
        return;
      }

      if (!client.isApproved) return;

      const isFileWrite =
        msg.type === "file-op" ||
        msg.type === "file-chunk-start" ||
        msg.type === "file-chunk-data" ||
        msg.type === "file-chunk-end";
      if (isFileWrite && client.permission === "read-only") {
        return;
      }

      if (msg.type === "summon" && !client.isHost) {
        return;
      }
      if (msg.type === "present-start" && !client.isHost) {
        return;
      }
      if (msg.type === "present-stop" && !client.isHost) {
        return;
      }
      if (msg.type === "session-end" && !client.isHost) {
        return;
      }

      if (
        msg.type === "summon" &&
        typeof msg.targetUserId === "string" &&
        msg.targetUserId !== "__all__"
      ) {
        const targetUserId = msg.targetUserId;
        const strData = data.toString("utf-8");
        for (const [clientWs, targetClient] of room.clients) {
          if (targetClient.userId === targetUserId && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(strData);
          }
        }
        return;
      }

      if (msg.type === "presence-update") {
        if (msg.userId && !client.userId) {
          client.userId = (msg.userId as string).slice(0, 128);

          if (client.verifiedUserId && serverRoom?.hostUserId) {
            client.isHost = client.verifiedUserId === serverRoom.hostUserId;
          } else {
            client.isHost = !findHost(room);
          }
        }
        if (msg.displayName) client.displayName = (msg.displayName as string).slice(0, 100);
      }

      broadcast(room, data, ws);
    });

    ws.on("close", () => {
      const closingClient = room.clients.get(ws);
      if (closingClient) {
        room.pendingApprovals.delete(closingClient.userId);
        if (closingClient.userId) {
          clearPermission(roomId, closingClient.userId);
          const leaveMsg = JSON.stringify({
            type: "presence-leave",
            userId: closingClient.userId,
          });
          broadcast(room, leaveMsg, ws);
        }
      }
      room.clients.delete(ws);
      if (room.clients.size === 0) {
        room.cleanupTimer = setTimeout(() => {
          if (room.clients.size === 0) {
            clearRoomPermissions(roomId);
            rooms.delete(roomId);
            removeRoom(roomId).catch((err) => {
              console.error(`[control] failed to remove room ${roomId}:`, err);
            });
          }
        }, 35_000);
      }
    });
  });

  function closeAll() {
    for (const [, room] of rooms) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      for (const [ws] of room.clients) {
        ws.close(1000, "server shutting down");
      }
    }
    rooms.clear();
  }

  return { wss, closeAll };
}
