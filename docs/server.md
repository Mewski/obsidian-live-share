# Server Setup

## Requirements

- Node.js 18+
- npm

## Install and Run

```bash
cd server
npm install
npm run dev    # Development with auto-reload
npm run build  # Compile TypeScript
npm start      # Run compiled server
```

The server starts on port `4321` by default.

## Environment Variables

Create a `.env` file (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4321` | Server port |
| `TLS_CERT` | -- | Path to TLS certificate (enables HTTPS) |
| `TLS_KEY` | -- | Path to TLS private key |
| `REQUIRE_GITHUB_AUTH` | `false` | Require GitHub OAuth for connections |
| `GITHUB_CLIENT_ID` | -- | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | -- | GitHub OAuth app client secret |
| `JWT_SECRET` | -- | Secret for signing JWTs (required when auth enabled) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |

## Health Check

`GET /healthz` returns server status:

```json
{ "ok": true, "uptime": 3600, "rooms": 2, "connections": 5 }
```

## TLS

Set both `TLS_CERT` and `TLS_KEY` to enable HTTPS. WebSocket connections will automatically use `wss://`.

## GitHub OAuth (Optional)

1. Create a [GitHub OAuth App](https://github.com/settings/developers)
2. Set the callback URL to `https://your-server/auth/github/callback`
3. Set `REQUIRE_GITHUB_AUTH=true`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `JWT_SECRET`
4. Users authenticate in Obsidian via the "Log in with GitHub" command

When auth is disabled (default), anyone with a room token can connect.

## Persistence

Y.Doc state and room metadata are persisted to LevelDB (`./data/yjs-docs`). Documents are persisted on a 5-second debounce after every edit.

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`: persists all Y.Docs to LevelDB, notifies clients, then exits cleanly.
