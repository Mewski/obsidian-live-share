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
      const safeAvatar = githubUser.avatar_url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Live Share Auth</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e2e;color:#cdd6f4}
@media(prefers-color-scheme:light){body{background:#eff1f5;color:#4c4f69}.card{background:#fff;border-color:#ccd0da}.token-input{background:#e6e9ef;border-color:#ccd0da;color:#4c4f69}.fallback{color:#6c6f85}.copy-btn{background:#313244;color:#cdd6f4}.copy-btn:hover{background:#45475a}}
.card{max-width:420px;width:100%;margin:24px;padding:40px 32px;background:#313244;border:1px solid #45475a;border-radius:16px;text-align:center}
.avatar{width:80px;height:80px;border-radius:50%;margin:0 auto 20px;border:3px solid #7c3aed}
h1{font-size:20px;font-weight:600;margin-bottom:4px}
.username{font-size:14px;color:#a6adc8;margin-bottom:28px}
.open-btn{display:inline-block;padding:12px 32px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;transition:background .15s}
.open-btn:hover{background:#6d28d9}
.fallback{font-size:12px;color:#6c7086;margin-top:28px;margin-bottom:10px}
.token-row{display:flex;gap:8px}
.token-input{flex:1;padding:8px 12px;font-size:13px;font-family:monospace;background:#1e1e2e;border:1px solid #45475a;border-radius:6px;color:#cdd6f4;outline:none;min-width:0}
.copy-btn{padding:8px 14px;background:#45475a;color:#cdd6f4;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;transition:background .15s}
.copy-btn:hover{background:#585b70}
.check{color:#a6e3a1}
</style>
</head>
<body>
<div class="card">
  <img class="avatar" src="${safeAvatar}" alt="">
  <h1>${safeName}</h1>
  <p class="username">Signed in with GitHub</p>
  <a class="open-btn" href="${obsidianUri}">Open in Obsidian</a>
  <p class="fallback">If the button doesn't work, copy the token and paste it in Obsidian:</p>
  <div class="token-row">
    <input class="token-input" id="token" readonly value=${JSON.stringify(jwtToken)} onclick="this.select()">
    <button class="copy-btn" id="copy" onclick="navigator.clipboard.writeText(document.getElementById('token').value).then(()=>{document.getElementById('copy').innerHTML='<span class=check>Copied!</span>'})">Copy</button>
  </div>
</div>
<script>
setTimeout(()=>{
  location.href=${JSON.stringify(obsidianUri)};
  setTimeout(()=>{
    document.querySelector('.open-btn').textContent='Redirected!';
    document.querySelector('.card').insertAdjacentHTML('beforeend',
      '<p style="margin-top:20px;font-size:14px;color:#a6adc8">You can close this tab.</p>');
    try{window.close()}catch{}
  },500);
},300);
</script>
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
