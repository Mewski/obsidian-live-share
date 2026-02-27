# Architecture

## Overview

Obsidian Live Share has two parts: a **relay server** and an **Obsidian plugin**. The server relays Yjs CRDT updates and control messages between clients. The plugin integrates with Obsidian's CodeMirror 6 editor for real-time collaborative editing.

## Channels

Each session uses two WebSocket channels:

1. **Yjs sync** (`/ws-mux/:roomId`) — Multiplexed binary channel for Yjs CRDT updates and cursor awareness. One Y.Doc per file, keyed as `roomId:filePath`. The manifest doc is at `roomId:__manifest__`. The server is a stateless relay. Read-only enforcement peeks at sync message types server-side.

2. **Control** (`/control/:roomId`) — JSON messages for file operations, presence, permissions, follow/summon, guest approval, kick, ping/pong, and session lifecycle.

## Data Flow

1. Host starts a session via `POST /rooms`
2. Host publishes a manifest (file list with hashes) to a shared Y.Map
3. Guest joins via invite link, receives the manifest, pulls text files via per-file Yjs docs. Binary files are requested via `sync-request` and delivered as chunked file operations.
4. Both open the same file: Yjs syncs content character-by-character
5. File creates/deletes/renames broadcast via control channel with per-path suppression to prevent echo
6. Presence (current file, scroll position, cursor) broadcasts via debounced control messages

## Server Components

| Component | File | Responsibility |
|-----------|------|----------------|
| REST API | `rooms.ts` | Room CRUD, join validation, token auth |
| Yjs handler | `ws-handler.ts` | Stateless message relay, read-only enforcement |
| Control handler | `control-handler.ts` | Message routing, host determination, rate limiting, permission enforcement, kick tracking |
| Persistence | `persistence.ts` | LevelDB storage for room metadata |
| Permissions | `permissions.ts` | Per-user permission store |
| Auth | `github-auth.ts` | GitHub OAuth flow, JWT signing/verification |
| Audit log | `audit-log.ts` | Append-only event log per room |
| Entry | `index.ts` | HTTP/HTTPS server, WebSocket upgrade routing, graceful shutdown |

## Plugin Components

| Component | Directory | Responsibility |
|-----------|-----------|----------------|
| Entry point | `main.ts` | Session lifecycle, vault events, ribbon menu, protocol handlers |
| `sync/` | Networking | SyncManager (Yjs mux), ControlChannel (JSON WS), E2E crypto, connection state, offline queue |
| `editor/` | CM6 | CollabManager (yCollab integration), conflict decoration |
| `files/` | File sync | BackgroundSync (Yjs observers + disk writes), FileOpsManager (remote ops), ManifestManager, CanvasSync, ExclusionManager |
| `session/` | Session | SessionManager, PresenceManager, PresenceView, AuthManager, command registration |
| `ui/` | Modals | Settings, approval modal, audit modal, file permission modal, ignore modal, focus notification, explorer indicators |

## Key Design Decisions

- **One Y.Doc per file**: Each shared text file gets its own Y.Doc synced through the relay.
- **Stateless relay**: Server forwards messages without maintaining document state. The host's vault is the source of truth.
- **Per-path suppression**: Ref-counted suppression prevents vault events from echoing remote operations.
- **Server-side host determination**: JWT-verified identity preferred; fallback: first connected client.
- **Minimal Y.Text updates**: Only the differing portion is replaced (prefix/suffix preserved) to avoid CRDT artifacts.
- **Background sync**: Non-active text files sync via Y.Text observers with debounced disk writes. The active file syncs through yCollab in the editor.
- **Cross-platform paths**: Canonical ASCII paths on the wire, fullwidth Unicode substitution for Windows-forbidden characters at the filesystem boundary.
- **Kick protection**: The server tracks kicked user IDs per room. Kicked users must be re-approved by the host on rejoin, even when `requireApproval` is false.

## Control Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `file-op` | Bidirectional | File create/modify/delete/rename |
| `file-chunk-start` | Bidirectional | Begin chunked file transfer |
| `file-chunk-data` | Bidirectional | Chunk payload |
| `file-chunk-end` | Bidirectional | End chunked file transfer |
| `file-chunk-resume` | Bidirectional | Resume interrupted transfer |
| `presence-update` | Client -> All | Current file, scroll, cursor |
| `presence-leave` | Server -> All | User disconnected |
| `focus-request` | Client -> All | "Look here" notification |
| `summon` | Host -> Target(s) | Navigate user to host's cursor |
| `join-request` / `join-response` | Guest <-> Host | Approval flow |
| `kick` / `kicked` | Host -> Server -> Guest | Remove participant |
| `set-permission` / `permission-update` | Host -> Server -> Guest | Global permission changes |
| `set-file-permission` / `file-permission-update` | Host -> Server -> Guest | Per-file permission changes |
| `session-end` | Host -> All | Session ended |
| `sync-request` | Guest -> Host | Request file resync |
| `present-start` / `present-stop` | Host -> All | Presentation mode toggle |
| `host-transfer-offer` | Host -> Target | Offer host role |
| `host-transfer-accept` / `host-transfer-decline` | Target -> Host | Accept/decline host transfer |
| `host-changed` | Server -> All | New host notification |
| `host-disconnected` | Server -> All | Host disconnected notification |
| `ping` / `pong` | Client <-> Server | Latency measurement |
