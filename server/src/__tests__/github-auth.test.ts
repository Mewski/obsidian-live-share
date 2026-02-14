import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import express from "express";
import { Server } from "http";
import { verifyJWT, createAuthRouter } from "../github-auth.js";

const DEFAULT_SECRET = "change-me-in-production";

describe("verifyJWT", () => {
  it("returns payload for a valid token", () => {
    const token = jwt.sign(
      {
        sub: "123456",
        username: "testuser",
        displayName: "Test User",
        avatar: "https://avatars.githubusercontent.com/u/123456",
      },
      DEFAULT_SECRET,
      { expiresIn: "1h" },
    );

    const payload = verifyJWT(token);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("123456");
    expect(payload!.username).toBe("testuser");
    expect(payload!.displayName).toBe("Test User");
    expect(payload!.avatar).toBe(
      "https://avatars.githubusercontent.com/u/123456",
    );
    expect(payload!.iat).toBeTypeOf("number");
    expect(payload!.exp).toBeTypeOf("number");
  });

  it("returns null for an expired token", () => {
    const token = jwt.sign(
      {
        sub: "123456",
        username: "testuser",
        displayName: "Test User",
        avatar: null,
      },
      DEFAULT_SECRET,
      { expiresIn: "-1s" },
    );

    expect(verifyJWT(token)).toBeNull();
  });

  it("returns null for a token signed with the wrong secret", () => {
    const token = jwt.sign(
      {
        sub: "123456",
        username: "testuser",
        displayName: "Test User",
        avatar: null,
      },
      "wrong-secret",
      { expiresIn: "1h" },
    );

    expect(verifyJWT(token)).toBeNull();
  });

  it("returns null for a garbage string", () => {
    expect(verifyJWT("not.a.valid.jwt.at.all")).toBeNull();
  });
});

describe("createAuthRouter", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
    app.use("/auth", createAuthRouter());
    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server.on("listening", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(() => {
    server.close();
  });

  it("GET /github redirects to GitHub OAuth2", async () => {
    const res = await fetch(`http://localhost:${port}/auth/github`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
  });

  it("GET /github/callback without code returns 400", async () => {
    const res = await fetch(`http://localhost:${port}/auth/github/callback`);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe("Missing code");
  });
});
