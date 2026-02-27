import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { appendLog } from "./audit-log.js";
import { verifyJWT } from "./github-auth.js";
import {
  clearPermission,
  clearRoomPermissions,
  clearUserFilePermissions,
  getEffectivePermission,
  getPermission,
  setFilePermission,
  setPermission,
} from "./permissions.js";
import type { Permission } from "./persistence.js";
import { getRoom, removeRoom, touchRoom } from "./rooms.js";

const ALLOWED_TYPES = new Set([
  "file-op",
  "file-chunk-start",
  "file-chunk-data",
  "file-chunk-end",
  "file-chunk-resume",
  "presence-update",
  "session-end",
  "join-request",
  "join-response",
  "focus-request",
  "summon",
  "kick",
  "sync-request",
  "set-permission",
  "permission-update",
  "set-file-permission",
  "file-permission-update",
  "present-start",
  "present-stop",
  "ping",
  "pong",
  "host-transfer-offer",
  "host-transfer-accept",
  "host-transfer-decline",
  "host-changed",
  "host-disconnected",
]);

const MSG_RATE_WINDOW = 10_000;
const MSG_RATE_LIMIT = 100;
const UNKNOWN_TYPE_WARN_LIMIT = 10;
let unknownTypeWarnCount = 0;

interface ControlClient {
  ws: WebSocket;
  userId: string;
  verifiedUserId: string | null;
  displayName: string;
  isHost: boolean;
  isApproved: boolean;
  permission: Permission;
  msgTimestamps: number[];
  joinOrder: number;
}

