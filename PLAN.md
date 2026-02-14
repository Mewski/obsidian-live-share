# Obsidian Live Share

Real-time collaborative editing for Obsidian with live cursors.

## Problem

Existing collaboration plugins for Obsidian are either paid/closed-source (Peerdraft, Relay), pre-alpha with data loss risks (obsidian-multiplayer), or lack real-time cursor presence. None of them feel right.

## Approach

**Yjs-backed hub-and-spoke sync with live cursors.**

- **Yjs** (CRDT) handles real-time document sync and conflict-free merging
- **y-codemirror.next** binds Yjs to Obsidian's CodeMirror 6 editor — gives us live cursors, selections, and awareness out of the box
- **y-websocket** provides the WebSocket transport between clients and the central server
- **Manual conflict resolution** when offline edits diverge beyond what Yjs can auto-merge

Two packages:
1. **`server/`** — Node.js relay server (hosts Yjs docs, persists state)
2. **`plugin/`** — Obsidian plugin (connects to server, injects CM6 collab extensions)

## Architecture

```
┌─────────────┐                           ┌─────────────────┐
│  Obsidian   │      WebSocket            │   Live Share    │
│  Plugin A   │◄─────────────────────────►│   Server        │
│             │   Yjs sync + awareness    │                 │
└─────────────┘                           │  y-websocket    │
                                          │  persistence    │
┌─────────────┐      WebSocket            │  room mgmt     │
│  Obsidian   │◄─────────────────────────►│  auth           │
│  Plugin B   │                           └─────────────────┘
└─────────────┘
```

### How it works

Each shared file maps to a Yjs document (`Y.Doc`) with a `Y.Text` inside. When a user opens a shared file:

1. Plugin creates/joins the Yjs doc for that file via WebSocket
2. `y-codemirror.next` binds the `Y.Text` to the CodeMirror 6 editor instance
3. Edits propagate through Yjs → WebSocket → server → other clients
4. Awareness protocol shows each user's cursor position and selection in real-time

Files not currently open are synced at the document level — the server persists Yjs state and clients sync on file open.

### Server (`server/`)

Thin wrapper around `y-websocket-server` with room management and auth.

**Responsibilities:**
- Host Yjs WebSocket endpoint (one room per shared file or vault)
- Persist Yjs document state to disk (LevelDB or flat files)
- Room creation with shareable join tokens
- Basic token auth on WebSocket connect

**Tech:**
- Node.js + `ws`
- `y-websocket` server utilities (or custom handler using `yjs` + `lib0`)
- LevelDB for Yjs state persistence
- Express for the REST endpoints (room management)

**Endpoints:**
```
POST   /rooms              — create room, returns {roomId, token}
POST   /rooms/:id/join     — validate token, return connection info
GET    /rooms/:id          — room metadata (connected users, file count)
WS     /ws/:roomId         — Yjs WebSocket sync + awareness
```

### Plugin (`plugin/`)

Obsidian plugin that injects collaborative editing into the editor.

**Core mechanism:**
- `registerEditorExtension()` to inject `yCollab()` from `y-codemirror.next` into every editor
- `WebsocketProvider` from `y-websocket` to connect to the server
- One `Y.Doc` per file — keyed by relative vault path
- Awareness configured with user name + color for cursor rendering

**Responsibilities:**
- Settings UI: server URL, room ID, display name, cursor color
- Connect/disconnect commands
- Status bar: connection state, active collaborators count
- Vault-level sync: detect file create/delete/rename and propagate to Yjs
- Conflict modal: when Yjs can't auto-merge (rare but possible with long offline periods)

**Key Obsidian APIs used:**
- `Plugin.registerEditorExtension(extension)` — inject CM6 collab extension
- `Vault.on('create'|'modify'|'delete'|'rename')` — track file-level changes
- `Plugin.addCommand()` — connect/disconnect/create room commands
- `Plugin.addSettingTab()` — configuration UI
- `Plugin.addStatusBarItem()` — connection indicator

## Sync Strategy

### Online (real-time)
All edits flow through Yjs. No explicit save/push cycle — changes propagate on keystroke. Cursors update via the awareness protocol.

### Reconnection
When a client reconnects after being offline, `y-websocket` handles state sync automatically — Yjs exchanges state vectors and sends only the missing updates.

### File-level operations
File creates, deletes, and renames don't go through CM6. These are handled separately:
- Plugin watches Vault events and sends file-level operations as custom messages on the WebSocket
- Server broadcasts these to other clients
- Receiving clients create/delete/rename files locally via Vault API

### Conflict resolution
Yjs auto-merges concurrent edits at the character level. True conflicts (where intent is ambiguous) are rare. When they occur:
- Surface a modal showing both versions
- User picks or manually edits the result
- Result is written back to the Yjs doc

## Project Structure

```
obsidian-live-share/
├── server/
│   ├── src/
│   │   ├── index.ts          — startup, wire up HTTP + WS
│   │   ├── rooms.ts          — create/join/list rooms, token gen
│   │   ├── persistence.ts    — Yjs doc persistence (LevelDB)
│   │   ├── ws-handler.ts     — Yjs WebSocket message handling
│   │   └── auth.ts           — token validation middleware
│   ├── package.json
│   └── tsconfig.json
├── plugin/
│   ├── src/
│   │   ├── main.ts           — onload/onunload, command + extension registration
│   │   ├── settings.ts       — settings tab
│   │   ├── sync.ts           — Yjs doc management, provider lifecycle
│   │   ├── collab.ts         — CM6 extension builder (yCollab + awareness)
│   │   ├── file-ops.ts       — file create/delete/rename propagation
│   │   ├── conflict-modal.ts — manual merge UI
│   │   └── types.ts          — shared types
│   ├── manifest.json
│   ├── styles.css
│   ├── package.json
│   ├── tsconfig.json
│   └── esbuild.config.mjs
├── PLAN.md
└── README.md
```

## Implementation Phases

### Phase 1: Scaffold
- [ ] Plugin from obsidian-sample-plugin template
- [ ] Server with y-websocket + express
- [ ] Plugin settings tab (server URL, display name, cursor color)
- [ ] Server room endpoints (create, join)

### Phase 2: Real-time editing
- [ ] Plugin: Y.Doc per file, WebsocketProvider connection
- [ ] Plugin: yCollab CM6 extension via registerEditorExtension
- [ ] Live cursors + selections via awareness
- [ ] Server: Yjs state persistence (LevelDB)
- [ ] Connect/disconnect commands + status bar

### Phase 3: File operations
- [ ] Propagate file create/delete/rename over WebSocket
- [ ] Receiving clients apply file-level changes via Vault API
- [ ] Handle edge cases (rename while someone else has file open)

### Phase 4: Conflict handling + polish
- [ ] Conflict detection + resolution modal
- [ ] Reconnection resilience
- [ ] Ignore patterns (configurable)
- [ ] User presence panel (who's online, what file they're in)
- [ ] Error notifications

## Decisions

- **Desktop only for v1.** Mobile Obsidian has restrictions that make this harder.
- **One Y.Doc per file**, not per vault. Keeps memory bounded — only open files are live.
- **y-websocket over custom protocol.** Battle-tested, handles sync vectors and awareness. No need to reinvent.
- **LevelDB for persistence.** Simple, embedded, fast. Upgradable to Postgres/Redis later if needed.
- **No git.** Yjs handles the hard sync problems. Git adds complexity without helping real-time collaboration.
