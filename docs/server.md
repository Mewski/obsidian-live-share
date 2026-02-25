# Server Setup

## Requirements

- Node.js 18+
- npm

## Install and Run

```bash
cd server
npm install
npm run build
npm start
```

The server starts on port `4321` by default. Verify it's running:

```bash
curl http://localhost:4321/healthz
# {"ok":true,"uptime":1.0,"rooms":0,"connections":0}
```

## Development

```bash
npm run dev          # Auto-reload with tsx watch
npm test             # Run tests (vitest)
npm run lint         # Lint with Biome
npm run format       # Auto-fix formatting
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4321` | Server port |
| `TLS_CERT` | - | Path to TLS certificate (enables HTTPS/WSS) |
| `TLS_KEY` | - | Path to TLS private key |
| `REQUIRE_GITHUB_AUTH` | `false` | Require GitHub OAuth for all connections |
| `GITHUB_CLIENT_ID` | - | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | - | GitHub OAuth app client secret |
| `JWT_SECRET` | - | Secret for signing JWTs (required when `REQUIRE_GITHUB_AUTH=true`) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |

## TLS

Set both `TLS_CERT` and `TLS_KEY` to enable HTTPS. WebSocket connections automatically use `wss://`. Example:

```bash
TLS_CERT=/path/to/cert.pem TLS_KEY=/path/to/key.pem npm start
```

## GitHub OAuth (Optional)

1. Create a [GitHub OAuth App](https://github.com/settings/developers)
2. Set the authorization callback URL to `https://your-server/auth/github/callback`
3. Configure the server:
   ```bash
   REQUIRE_GITHUB_AUTH=true
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   JWT_SECRET=a-strong-random-secret
   ```
4. Users authenticate in Obsidian via the **Log in with GitHub** command

When auth is disabled (default), anyone with a room token can connect.

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /rooms` | Create | Create a new room. Body: `{ "hostUserId": "...", "requireApproval": false }`. A random room name is auto-generated. |
| `POST /rooms/:id/join` | Join | Join a room. Body: `{ "token": "..." }` |
| `GET /rooms/:id` | Info | Get room name and creation time |
| `DELETE /rooms/:id` | Delete | Delete a room. Header: `Authorization: Bearer <token>` |
| `GET /healthz` | Health | Server status, uptime, room/connection counts |
| `GET /auth/github` | Auth | Start GitHub OAuth flow |
| `GET /auth/github/callback` | Auth | OAuth callback, returns JWT |

## WebSocket Endpoints

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `/ws/:roomId` | Yjs binary | Document sync and cursor awareness |
| `/control/:roomId` | JSON | File ops, presence, session management |

Both require `?token=<room_token>` query parameter. When GitHub auth is enabled, also requires `&jwt=<jwt_token>`.

## Persistence

Y.Doc state and room metadata are persisted to LevelDB at `./data/yjs-docs`. Documents are persisted on a 5-second debounce after every edit. Rooms are cleaned up from memory after the last client disconnects (30 seconds for Yjs state, 35 seconds for the control channel). Persisted data is retained.

## Rate Limiting

- REST: 30 requests/min per IP on `/rooms`, 10 requests/min on `/auth`
- WebSocket: 100 messages per 10-second window per client. Exceeding the limit closes the connection with code 1008.

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`: persists all Y.Docs to LevelDB, closes all WebSocket connections, then exits cleanly. A re-entrancy guard prevents double shutdown.

## Deployment

For production, ensure:

1. Set `JWT_SECRET` to a strong random value
2. Enable TLS via `TLS_CERT`/`TLS_KEY` or run behind a reverse proxy (nginx, Caddy)
3. Use a process manager (systemd, pm2) to keep the server running
4. Back up the `./data/` directory for persistence