interface ControlRoom {
  clients: Map<WebSocket, ControlClient>;
  pendingApprovals: Map<string, WebSocket>;
  pendingTransferTarget: string | null;
  kickedUserIds: Set<string>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  nextJoinOrder: number;
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
      room = {
        clients: new Map(),
        pendingApprovals: new Map(),
        pendingTransferTarget: null,
        kickedUserIds: new Set(),
        nextJoinOrder: 0,
      };
      rooms.set(roomId, room);
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }
    return room;
  }

  function safeSend(ws: WebSocket, data: string) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    } catch {}
  }

  function broadcast(room: ControlRoom, data: Buffer | string, exclude?: WebSocket) {
    const messageString = typeof data === "string" ? data : data.toString("utf-8");
    for (const [ws, client] of room.clients) {
      if (ws !== exclude && client.isApproved) safeSend(ws, messageString);
    }
  }

  function sendTo(ws: WebSocket, message: Record<string, unknown>) {
    safeSend(ws, JSON.stringify(message));
  }

  function getHostClient(room: ControlRoom): ControlClient | undefined {
    for (const client of room.clients.values()) {
      if (client.isHost) return client;
    }
    return undefined;
  }

  function findClientByUserId(room: ControlRoom, userId: string): ControlClient | undefined {
    for (const client of room.clients.values()) {
      if (client.userId === userId) return client;
    }
    return undefined;
  }

  const HOST_ONLY_TYPES = new Set([
    "summon",
    "present-start",
    "present-stop",
    "session-end",
    "host-transfer-offer",
  ]);

  function determineHostStatus(
    client: ControlClient,
    room: ControlRoom,
    serverRoom: ReturnType<typeof getRoom>,
  ): void {
    if (client.verifiedUserId && serverRoom?.hostUserId) {
      client.isHost = client.verifiedUserId === serverRoom.hostUserId;
    } else {
      client.isHost = !getHostClient(room);
    }
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
      joinOrder: room.nextJoinOrder++,
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
        if (unknownTypeWarnCount < UNKNOWN_TYPE_WARN_LIMIT) {
          unknownTypeWarnCount++;
          console.warn(`[control] dropped unknown type from ${client.userId}:`, msg.type);
        }
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

          determineHostStatus(client, room, serverRoom);
        }
        client.displayName =
          typeof msg.displayName === "string" ? msg.displayName.slice(0, 100) : "";

        if (serverRoom?.requireApproval) {
          const existingPermission = client.userId
            ? getPermission(roomId, client.userId)
            : undefined;
          if (existingPermission) {
            client.isApproved = true;
            client.permission = existingPermission;
            appendLog(roomId, {
              timestamp: Date.now(),
              event: "rejoin",
              userId: client.userId,
              displayName: client.displayName,
            });
            sendTo(ws, {
              type: "join-response",
              approved: true,
              permission: client.permission,
            });
          } else {
            client.isApproved = false;
            room.pendingApprovals.set(client.userId, ws);

            const host = getHostClient(room);
            if (host) {
              sendTo(host.ws, {
                type: "join-request",
                userId: client.userId,
                displayName: client.displayName,
                avatarUrl: msg.avatarUrl || "",
                verified: !!client.verifiedUserId,
              });
            }
          }
        } else if (room.kickedUserIds.has(client.userId)) {
          const host = getHostClient(room);
          if (!host) {
            sendTo(ws, { type: "join-response", approved: false });
            return;
          }
          room.kickedUserIds.delete(client.userId);
          client.isApproved = false;
          room.pendingApprovals.set(client.userId, ws);
          sendTo(host.ws, {
            type: "join-request",
            userId: client.userId,
            displayName: client.displayName,
            avatarUrl: msg.avatarUrl || "",
            verified: !!client.verifiedUserId,
          });
        } else {
          client.isApproved = true;
          setPermission(roomId, client.userId, client.permission);
          appendLog(roomId, {
            timestamp: Date.now(),
            event: "join",
            userId: client.userId,
            displayName: client.displayName,
          });
          sendTo(ws, {
            type: "join-response",
            approved: true,
            permission: client.permission,
          });
        }
        return;
      }

      if (msg.type === "join-response" && client.isHost) {
        const targetUserId = msg.userId;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        if (typeof msg.approved !== "boolean") return;
        const targetWs = room.pendingApprovals.get(targetUserId);
        if (targetWs) {
          room.pendingApprovals.delete(targetUserId);
          const targetClient = room.clients.get(targetWs);
          if (targetClient) {
            targetClient.isApproved = msg.approved;
            if (msg.permission === "read-write" || msg.permission === "read-only") {
              targetClient.permission = msg.permission;
            }
            if (targetClient.isApproved && targetClient.userId) {
              setPermission(roomId, targetClient.userId, targetClient.permission);
              appendLog(roomId, {
                timestamp: Date.now(),
                event: "join",
                userId: targetClient.userId,
                displayName: targetClient.displayName,
              });
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
        room.kickedUserIds.add(targetUserId);
        for (const [clientWs, targetClient] of room.clients) {
          if (targetClient.userId === targetUserId) {
            appendLog(roomId, {
              timestamp: Date.now(),
              event: "kick",
              userId: targetClient.userId,
              displayName: targetClient.displayName,
              details: `kicked by ${client.displayName}`,
            });
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
        appendLog(roomId, {
          timestamp: Date.now(),
          event: "permission-change",
          userId: targetUserId,
          displayName: "",
          details: permission,
        });
        options?.onPermissionChange?.(roomId, targetUserId, permission);
        for (const [clientWs, targetClient] of room.clients) {
          if (targetClient.userId === targetUserId) {
            targetClient.permission = permission;
            sendTo(clientWs, { type: "permission-update", permission });
          }
        }
        return;
      }

      if (msg.type === "set-file-permission" && client.isHost) {
        const targetUserId = msg.userId;
        const filePath = msg.filePath;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        if (typeof filePath !== "string" || !filePath) return;
        const permission = msg.permission;
        if (permission !== "read-write" && permission !== "read-only") return;
        setFilePermission(roomId, targetUserId, filePath, permission);
        for (const [clientWs, targetClient] of room.clients) {
          if (targetClient.userId === targetUserId) {
            sendTo(clientWs, {
              type: "file-permission-update",
              filePath,
              permission,
            });
          }
        }
        return;
      }

      if (msg.type === "host-transfer-offer" && client.isHost) {
        const targetUserId = msg.userId;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        const target = findClientByUserId(room, targetUserId);
        if (!target || !target.isApproved) return;
        room.pendingTransferTarget = targetUserId;
        sendTo(target.ws, {
          type: "host-transfer-offer",
          userId: client.userId,
          displayName: client.displayName,
        });
        return;
      }

      if (msg.type === "host-transfer-accept") {
        if (room.pendingTransferTarget !== client.userId) return;
        room.pendingTransferTarget = null;
        const targetUserId = msg.userId;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        const oldHost = findClientByUserId(room, targetUserId);
        if (!oldHost?.isHost) return;
        oldHost.isHost = false;
        client.isHost = true;
        if (client.verifiedUserId && serverRoom) {
          serverRoom.hostUserId = client.verifiedUserId;
          touchRoom(roomId);
        }
        appendLog(roomId, {
          timestamp: Date.now(),
          event: "host-transfer",
          userId: client.userId,
          displayName: client.displayName,
        });
        sendTo(client.ws, {
          type: "host-transfer-complete",
          userId: client.userId,
          displayName: client.displayName,
        });
        broadcast(
          room,
          JSON.stringify({
            type: "host-changed",
            userId: client.userId,
            displayName: client.displayName,
          }),
          client.ws,
        );
        return;
      }

      if (msg.type === "host-transfer-decline") {
        room.pendingTransferTarget = null;
        const targetUserId = msg.userId;
        if (typeof targetUserId !== "string" || !targetUserId) return;
        const oldHost = findClientByUserId(room, targetUserId);
        if (!oldHost) return;
        sendTo(oldHost.ws, {
          type: "host-transfer-decline",
          userId: client.userId,
          displayName: client.displayName,
        });
        return;
      }

      if (!client.isApproved) return;

      const isFileWrite =
        msg.type === "file-op" ||
        msg.type === "file-chunk-start" ||
        msg.type === "file-chunk-data" ||
        msg.type === "file-chunk-end";
      if (isFileWrite) {
        const filePath =
          msg.type === "file-op" && typeof msg.op === "object" && msg.op !== null
            ? ((msg.op as Record<string, unknown>).path ??
              (msg.op as Record<string, unknown>).newPath)
            : msg.path;
        const effectivePerm = getEffectivePermission(
          roomId,
          client.userId,
          typeof filePath === "string" ? filePath : undefined,
        );
        if ((effectivePerm ?? client.permission) === "read-only") {
          return;
        }
      }

      if (HOST_ONLY_TYPES.has(msg.type) && !client.isHost) {
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
          if (targetClient.userId === targetUserId) {
            safeSend(clientWs, strData);
          }
        }
        return;
      }

      if (msg.type === "presence-update") {
        if (typeof msg.userId === "string" && msg.userId && !client.userId) {
          client.userId = msg.userId.slice(0, 128);
          determineHostStatus(client, room, serverRoom);
        }
        if (typeof msg.displayName === "string") client.displayName = msg.displayName.slice(0, 100);
      }

      broadcast(room, data, ws);
    });

    ws.on("close", () => {
      const closingClient = room.clients.get(ws);
      const wasHost = closingClient?.isHost ?? false;
      if (closingClient) {
        room.pendingApprovals.delete(closingClient.userId);
        if (closingClient.userId) {
          clearPermission(roomId, closingClient.userId);
          clearUserFilePermissions(roomId, closingClient.userId);
          appendLog(roomId, {
            timestamp: Date.now(),
            event: "leave",
            userId: closingClient.userId,
            displayName: closingClient.displayName,
          });
          const leaveMsg = JSON.stringify({
            type: "presence-leave",
            userId: closingClient.userId,
          });
          broadcast(room, leaveMsg, ws);
        }
      }
      room.clients.delete(ws);
      if (wasHost && room.clients.size > 0) {
        for (const [pendingUserId, pendingWs] of room.pendingApprovals) {
          sendTo(pendingWs, { type: "join-response", approved: false });
        }
        room.pendingApprovals.clear();
        broadcast(room, JSON.stringify({ type: "host-disconnected" }));
      }
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
    for (const room of rooms.values()) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      for (const ws of room.clients.keys()) {
        ws.close(1000, "server shutting down");
      }
    }
    rooms.clear();
  }

  return { wss, closeAll };
}
