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
# {"ok":true,"uptime":1.0,"sessions":0,"documents":0,"clients":0}
```

## Development

```bash
npm run dev          # Auto-reload with tsx watch
npm test             # Run tests (vitest, 108 tests)
npm run lint         # Lint with Biome
npm run format       # Auto-fix formatting
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4321` | Server port (validated: 1-65535) |
| `SERVER_PASSWORD` | — | Require this password for all REST and WebSocket connections |
| `TLS_CERT` | — | Path to TLS certificate (enables HTTPS/WSS) |
| `TLS_KEY` | — | Path to TLS private key |
| `REQUIRE_GITHUB_AUTH` | `false` | Require GitHub OAuth for all connections |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app client secret |
| `JWT_SECRET` | — | Secret for signing JWTs (required when `REQUIRE_GITHUB_AUTH=true`) |
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
| `POST /rooms` | Create | Create a new room. Body: `{ hostUserId?, name?, requireApproval? }`. Returns `{ id, token, name }`. |
| `POST /rooms/:id/join` | Join | Join a room. Body: `{ token }`. Returns `{ id, name, wsUrl }`. |
| `GET /rooms/:id` | Info | Get room name and creation time |
| `DELETE /rooms/:id` | Delete | Delete a room. Header: `Authorization: Bearer <token>` |
| `GET /rooms/:id/logs` | Audit | Fetch audit log entries. Auth: `Authorization: Bearer <token>` or `?token=`. Optional `?limit=N` (default 100, max 500). |
| `GET /healthz` | Health | Server status, uptime, session/document/client counts |
| `GET /auth/github` | Auth | Start GitHub OAuth flow |
| `GET /auth/github/callback` | Auth | OAuth callback, returns JWT |

## WebSocket Endpoints

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `/ws-mux/:roomId` | Yjs binary (multiplexed) | Document sync and cursor awareness (stateless relay) |
| `/control/:roomId` | JSON | File ops, presence, session management |

Both require `?token=<room_token>` query parameter. When `SERVER_PASSWORD` is set, also requires `?password=<password>`. When GitHub auth is enabled, also requires `?jwt=<jwt_token>`.

## Persistence

Room metadata is persisted to LevelDB at `./data/yjs-docs`. The server does not persist document state — it operates as a stateless relay. The host's local vault is the single source of truth.

Rooms expire after 24 hours of inactivity. An hourly reaper deletes stale rooms from both memory and disk. Room activity timestamps are debounced (5-second window) to reduce disk writes.

In-memory cleanup timers reclaim control channel rooms 35 seconds after the last client disconnects, and document rooms 30 seconds after.

## Rate Limiting

- REST: 30 requests/min per IP on `/rooms`, 10 requests/min on `/auth`
- WebSocket: 100 messages per 10-second window per client. Exceeding the limit closes the connection with code 1008.

## Kick Protection

When a host kicks a user, the server records their user ID. If the kicked user attempts to rejoin, they are forced through the host approval flow regardless of the room's `requireApproval` setting. This is a one-time gate — once the host re-approves the user, they can rejoin freely if kicked again (until kicked again). If no host is connected when a kicked user tries to rejoin, the join is rejected.

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`: closes all WebSocket connections, then exits cleanly. A re-entrancy guard prevents double shutdown.

## Deployment

For production, ensure:

1. Set `JWT_SECRET` to a strong random value (the server warns at startup if unset, and exits if `REQUIRE_GITHUB_AUTH` is enabled without it)
2. Set `SERVER_PASSWORD` to restrict access to authorized clients
3. Enable TLS via `TLS_CERT`/`TLS_KEY` or run behind a reverse proxy (nginx, Caddy)
4. Use a process manager (systemd, pm2) to keep the server running
5. Back up the `./data/` directory for room persistence
