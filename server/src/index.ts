import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { createControlWSS } from "./control-handler.js";
import { createAuthRouter, verifyJWT } from "./github-auth.js";
import { type Persistence, getDefaultPersistence } from "./persistence.js";
import { getRoom, initRooms, reapStaleRooms, roomRouter } from "./rooms.js";
import { safeTokenCompare } from "./util.js";
import { createYjsWSS } from "./ws-handler.js";

const REQUIRE_GITHUB_AUTH = process.env.REQUIRE_GITHUB_AUTH === "true";

export function createApp(
  persistence?: Persistence,
  externalServer?: Server,
): {
  app: express.Express;
  server: Server;
  shutdown: () => Promise<void>;
} {
  const corsOrigin = process.env.CORS_ORIGIN || "*";
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
  });
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
  });
  app.use("/rooms", limiter, roomRouter);
  app.use("/auth", authLimiter, createAuthRouter());

  const server = externalServer ?? createServer(app);

  const yjs = createYjsWSS(persistence);
  const control = createControlWSS();

  app.get("/healthz", (_req, res) => {
    const stats = yjs.getStats();
    res.json({
      ok: true,
      uptime: process.uptime(),
      rooms: stats.rooms,
      connections: stats.connections,
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

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

      if (REQUIRE_GITHUB_AUTH) {
        const jwtToken = url.searchParams.get("jwt");
        if (!jwtToken || !verifyJWT(jwtToken)) {
          socket.destroy();
          return;
        }
      }

      yjs.wss.handleUpgrade(req, socket, head, (ws) => {
        yjs.wss.emit("connection", ws, req, fullRoomName);
      });
      return;
    }

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

      control.wss.handleUpgrade(req, socket, head, (ws) => {
        control.wss.emit("connection", ws, req, roomId);
      });
      return;
    }

    socket.destroy();
  });

  const reaperInterval = setInterval(
    () => {
      reapStaleRooms().catch((err) => console.error("reaper error:", err));
    },
    60 * 60 * 1000,
  );

  async function shutdown() {
    console.log("shutting down gracefully...");
    clearInterval(reaperInterval);
    control.closeAll();
    await yjs.closeAllRooms();
    if (persistence) await persistence.close();
    server.close();
  }

  return { app, server, shutdown };
}

// Only auto-start when run directly (works on all platforms including Windows)
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const persistence = getDefaultPersistence();
  initRooms(persistence)
    .then(async () => {
      const TLS_CERT = process.env.TLS_CERT;
      const TLS_KEY = process.env.TLS_KEY;

      let server: Server;
      let shutdown: () => Promise<void>;
      if (TLS_CERT && TLS_KEY) {
        const https = await import("node:https");
        const tlsServer = https.createServer({
          cert: readFileSync(TLS_CERT),
          key: readFileSync(TLS_KEY),
        });
        const result = createApp(persistence, tlsServer);
        tlsServer.on("request", result.app);
        server = tlsServer;
        shutdown = result.shutdown;
      } else {
        const result = createApp(persistence);
        server = result.server;
        shutdown = result.shutdown;
      }

      const port = Number.parseInt(process.env.PORT || "4321");
      server.listen(port, () => {
        console.log(`live-share server on :${port}`);
      });

      let shuttingDown = false;
      const onSignal = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        shutdown()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error("error during shutdown:", err);
            process.exit(1);
          });
      };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
    })
    .catch((err) => {
      console.error("failed to start server:", err);
      process.exit(1);
    });
}
