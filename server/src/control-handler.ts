import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { getRoom } from "./rooms.js";

const ALLOWED_TYPES = new Set([
  "file-op",
  "presence-update",
  "follow-update",
  "session-end",
  "join-request",
  "join-response",
  "focus-request",
  "summon",
  "kick",
]);

interface ControlClient {
  ws: WebSocket;
  userId: string;
  displayName: string;
  isHost: boolean;
  approved: boolean;
  permission: "read-write" | "read-only";
}

interface ControlRoom {
  clients: Map<WebSocket, ControlClient>;
  pendingApprovals: Map<string, WebSocket>;
}

export function createControlWSS() {
  const rooms = new Map<string, ControlRoom>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1 * 1024 * 1024,
  });

  function getOrCreateRoom(roomId: string): ControlRoom {
    let room = rooms.get(roomId);
    if (!room) {
      room = { clients: new Map(), pendingApprovals: new Map() };
      rooms.set(roomId, room);
    }
    return room;
  }

  function broadcast(
    room: ControlRoom,
    data: Buffer | string,
    exclude?: WebSocket,
  ) {
    for (const [ws, client] of room.clients) {
      if (
        ws !== exclude &&
        client.approved &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(data);
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

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, roomId: string) => {
      const room = getOrCreateRoom(roomId);
      const serverRoom = getRoom(roomId);

      // Create client entry — will be populated by first message
      const client: ControlClient = {
        ws,
        userId: "",
        displayName: "",
        isHost: false,
        approved: true, // Default: approved (no approval required)
        permission: serverRoom?.defaultPermission || "read-write",
      };
      room.clients.set(ws, client);

      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
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

        // Handle join-request from guest
        if (msg.type === "join-request") {
          client.userId = (msg.userId as string) || "";
          client.displayName = (msg.displayName as string) || "";

          if (serverRoom?.requireApproval) {
            client.approved = false;
            room.pendingApprovals.set(client.userId, ws);

            // Forward to host for approval
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
            // Auto-approve
            client.approved = true;
            sendTo(ws, {
              type: "join-response",
              approved: true,
              permission: client.permission,
            });
          }
          return;
        }

        // Handle join-response from host
        if (msg.type === "join-response" && client.isHost) {
          const targetUserId = msg.userId as string;
          const targetWs = room.pendingApprovals.get(targetUserId);
          if (targetWs) {
            room.pendingApprovals.delete(targetUserId);
            const targetClient = room.clients.get(targetWs);
            if (targetClient) {
              targetClient.approved = msg.approved as boolean;
              if (msg.permission) {
                targetClient.permission = msg.permission as
                  | "read-write"
                  | "read-only";
              }
              sendTo(targetWs, {
                type: "join-response",
                approved: targetClient.approved,
                permission: targetClient.permission,
              });
            }
          }
          return;
        }

        // Handle kick from host
        if (msg.type === "kick" && client.isHost) {
          const targetUserId = msg.userId as string;
          for (const [clientWs, c] of room.clients) {
            if (c.userId === targetUserId) {
              sendTo(clientWs, { type: "kicked" });
              clientWs.close();
            }
          }
          return;
        }

        // Read-only clients can't send file ops
        if (msg.type === "file-op" && client.permission === "read-only") {
          return;
        }

        // Only broadcast from approved clients (except join-request handled above)
        if (!client.approved) return;

        // Handle summon — route to specific user or broadcast
        if (msg.type === "summon" && msg.targetUserId !== "__all__") {
          const targetUserId = msg.targetUserId as string;
          for (const [clientWs, c] of room.clients) {
            if (
              c.userId === targetUserId &&
              clientWs.readyState === WebSocket.OPEN
            ) {
              clientWs.send(data);
            }
          }
          return;
        }

        // Track identity from presence updates (isHost determined server-side)
        if (msg.type === "presence-update") {
          if (msg.userId) {
            if (!client.userId) {
              // Determine host status on first identification
              if (serverRoom?.hostUserId) {
                client.isHost = msg.userId === serverRoom.hostUserId;
              } else {
                // Fallback: first client to identify becomes host
                client.isHost = !findHost(room);
              }
            }
            client.userId = msg.userId as string;
          }
          if (msg.displayName) client.displayName = msg.displayName as string;
        }

        // Broadcast to all other approved clients
        broadcast(room, data, ws);
      });

      ws.on("close", () => {
        const closingClient = room.clients.get(ws);
        if (closingClient) {
          room.pendingApprovals.delete(closingClient.userId);
          // Notify remaining clients about departure
          if (closingClient.userId) {
            const leaveMsg = JSON.stringify({
              type: "presence-leave",
              userId: closingClient.userId,
            });
            broadcast(room, leaveMsg, ws);
          }
        }
        room.clients.delete(ws);
        if (room.clients.size === 0) {
          rooms.delete(roomId);
        }
      });
    },
  );

  return wss;
}
