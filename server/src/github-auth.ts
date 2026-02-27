import { Router } from "express";
import jwt from "jsonwebtoken";

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface JWTPayload {
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

if (!process.env.JWT_SECRET) {
  if (process.env.REQUIRE_GITHUB_AUTH === "true") {
    console.error(
      "[config] REQUIRE_GITHUB_AUTH is true but JWT_SECRET is not set. " +
        "Set JWT_SECRET to a strong random value",
    );
    process.exit(1);
  } else {
    console.warn(
      "[config] JWT_SECRET is not set, using insecure default. " +
        "Set JWT_SECRET to a strong random value in production",
    );
  }
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

  router.get("/github", (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  router.get("/github/callback", async (req, res) => {
    try {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code) {
        res.status(400).send("Missing code");
        return;
      }

      let tokenResponse: Response;
      try {
        tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
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

      if (!tokenResponse.ok) {
        res.status(401).send("GitHub auth failed");
        return;
      }

      const { access_token } = (await tokenResponse.json()) as {
        access_token: string;
      };

      if (!access_token) {
        res.status(401).send("GitHub auth failed");
        return;
      }

      let userResponse: Response;
      try {
        userResponse = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${access_token}`,
            Accept: "application/vnd.github+json",
          },
        });
      } catch {
        res.status(502).send("Failed to fetch user info");
        return;
      }

      if (!userResponse.ok) {
        res.status(401).send("Failed to fetch user info");
        return;
      }

      const githubUser = (await userResponse.json()) as GitHubUser;
      const displayName = githubUser.name || githubUser.login;

      const payload: Omit<JWTPayload, "iat" | "exp"> = {
        sub: String(githubUser.id),
        username: githubUser.login,
        displayName,
        avatar: githubUser.avatar_url,
      };

      const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

      const safeName = displayName
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      const obsidianUri = `obsidian://live-share-auth?token=${encodeURIComponent(jwtToken)}`;
      let safeAvatar = "";
      try {
        const avatarUrl = new URL(githubUser.avatar_url);
        if (
          avatarUrl.protocol === "https:" &&
          avatarUrl.hostname.endsWith("githubusercontent.com")
        ) {
          safeAvatar = avatarUrl.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        }
      } catch {}
      res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Live Share - Authenticated</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#dcddde}
@media(prefers-color-scheme:light){body{background:#f6f6f6;color:#2e3338}.card{background:#fff;border-color:#e0e0e0}.token-input{background:#f0f0f0;border-color:#ddd;color:#2e3338}.fallback{color:#888}.copy-btn{background:#e8e8e8;color:#2e3338}.copy-btn:hover{background:#ddd}.close-msg{color:#888}}
.card{max-width:400px;width:100%;margin:24px;padding:36px 28px;background:#262626;border:1px solid #3a3a3a;border-radius:12px;text-align:center}
.avatar{width:72px;height:72px;border-radius:50%;margin:0 auto 16px;border:2px solid #7c3aed}
h1{font-size:18px;font-weight:600;margin-bottom:2px}
.subtitle{font-size:13px;color:#999;margin-bottom:24px}
.open-btn{display:inline-block;padding:10px 28px;background:#7c3aed;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;font-size:14px;transition:background .15s}
.open-btn:hover{background:#6d28d9}
.fallback{font-size:11px;color:#666;margin-top:24px;margin-bottom:8px}
.token-row{display:flex;gap:6px}
.token-input{flex:1;padding:6px 10px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#1e1e1e;border:1px solid #3a3a3a;border-radius:4px;color:#dcddde;outline:none;min-width:0}
.copy-btn{padding:6px 12px;background:#3a3a3a;color:#dcddde;border:none;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .15s}
.copy-btn:hover{background:#4a4a4a}
.check{color:#50c878}
.close-msg{margin-top:16px;font-size:13px;color:#999}
</style>
</head>
<body>
<div class="card">
  <img class="avatar" src="${safeAvatar}" alt="">
  <h1>${safeName}</h1>
  <p class="subtitle">Authenticated with GitHub</p>
  <a class="open-btn" id="open" href="${obsidianUri}">Open in Obsidian</a>
  <p class="fallback">If the button doesn't work, copy the token and paste it in Obsidian:</p>
  <div class="token-row">
    <input class="token-input" id="token" readonly value=${JSON.stringify(jwtToken)} onclick="this.select()">
    <button class="copy-btn" id="copy" onclick="navigator.clipboard.writeText(document.getElementById('token').value).then(()=>{document.getElementById('copy').innerHTML='<span class=check>Copied!</span>'})">Copy</button>
  </div>
</div>
</body></html>`);
    } catch (err) {
      console.error("[auth] failed to handle OAuth callback:", err);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  return router;
}
