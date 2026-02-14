# Obsidian Live Share

Real-time collaborative editing for [Obsidian](https://obsidian.md). Share your vault with others and edit together with live cursors, file sync, presence tracking, and session management.

## How It Works

Obsidian Live Share consists of two parts: a **relay server** and an **Obsidian plugin**.

The server acts as a relay between connected clients. It does not read or interpret your notes — it stores Yjs document state so clients can sync, and forwards control messages between participants.

The plugin integrates with Obsidian's editor (CodeMirror 6) to provide real-time collaborative editing via [Yjs](https://yjs.dev), a CRDT-based framework. When two people edit the same file, their changes are merged automatically without conflicts.

### Architecture

```
                      Server
                    +--------+
                    |        |
  Client A ------->| Yjs WS |<------- Client B
  (host)     ws:// | binary  |  ws://  (guest)
                    |        |
  Client A ------->| Control |<------- Client B
             ws:// | JSON    |  ws://
                    +--------+
```

**Two WebSocket channels per session:**

1. **Yjs sync channel** (`/ws/:roomId`) — Binary Yjs protocol for document sync and awareness (cursors). One Y.Doc per file, keyed as `roomId:filePath`. The manifest doc (file inventory) lives at `roomId:__manifest__`.

2. **Control channel** (`/control/:roomId`) — JSON messages for everything else: file operations (create/delete/rename), presence updates, follow mode, focus/summon requests, guest approval, kick, and session lifecycle.

**Data flow:**
- Host starts a session, creating a room on the server
- Host's plugin scans the vault and publishes a manifest (file list with hashes)
- Guest joins via invite link, receives the manifest, and pulls files
- Both open the same file: Yjs syncs the document content in real-time
- File creates/deletes/renames are broadcast via the control channel
- Presence (who's online, what file they're viewing) is broadcast via the control channel

## Server Setup

### Requirements

- Node.js 18+
- npm

### Install and Run

```bash
cd server
npm install
npm run dev    # Development with auto-reload
npm run build  # Compile TypeScript
npm start      # Run compiled server
```

The server starts on port `4321` by default.

### Environment Variables

Create a `.env` file (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4321` | Server port |
| `TLS_CERT` | — | Path to TLS certificate (enables HTTPS) |
| `TLS_KEY` | — | Path to TLS private key |
| `REQUIRE_GITHUB_AUTH` | `false` | Require GitHub OAuth for connections |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app client secret |
| `JWT_SECRET` | — | Secret for signing JWTs (required when auth enabled) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |

### Health Check

`GET /healthz` returns server status:

```json
{ "ok": true, "uptime": 3600, "rooms": 2, "connections": 5 }
```

### TLS

To enable HTTPS, set both `TLS_CERT` and `TLS_KEY` to file paths. WebSocket connections will automatically use `wss://`.

### GitHub OAuth (Optional)

For authenticated sessions:

1. Create a [GitHub OAuth App](https://github.com/settings/developers)
2. Set the callback URL to `https://your-server/auth/github/callback`
3. Set `REQUIRE_GITHUB_AUTH=true`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `JWT_SECRET` in your environment
4. Users authenticate in Obsidian via the "Log in with GitHub" command

When auth is disabled (default), anyone with a room token can connect. Room tokens are random 24-character strings generated at room creation and shared via invite links.

### Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`:
1. Notifies all connected WebSocket clients
2. Persists all in-memory Y.Docs to LevelDB
3. Closes the database
4. Exits cleanly

This means you can safely restart the server without losing data.

### Persistence

All Y.Doc state and room metadata is persisted to LevelDB (stored in `./data/yjs-docs` by default). Documents are also persisted on a 5-second debounce after every edit, so a crash loses at most 5 seconds of work.

## Plugin Installation

### Manual Install

1. Build the plugin:
   ```bash
   cd plugin
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-live-share/` folder
3. Enable "Live Share" in Obsidian's Community Plugins settings

### Configuration

Open Settings > Live Share:

- **Server URL** — The URL of your Live Share server (e.g. `http://localhost:4321`)
- **Display name** — Your name shown to collaborators
- **Cursor color** — Your cursor color visible to others (hex format)
- **Shared folder** — Subfolder to share (empty = whole vault)

## Usage

### Starting a Session (Host)

1. Run the command **Live Share: Start session**
2. Enter a session name
3. An invite link is automatically copied to your clipboard
4. Share the invite link with collaborators

### Joining a Session (Guest)

1. Run the command **Live Share: Join session**
2. Paste the invite link
3. Files from the host's vault will sync to your vault

### During a Session

- **Live cursors** — See other participants' cursors and selections in real-time
- **File sync** — File creates, deletes, and renames are synced automatically
- **Presence panel** — Click the status bar or run **Show collaborators panel** to see who's connected and what file they're viewing
- **Follow mode** — Click "Follow" next to a user to follow their file navigation and scroll position. Any interaction (typing, clicking, scrolling) automatically unfollows.
- **Focus** — Run **Focus participants here** to send your current cursor location as a notification to all participants
- **Summon** — Run **Summon all participants here** to navigate all participants to your location
- **End session** — Run **Live Share: End session** to disconnect. If you're the host, guests will be notified and disconnected.

### Guest Approval (Optional)

When the server's room has `requireApproval` set, guests must be approved by the host:

1. Guest connects and sends a join request
2. Host sees an approval modal with options: Approve (Read-Write), Approve (Read-Only), or Deny
3. Read-only guests can view files and see cursors but cannot edit

### Kick

Hosts can remove a participant by clicking "Kick" in the presence panel.

## File Exclusion

Create a `.liveshare.json` file in your vault root to exclude files from sharing:

```json
{
  "exclude": ["drafts/**", "*.tmp", "private/**"]
}
```

**Default excludes** (always applied):
- `.obsidian/**`
- `.liveshare.json`
- `.trash/**`

Patterns use glob syntax via [minimatch](https://github.com/isaacs/minimatch).

**Note:** Only text files are shared. Binary files (images, PDFs, etc.) are automatically excluded. Supported extensions include: `.md`, `.txt`, `.json`, `.css`, `.js`, `.ts`, `.html`, `.xml`, `.yaml`, `.yml`, `.csv`, `.svg`, `.canvas`, and many more programming languages.

## Security Model

- **Room tokens** — Each room has a random 24-character token. Only clients with the correct token can connect. Tokens are compared using timing-safe comparison to prevent timing attacks.
- **GitHub OAuth** (optional) — When enabled, connections also require a valid JWT. JWTs are signed with `JWT_SECRET` and expire after 7 days.
- **Path validation** — All inbound file operations are validated to prevent path traversal attacks. Paths with `..`, `.`, or absolute paths are rejected.
- **Avatar URL validation** — Only `https:` URLs are rendered as avatar images.
- **Cursor color validation** — Only hex color values are accepted.
- **Read-only enforcement** — Read-only guests are enforced server-side. The server drops file operation messages and Yjs write messages from read-only clients.
- **File deletion safety** — Remote file deletions move files to Obsidian's trash instead of permanently deleting them.
- **Message validation** — The control channel only accepts whitelisted message types. Unknown types are silently dropped.
- **Rate limiting** — REST endpoints are rate-limited to 30 requests per minute per IP.
- **Payload limits** — Yjs WebSocket: 10 MB max payload. Control WebSocket: 1 MB max payload.

## Commands

| Command | Description |
|---|---|
| Start session | Create a room and start hosting |
| Join session | Join an existing session via invite link |
| End session | Disconnect from the current session |
| Copy invite link | Copy the invite link to clipboard |
| Show collaborators panel | Open the presence sidebar |
| Log in with GitHub | Authenticate via GitHub OAuth |
| Log out | Clear stored authentication |
| Focus participants here | Send your cursor location to all participants |
| Summon all participants here | Navigate all participants to your location |

## Development

```bash
# Server
cd server
npm install
npm run dev          # Dev server with auto-reload
npm test             # Run tests
npm run lint         # Lint with Biome

# Plugin
cd plugin
npm install
npm run dev          # Watch mode (rebuilds on change)
npm test             # Run tests
npm run lint         # Lint with Biome
```

## Known Limitations

- **Text files only** — Binary files (images, PDFs, etc.) are not synced. Yjs operates on text, so binary content would be corrupted.
- **No offline merge** — If you edit while disconnected, changes may conflict when you reconnect. Yjs handles most merges automatically, but file-level operations (create/delete/rename) don't have conflict resolution.
- **No partial sync** — The entire shared folder is synced. You can't selectively share individual files (use the shared folder or exclusion patterns instead).
- **Single host** — Only one user can be the host. If the host disconnects, the session ends for all participants.
- **Memory usage** — Each open file creates a Y.Doc in memory on both client and server. Very large vaults with many simultaneously edited files will use more memory.
- **No end-to-end encryption** — Content is visible to the relay server. Run your own server for sensitive content.

## License

MIT
