import { Router } from "express";
import jwt from "jsonwebtoken";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface JWTPayload {
  sub: string;
  username: string;
  displayName: string;
  avatar: string | null;
  iat: number;
  exp: number;
}

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

if (!process.env.JWT_SECRET && process.env.REQUIRE_GITHUB_AUTH === "true") {
  console.error(
    "FATAL: REQUIRE_GITHUB_AUTH is true but JWT_SECRET is not set. " +
      "Set JWT_SECRET to a strong random value.",
  );
  process.exit(1);
}

export function verifyJWT(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

export function createAuthRouter(): Router {
  const router = Router();

  // Step 1: Redirect to GitHub
  router.get("/github", (req, res) => {
    const state = (req.query.state as string) || "";
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // Step 2: GitHub callback
  router.get("/github/callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Missing code");
      return;
    }

    // Exchange code for access token
    let tokenRes: Response;
    try {
      tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });
    } catch {
      res.status(502).send("Failed to contact GitHub");
      return;
    }

    if (!tokenRes.ok) {
      res.status(401).send("GitHub auth failed");
      return;
    }

    const { access_token } = (await tokenRes.json()) as {
      access_token: string;
    };

    if (!access_token) {
      res.status(401).send("GitHub auth failed");
      return;
    }

    // Fetch user info
    let userRes: Response;
    try {
      userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/vnd.github+json",
        },
      });
    } catch {
      res.status(502).send("Failed to fetch user info");
      return;
    }

    if (!userRes.ok) {
      res.status(401).send("Failed to fetch user info");
      return;
    }

    const ghUser = (await userRes.json()) as GitHubUser;
    const displayName = ghUser.name || ghUser.login;

    // Create JWT
    const payload: Omit<JWTPayload, "iat" | "exp"> = {
      sub: String(ghUser.id),
      username: ghUser.login,
      displayName,
      avatar: ghUser.avatar_url,
    };

    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    // Escape for safe HTML interpolation
    const safeName = displayName
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    // Return a page that shows the token and tries to open Obsidian
    res.send(`<!DOCTYPE html>
<html><head><title>Live Share Auth</title></head>
<body style="font-family:system-ui;max-width:500px;margin:60px auto;text-align:center">
  <h2>Authenticated as ${safeName}</h2>
  <p>Copy this token and paste it into Obsidian:</p>
  <input id="token" readonly style="width:100%;padding:8px;font-size:14px;margin:12px 0" onclick="this.select()">
  <button onclick="navigator.clipboard.writeText(document.getElementById('token').value)" style="padding:8px 16px;cursor:pointer">Copy Token</button>
  <p style="color:#666;font-size:13px;margin-top:24px">You can close this window after copying.</p>
  <script>
    document.getElementById('token').value = ${JSON.stringify(jwtToken)};
    window.location = 'obsidian://live-share-auth?token=' + encodeURIComponent(${JSON.stringify(jwtToken)});
  </script>
</body></html>`);
  });

  return router;
}
