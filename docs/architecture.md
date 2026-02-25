# Architecture

## Overview

Obsidian Live Share is a two-part system: a **relay server** and an **Obsidian plugin**. The server relays Yjs CRDT updates and control messages between connected clients. The plugin integrates with Obsidian's CodeMirror 6 editor to provide real-time collaborative editing.

## Channels

Each session uses two WebSocket channels:

1. **Yjs sync channel** (`/ws/:roomId`) -- Binary Yjs protocol for document sync and awareness (cursors). One Y.Doc per file, keyed as `roomId:filePath`. The manifest doc (file inventory) is at `roomId:__manifest__`.

2. **Control channel** (`/control/:roomId`) -- JSON messages for file operations (create/delete/rename), presence updates, follow mode, focus/summon requests, guest approval, kick, and session lifecycle.

## Data Flow

1. Host starts a session, creating a room on the server
2. Host's plugin scans the vault and publishes a manifest (file list with hashes)
3. Guest joins via invite link, receives the manifest, and pulls files
4. Both open the same file: Yjs syncs the document content in real-time
5. File creates/deletes/renames are broadcast via the control channel
6. Presence (who's online, what file they're viewing) is broadcast via the control channel

## Key Design Decisions

- **One Y.Doc per file** -- Keeps memory bounded; only open files are live
- **Hub-and-spoke topology** -- All clients connect to the central server, no peer-to-peer
- **Yjs CRDT** -- Character-level conflict-free merging without coordination
- **LevelDB persistence** -- Server persists Y.Doc state with 5-second debounce after edits
- **Forward-slash path normalization** -- All file paths are normalized to `/` separators for cross-platform compatibility (Windows/Linux/macOS)
