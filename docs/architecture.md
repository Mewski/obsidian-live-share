# Architecture

## Overview

Obsidian Live Share is a two-part system: a **relay server** and an **Obsidian plugin**. The server relays Yjs CRDT updates and control messages between connected clients. The plugin integrates with Obsidian's CodeMirror 6 editor to provide real-time collaborative editing.

## Channels

Each session uses two WebSocket channels:

1. **Yjs sync channel** (`/ws/:roomId`) -- Binary Yjs protocol for document sync and awareness (cursors). One Y.Doc per file, keyed as `roomId:filePath`. The manifest doc (file inventory) is at `roomId:__manifest__`.

2. **Control channel** (`/control/:roomId`) -- JSON messages for file operations (create/delete/rename/modify), presence updates, follow mode, focus/summon requests, guest approval, kick, ping/pong latency, and session lifecycle.

## Data Flow

1. Host starts a session, creating a room on the server via `POST /rooms`
2. Host's plugin scans the vault and publishes a manifest (file list with hashes) to a shared Y.Map
3. Guest joins via invite link, receives the manifest, and pulls files via per-file Yjs docs
4. Both open the same file: Yjs syncs document content character-by-character in real-time
5. File creates/deletes/renames are broadcast via the control channel with per-path suppression to prevent echo
6. Presence (who's online, current file, scroll position, cursor line) is broadcast via debounced control messages
7. Binary files are transferred as base64 via the control channel, automatically chunked for files over 512 KB

## Server Components

| Component | File | Responsibility |
|-----------|------|----------------|
| REST API | `rooms.ts` | Room CRUD, join validation, token-based auth |
| Yjs handler | `ws-handler.ts` | Yjs sync protocol, awareness relay, per-doc persistence |
| Control handler | `control-handler.ts` | Message routing, host determination, rate limiting, permission enforcement |
| Persistence | `persistence.ts` | LevelDB storage for Y.Docs and room metadata |
| Auth | `github-auth.ts` | GitHub OAuth flow, JWT signing/verification |
| Entry | `index.ts` | HTTP/HTTPS server, WebSocket upgrade routing, graceful shutdown |

## Plugin Components

| Component | File | Responsibility |
|-----------|------|----------------|
| Main plugin | `main.ts` | Commands, vault event handlers, session lifecycle, presentation mode |
| Control channel | `control-ws.ts` | WebSocket client with reconnect, send queue, ping/pong latency |
| File operations | `file-ops.ts` | Remote op application, per-path suppression, chunked transfer |
| Collaboration | `collab.ts` | CodeMirror 6 Yjs integration, per-file activation |
| Sync manager | `sync.ts` | Per-file Y.Doc and WebsocketProvider management |
| Manifest | `manifest.ts` | File inventory sync via shared Y.Map, hash-based change detection |
| Presence view | `presence-view.ts` | Sidebar panel showing users, follow/kick/summon buttons |
| Connection state | `connection-state.ts` | State machine for connection lifecycle |
| Crypto | `crypto.ts` | AES-256-GCM encryption with PBKDF2 key derivation |
| Session | `session.ts` | Room creation/join, invite link encoding/parsing |
| Settings | `settings.ts` | Plugin settings UI |
| Auth | `auth.ts` | GitHub OAuth token handling |
| Exclusion | `exclusion.ts` | File exclusion patterns from `.liveshare.json` |

## Key Design Decisions

- **Yjs CRDT** -- Character-level conflict-free merging without coordination. Battle-tested with CodeMirror 6 via `y-codemirror.next`.
- **One Y.Doc per file** -- Keeps memory bounded; only open files have active sync providers.
- **Hub-and-spoke topology** -- All clients connect to the central relay server. No peer-to-peer.
- **Per-path suppression** -- Ref-counted suppression map prevents vault events from echoing remote operations back to the server. Uses 50ms delayed unsuppress to handle async vault event firing.
- **Host determination** -- Server-side, not client-side. JWT-verified identity is preferred; fallback: first client to send `presence-update` becomes host.
- **LevelDB persistence** -- Server persists Y.Doc state with 5-second debounce after edits. Rooms are cleaned up 30 seconds after the last client disconnects.
- **Forward-slash path normalization** -- All file paths are normalized to `/` separators for cross-platform compatibility.
- **Send queue with presence dedup** -- Messages sent while disconnected are queued and flushed on reconnect. Queued presence updates are deduplicated (only the latest is kept).

## Control Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `file-op` | Bidirectional | File create/modify/delete/rename |
| `file-chunk-start/data/end` | Bidirectional | Chunked binary file transfer |
| `presence-update` | Client -> All | Current file, scroll position, cursor line |
| `presence-leave` | Server -> All | User disconnected |
| `focus-request` | Client -> All | "Look here" notification |
| `summon` | Host -> Target(s) | Navigate user(s) to host's cursor |
| `join-request` | Guest -> Host | Request to join (when approval required) |
| `join-response` | Host -> Guest | Approve/deny with permission level |
| `kick` / `kicked` | Host -> Guest | Remove participant |
| `session-end` | Host -> All | Host ended the session |
| `sync-request` | Guest -> Host | Request full file resync |
| `sync-response` | Host -> Guest | Full file content in response to sync-request |
| `follow-update` | Client -> All | Follow/unfollow state change |
| `ping` / `pong` | Client <-> Server | Latency measurement (30s interval) |
