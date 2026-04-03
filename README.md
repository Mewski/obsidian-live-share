# Obsidian Live Share

Real-time collaborative editing for [Obsidian](https://obsidian.md). Share your vault with others and edit together with live cursors, file sync, presence tracking, and end-to-end encryption.

## Quick Start

### 1. Start the Server

```bash
cd server && npm install && npm run build && npm start
```

Runs on `http://localhost:3000`. Verify: `curl http://localhost:3000/healthz`

### 2. Install the Plugin

Build from source:

```bash
cd plugin && npm install && npm run build
```

Copy into your vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-live-share
cp plugin/main.js plugin/styles.css manifest.json \
   /path/to/vault/.obsidian/plugins/obsidian-live-share/
```

Or install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) for automatic updates.

Enable **Live Share** in **Settings > Community Plugins**.

### 3. Configure

Open **Settings > Live Share** and set your **Server URL**, **Display name**, and **Shared folder** (leave empty for the whole vault).

### 4. Collaborate

**Host**: Run `Live Share: Start session` from the command palette. An invite link is copied to your clipboard.

**Guest**: Run `Live Share: Join session` and paste the invite link. Files sync automatically.

## Features

- **Real-time editing** - Yjs CRDT-powered character-level sync with live cursors and selections
- **File sync** - Creates, deletes, renames, and binary files sync automatically
- **End-to-end encryption** - AES-256-GCM with PBKDF2 key derivation; passphrase never leaves the invite link
- **Presence panel** - See who's connected, what file they're viewing, follow/summon/kick users
- **Permissions** - Host can set guests to read-write or read-only (enforced server-side), with per-file overrides
- **Guest approval** - Optionally require host approval before guests can join
- **Kick protection** - Kicked users must be re-approved by the host to rejoin, even when approval is not required
- **Host transfer** - Hand off the host role to another participant
- **Presentation mode** - Auto-broadcast your navigation to all participants
- **Canvas collaboration** - Real-time sync of `.canvas` files
- **Cross-platform support** - Windows filename character mapping for seamless sync between platforms
- **Offline queue** - File operations are buffered when disconnected and replayed on reconnect
- **Auto-reconnect** - Optionally rejoin the previous session on startup

## Commands

| Command | Description | Access |
|---------|-------------|--------|
| Start session | Create a room and start hosting | Anyone |
| Join session | Join via invite link | Anyone |
| End session | End the session for all participants | Host |
| Leave session | Leave the session | Guest |
| Copy invite link | Copy invite to clipboard | Anyone in session |
| Show collaborators panel | Open the presence sidebar | Anyone |
| Focus participants here | Send a "look here" notification | Anyone in session |
| Summon all participants here | Navigate all users to your cursor | Host |
| Summon a specific participant | Navigate one user to your cursor | Host |
| Reload all files from host | Re-download shared files | Guest |
| Toggle presentation mode | Auto-broadcast navigation | Host |
| Transfer host role | Offer host role to another user | Host |
| Set file permissions | Per-file read-only/read-write | Host |
| Show audit log | View session event log | Host |
| Log in with GitHub | GitHub OAuth authentication | Anyone |
| Log out | Clear stored authentication | Anyone |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://localhost:3000` | Your Live Share server address |
| Server password | - | Optional server password |
| Display name | `Anonymous` | Your name shown to collaborators |
| Cursor color | `#7c3aed` | Your cursor color in the editor |
| Shared folder | - | Subfolder to share (empty = whole vault) |
| Require approval | `false` | Require host approval for guests |
| Approval timeout | `60` | Auto-deny join requests after N seconds (0 = disabled) |
| Notifications | `true` | Toggle non-critical status notices |
| Auto-reconnect | `true` | Rejoin previous session on startup |
| Debug logging | `false` | Write debug logs to a vault file |
| Excluded patterns | - | Glob patterns for files to exclude from sync |

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SERVER_PASSWORD` | - | Restrict access to authorized clients |
| `TLS_CERT` / `TLS_KEY` | - | Enable HTTPS/WSS |
| `REQUIRE_GITHUB_AUTH` | `false` | Require GitHub OAuth |
| `GITHUB_CLIENT_ID` | - | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | - | GitHub OAuth client secret |
| `JWT_SECRET` | - | JWT signing secret (required with auth) |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |

## File Exclusion

Exclude files from sync by adding glob patterns in **Settings > Live Share > Excluded patterns**.

Default excludes: `.obsidian/**`, `.trash/**`.

Example patterns: `drafts/**`, `*.tmp`, `private/**`.

## How It Works

The system uses a stateless relay server and two WebSocket channels:

- **Yjs sync** (`/ws-mux/:roomId`) - Multiplexed binary channel for Yjs CRDT updates and cursor awareness per file
- **Control** (`/control/:roomId`) - JSON messages for file operations, presence, permissions, and session lifecycle

The host's vault is the source of truth. Text files sync character-by-character via Yjs. Binary files transfer as base64 with automatic chunking (up to 50 MB).

## Security

- E2E encryption (AES-256-GCM, PBKDF2 100k iterations) for file content in control messages
- Timing-safe token comparison on all auth checks
- Server-side enforcement of read-only permissions and host-only operations
- Path traversal protection, rate limiting, payload size limits
- Use TLS (`wss://`) to encrypt all traffic including Yjs sync data

See [docs/security.md](docs/security.md) for the full threat model.

## Development

```bash
# Server: 108 tests
cd server && npm run dev && npm test && npm run lint

# Plugin: 310 tests
cd plugin && npm run dev && npm test && npm run lint
```

## Disclosures

**Network use.** This plugin requires a relay server. All sync, file transfer, and presence data is sent over WebSocket connections to a server URL you configure. You can self-host the included server. File content can be end-to-end encrypted so the server cannot read it.

**Optional account.** GitHub OAuth login is available but not required. Without it, a local anonymous ID is generated.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
