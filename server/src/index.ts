import express from "express";
import cors from "cors";
import { createServer, Server } from "http";
import { readFileSync } from "fs";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
import { createYjsWSS } from "./ws-handler.js";
import { createControlWSS } from "./control-handler.js";
import { roomRouter, initRooms, getRoom } from "./rooms.js";
import { type Persistence, getDefaultPersistence } from "./persistence.js";
import { createAuthRouter, verifyJWT } from "./github-auth.js";

const REQUIRE_GITHUB_AUTH = process.env.REQUIRE_GITHUB_AUTH === "true";

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createApp(
  persistence?: Persistence,
  externalServer?: Server,
): {
  app: express.Express;
  server: Server;
} {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
  });
  app.use("/rooms", limiter, roomRouter);
  app.use("/auth", createAuthRouter());

  const server = externalServer ?? createServer(app);

  const yjsWss = createYjsWSS(persistence);
  const controlWss = createControlWSS();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Route: /ws/<roomName> → Yjs WSS
    const wsMatch = url.pathname.match(/^\/ws\/(.+)$/);
    if (wsMatch) {
      const fullRoomName = wsMatch[1];
      const baseRoomId = fullRoomName.split(":")[0];
      const room = getRoom(baseRoomId);
      if (!room) {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get("token");
      if (!token || !safeTokenCompare(token, room.token)) {
        socket.destroy();
        return;
      }

      // Optional JWT auth
      if (REQUIRE_GITHUB_AUTH) {
        const jwtToken = url.searchParams.get("jwt");
        if (!jwtToken || !verifyJWT(jwtToken)) {
          socket.destroy();
          return;
        }
      }

      yjsWss.handleUpgrade(req, socket, head, (ws) => {
        yjsWss.emit("connection", ws, req, fullRoomName);
      });
      return;
    }

    // Route: /control/<roomId> → Control WSS
    const ctrlMatch = url.pathname.match(/^\/control\/(.+)$/);
    if (ctrlMatch) {
      const roomId = ctrlMatch[1];
      const room = getRoom(roomId);
      if (!room) {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get("token");
      if (!token || !safeTokenCompare(token, room.token)) {
        socket.destroy();
        return;
      }

      if (REQUIRE_GITHUB_AUTH) {
        const jwtToken = url.searchParams.get("jwt");
        if (!jwtToken || !verifyJWT(jwtToken)) {
          socket.destroy();
          return;
        }
      }

      controlWss.handleUpgrade(req, socket, head, (ws) => {
        controlWss.emit("connection", ws, req, roomId);
      });
      return;
    }

    socket.destroy();
  });

  return { app, server };
}

// Only auto-start when run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/index.ts") ||
    process.argv[1].endsWith("/index.js"));

if (isMain) {
  const persistence = getDefaultPersistence();
  initRooms(persistence).then(async () => {
    const TLS_CERT = process.env.TLS_CERT;
    const TLS_KEY = process.env.TLS_KEY;

    let server: Server;
    if (TLS_CERT && TLS_KEY) {
      const https = await import("https");
      const tlsServer = https.createServer({
        cert: readFileSync(TLS_CERT),
        key: readFileSync(TLS_KEY),
      });
      const { app } = createApp(persistence, tlsServer);
      tlsServer.on("request", app);
      server = tlsServer;
    } else {
      ({ server } = createApp(persistence));
    }

    const port = parseInt(process.env.PORT || "4321");
    server.listen(port, () => {
      console.log(`live-share server on :${port}`);
    });
  });
}
