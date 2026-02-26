# Obsidian Live Share

Real-time collaborative editing for [Obsidian](https://obsidian.md). Share your vault with others and edit together with live cursors, file sync, presence tracking, and end-to-end encryption.

## Features

- **Real-time collaborative editing**: Yjs CRDT-powered character-level sync with automatic conflict resolution
- **Live cursors and selections**: See collaborators' cursors and selections in the editor
- **File sync**: Creates, deletes, renames, and binary files are synced automatically
- **End-to-end encryption**: File content is encrypted client-side with AES-256-GCM (PBKDF2 key derivation)
- **Presence panel**: See who's connected, what file they're viewing, and their cursor position
- **Follow mode**: Follow a user's navigation and scroll position; auto-unfollows on interaction
- **Presentation mode**: Host broadcasts navigation to all participants automatically
- **Focus and summon**: Request attention or navigate specific participants to your location
- **Host-only controls**: Summon, kick, permission changes, presentation mode, and session end are host-only (enforced server-side)
- **Guest approval**: Optionally require host approval with read-write, read-only, or deny
- **Mid-session permission changes**: Host can toggle any guest between read-write and read-only at any time via the presence panel
- **Read-only enforcement**: Read-only guests are blocked from editing server-side on both Yjs and control channels
- **Confirmation dialogs**: End session and kick actions ask for confirmation before proceeding
- **Host disconnect notice**: Guests are notified when the host leaves the session
- **Reload from host**: Guests can re-download all files from the host
- **File exclusion**: Configure `.liveshare.json` to exclude files from sharing
- **Latency monitoring**: Ping/pong latency shown in the status bar
- **Notification control**: Toggle non-critical status notices on or off in settings
- **Debug logging**: Optional timestamped debug log written to a file in your vault
- **Auto-reconnect**: Optionally rejoin the previous session automatically when Obsidian starts
- **Join via link**: Open `obsidian://live-share?invite=...` links to join sessions directly
- **Ribbon context menu**: Right-click the collaborators icon for quick access to session actions
- **Session actions in settings**: Start, join, end, or leave sessions directly from the settings tab
- **Fail-fast connections**: Connection drops immediately end the session and clean up all resources

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Obsidian 1.11.0+

### 1. Start the Server

```bash
cd server
npm install
npm run build
npm start
```

The server starts on `http://localhost:4321`. Verify with `curl http://localhost:4321/healthz`.

### 2. Install the Plugin

```bash
cd plugin
npm install
npm run build
```

Copy the built files into your vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-live-share
cp plugin/main.js plugin/manifest.json plugin/styles.css \
   /path/to/vault/.obsidian/plugins/obsidian-live-share/
```

Open Obsidian, go to **Settings > Community Plugins**, and enable **Live Share**.

### 3. Configure

Open **Settings > Live Share** and set:

- **Server URL**: `http://localhost:4321` (or your deployed server URL)
- **Display name**: Your name shown to collaborators (defaults to "Anonymous" if blank)
- **Cursor color**: Pick your cursor color using the color picker
- **Shared folder**: Subfolder to share (leave empty for the whole vault)
- **Require approval**: Require host approval for guests to join (off by default)
- **Notifications**: Toggle non-critical status notices (on by default)
- **Auto-reconnect**: Automatically rejoin the previous session on startup (on by default)
- **Debug logging**: Write timestamped debug logs to a file in your vault (off by default)

### 4. Start Collaborating

**Host:**
1. Open the command palette and run **Live Share: Start session**
2. An invite link is automatically copied to your clipboard
3. Share the invite link with collaborators

**Guest:**
1. Open the command palette and run **Live Share: Join session**
2. Paste the invite link
3. Files sync automatically from the host

## Commands

| Command | Description | Access |
|---------|-------------|--------|
| Start session | Create a room and start hosting | Anyone |
| Join session | Join via invite link | Anyone |
| End session | Disconnect from the session (asks for confirmation) | Host broadcasts end to all |
| Copy invite link | Copy invite link to clipboard | Anyone in session |
| Show collaborators panel | Open the presence sidebar | Anyone |
| Focus participants here | Send "look here" request to all | Anyone |
| Summon all participants here | Navigate all participants to your cursor | Host only |
| Summon a specific participant here | Pick a user and navigate them to your cursor | Host only |
| Reload all files from host | Re-download all shared files | Guest only |
| Toggle presentation mode | Auto-broadcast navigation to all participants | Host only |
| Log in with GitHub | Authenticate via GitHub OAuth | Anyone |
| Log out | Clear stored authentication | Anyone |

## File Exclusion

Create `.liveshare.json` in your vault root:

```json
{
  "exclude": ["drafts/**", "*.tmp", "private/**"]
}
```

Default excludes: `.obsidian/**`, `.liveshare.json`, `.trash/**`.

## How It Works

Obsidian Live Share uses a stateless relay server and two WebSocket channels per session:

- **Yjs sync** (`/ws-mux/:roomId`): Multiplexed binary channel carrying Yjs CRDT updates and cursor awareness for all shared files. The server forwards messages between peers without maintaining any document state. Read-only enforcement is handled by peeking at sync message types.
- **Control** (`/control/:roomId`): JSON messages for file operations, presence, follow/summon, session lifecycle, and ping/pong latency measurement.

The host's local vault is the single source of truth. Text files sync character-by-character via Yjs. Binary files (images, PDFs, etc.) are transferred as base64 via the control channel with automatic chunking for files up to 50 MB.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4321` | Server port (1-65535) |
| `SERVER_PASSWORD` | - | Require this password for all REST and WebSocket connections |
| `TLS_CERT` | - | Path to TLS certificate (enables HTTPS/WSS) |
| `TLS_KEY` | - | Path to TLS private key |
| `REQUIRE_GITHUB_AUTH` | `false` | Require GitHub OAuth for all connections |
| `GITHUB_CLIENT_ID` | - | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | - | GitHub OAuth app client secret |
| `JWT_SECRET` | - | Secret for signing JWTs (required when auth is enabled) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |

See [Server Setup](docs/server.md) for TLS, OAuth, persistence, and deployment details.

## Development

```bash
# Server
cd server
npm run dev          # Dev server with auto-reload
npm test             # 79 tests
npm run lint         # Biome linter

# Plugin
cd plugin
npm run dev          # Watch mode (esbuild)
npm test             # 268 tests
npm run lint         # Biome linter
```

## Security

- **E2E encryption**: AES-256-GCM with PBKDF2 (100k iterations). Passphrase is in the invite link, never sent to the server.
- **Timing-safe token comparison** on all room token checks
- **Path traversal protection**: `..`, `.`, and absolute paths are rejected
- **Server-side enforcement**: read-only permissions, host-only summon/kick/set-permission/session-end, message type whitelist
- **Rate limiting**: REST (30 req/min), WebSocket (100 msg/10s), auth (10 req/min)
- **Payload limits**: Yjs 10 MB, control 2 MB

See [Security](docs/security.md) for the full threat model.

## Documentation

- [Architecture](docs/architecture.md): System design, protocols, and data flow
- [Server Setup](docs/server.md): Installation, configuration, and deployment
- [Plugin Usage](docs/plugin.md): Commands, features, and configuration
- [Security](docs/security.md): Encryption, authentication, and threat model

## Disclosures

**Network use.** This plugin requires a relay server to function. All real-time sync, file transfer, and presence data is sent over WebSocket connections to a server URL you configure in settings (default: `localhost:4321`). You can self-host the included server or use a shared instance. File content can optionally be end-to-end encrypted (AES-256-GCM) so the server cannot read it; see the [Security](#security) section. GitHub avatar images are loaded over HTTPS when GitHub authentication is used.

**Optional account.** GitHub OAuth login is available but not required. Without it, the plugin generates a local anonymous ID. When enabled, the server must be configured with GitHub OAuth credentials, and authentication is handled via your browser. The resulting JWT token is stored locally in plugin settings.

## Known Limitations

- **No offline merge**: File-level operations (create/delete/rename) don't have conflict resolution across separate sessions. Text content merges automatically via Yjs within a session.
- **Single host**: If the host disconnects, the session ends for all participants.
- **E2E scope**: File content in control messages is end-to-end encrypted. Yjs sync data is relayed as opaque binary by the server (no server-side processing or persistence), but the data itself is not encrypted at the application layer. Use TLS (`wss://`) to encrypt all traffic in transit.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
