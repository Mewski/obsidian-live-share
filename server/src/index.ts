import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";

import { closeAuditLog, getLogs, initAuditLog } from "./audit-log.js";
import { createControlWSS } from "./control-handler.js";
import { createAuthRouter, verifyJWT } from "./github-auth.js";
import { type Persistence, getDefaultPersistence } from "./persistence.js";
import { getRoom, initRooms, reapStaleRooms, roomRouter } from "./rooms.js";
import { safeTokenCompare } from "./util.js";
import { createYjsWSS } from "./ws-handler.js";

const REQUIRE_GITHUB_AUTH = process.env.REQUIRE_GITHUB_AUTH === "true";
const SERVER_PASSWORD = process.env.SERVER_PASSWORD || "";

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
  if (SERVER_PASSWORD) {
    app.use("/rooms", (req, res, next) => {
      const provided = req.headers["x-server-password"];
      if (typeof provided !== "string" || !safeTokenCompare(provided, SERVER_PASSWORD)) {
        res.status(401).json({ error: "invalid server password" });
        return;
      }
      next();
    });
  }
  app.use("/rooms", limiter, roomRouter);
  app.use("/auth", authLimiter, createAuthRouter());

  const server = externalServer ?? createServer(app);

  const yjs = createYjsWSS();
  const control = createControlWSS({
    onPermissionChange: (roomId, userId, permission) => {
      yjs.updatePermission(roomId, userId, permission);
    },
  });

  app.get("/healthz", (_req, res) => {
    const stats = yjs.getStats();
    res.json({
      ok: true,
      uptime: process.uptime(),
      sessions: stats.sessions,
      documents: stats.documents,
      clients: stats.clients,
    });
  });

  app.get("/rooms/:id/logs", async (req, res) => {
    const room = getRoom(req.params.id);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    const token = req.query.token;
    if (typeof token !== "string" || !safeTokenCompare(token, room.token)) {
      res.status(403).json({ error: "invalid token" });
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const entries = await getLogs(req.params.id, limit);
    res.json(entries);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    if (SERVER_PASSWORD) {
      const provided = url.searchParams.get("password");
      if (!provided || !safeTokenCompare(provided, SERVER_PASSWORD)) {
        socket.destroy();
        return;
      }
    }

    function authenticateUpgrade(url: URL, roomId: string): boolean {
      const room = getRoom(roomId);
      const token = url.searchParams.get("token");
      if (!room || !token || !safeTokenCompare(token, room.token)) return false;
      if (REQUIRE_GITHUB_AUTH) {
        const jwtToken = url.searchParams.get("jwt");
        if (!jwtToken || !verifyJWT(jwtToken)) return false;
      }
      return true;
    }

    const muxMatch = url.pathname.match(/^\/ws-mux\/(.+)$/);
    if (muxMatch) {
      const baseRoomId = muxMatch[1];
      if (!authenticateUpgrade(url, baseRoomId)) {
        socket.destroy();
        return;
      }
      yjs.muxWss.handleUpgrade(req, socket, head, (ws) => {
        yjs.muxWss.emit("connection", ws, req, baseRoomId);
      });
      return;
    }

    const ctrlMatch = url.pathname.match(/^\/control\/(.+)$/);
    if (ctrlMatch) {
      const roomId = ctrlMatch[1];
      if (!authenticateUpgrade(url, roomId)) {
        socket.destroy();
        return;
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
      reapStaleRooms().catch((err) => console.error("[rooms] failed to reap stale rooms:", err));
    },
    60 * 60 * 1000,
  );

  async function shutdown() {
    console.info("[server] shutting down gracefully...");
    clearInterval(reaperInterval);
    control.closeAll();
    yjs.closeAll();
    await closeAuditLog();
    if (persistence) await persistence.close();
    server.close();
  }

  return { app, server, shutdown };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const persistence = getDefaultPersistence();
  initAuditLog();
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
        const appSetup = createApp(persistence, tlsServer);
        tlsServer.on("request", appSetup.app);
        server = tlsServer;
        shutdown = appSetup.shutdown;
      } else {
        const appSetup = createApp(persistence);
        server = appSetup.server;
        shutdown = appSetup.shutdown;
      }

      const port = Number.parseInt(process.env.PORT || "4321");
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(`[server] invalid PORT: ${process.env.PORT}`);
        process.exit(1);
      }
      server.listen(port, () => {
        console.info(`[server] listening on :${port}`);
      });

      let isShuttingDown = false;
      const onSignal = () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        shutdown()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error("[server] failed to shut down:", err);
            process.exit(1);
          });
      };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
    })
    .catch((err) => {
      console.error("[server] failed to start:", err);
      process.exit(1);
    });
}
