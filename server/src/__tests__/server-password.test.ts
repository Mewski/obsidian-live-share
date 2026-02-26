import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

let server: Server<typeof IncomingMessage, typeof ServerResponse>;
let port: number;
let shutdown: () => Promise<void>;
let openSockets: WebSocket[] = [];

function listen(s: Server<typeof IncomingMessage, typeof ServerResponse>): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, () => {
      const addr = s.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function expectWsReject(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    ws.on("open", () => reject(new Error("expected connection to be rejected")));
    ws.on("error", () => resolve());
    ws.on("close", () => resolve());
  });
}

async function setup(password?: string) {
  if (password) {
    process.env.SERVER_PASSWORD = password;
  } else {
    process.env.SERVER_PASSWORD = "";
  }
  vi.resetModules();
  const { createApp } = await import("../index.js");
  const { noopPersistence } = await import("../persistence.js");
  const app = createApp(noopPersistence);
  server = app.server;
  shutdown = app.shutdown;
  port = await listen(server);
}

async function cleanup() {
  for (const ws of openSockets) ws.close();
  openSockets = [];
  await shutdown();
  process.env.SERVER_PASSWORD = "";
}

describe("server password (no password set)", () => {
  beforeEach(() => setup());
  afterEach(cleanup);

  it("allows room creation without password", async () => {
    const res = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("server password (password set)", () => {
  const PASSWORD = "s3cret-test-pw";

  beforeEach(() => setup(PASSWORD));
  afterEach(cleanup);

  it("rejects room creation without password header", async () => {
    const res = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("invalid server password");
  });

  it("rejects room creation with wrong password", async () => {
    const res = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Password": "wrong",
      },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("allows room creation with correct password", async () => {
    const res = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Password": PASSWORD,
      },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(201);
  });

  it("allows healthz without password", async () => {
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("rejects WebSocket upgrade without password", async () => {
    const createRes = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Password": PASSWORD,
      },
      body: JSON.stringify({ name: "ws-test" }),
    });
    const room = (await createRes.json()) as { id: string; token: string };

    await expectWsReject(`ws://localhost:${port}/control/${room.id}?token=${room.token}`);
  });

  it("allows WebSocket upgrade with correct password", async () => {
    const createRes = await fetch(`http://localhost:${port}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Password": PASSWORD,
      },
      body: JSON.stringify({ name: "ws-test" }),
    });
    const room = (await createRes.json()) as { id: string; token: string };

    const ws = await connectWs(
      `ws://localhost:${port}/control/${room.id}?token=${room.token}&password=${PASSWORD}`,
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
