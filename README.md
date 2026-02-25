# Obsidian Live Share

Real-time collaborative editing for [Obsidian](https://obsidian.md). Share your vault with others and edit together with live cursors, file sync, presence tracking, and end-to-end encryption.

## How It Works

Obsidian Live Share consists of a **relay server** and an **Obsidian plugin**. The server relays [Yjs](https://yjs.dev) CRDT updates and control messages between clients. The plugin integrates with Obsidian's editor (CodeMirror 6) for real-time collaborative editing — changes are merged automatically without conflicts.

Each session uses two WebSocket channels:
- **Yjs sync** (`/ws/:roomId`) — Binary CRDT protocol for document sync and live cursors
- **Control** (`/control/:roomId`) — JSON messages for file operations, presence, follow mode, and session management

See [Architecture](docs/architecture.md) for details.

## Quick Start

### Server

```bash
cd server
npm install
npm run build
npm start        # Starts on port 4321
```

See [Server Setup](docs/server.md) for configuration, TLS, GitHub OAuth, and deployment.

### Plugin

1. Build: `cd plugin && npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/obsidian-live-share/`
3. Enable "Live Share" in Obsidian settings

See [Plugin Usage](docs/plugin.md) for commands, features, and configuration.

## Features

- **Live cursors** — See collaborators' cursors and selections in real-time
- **File sync** — Creates, deletes, and renames are synced automatically
- **End-to-end encryption** — File content is encrypted client-side with AES-256-GCM
- **Presence tracking** — See who's connected and what file they're viewing
- **Follow mode** — Follow a user's navigation and scroll position
- **Guest approval** — Optionally require host approval (read-write, read-only, or deny)
- **File exclusion** — Configure `.liveshare.json` to exclude files from sharing

See [Security](docs/security.md) for the encryption model, defenses, and threat model.

## Development

```bash
# Server
cd server
npm run dev          # Dev server with auto-reload
npm test             # Run tests
npm run lint         # Lint with Biome

# Plugin
cd plugin
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # Lint with Biome
```

## Known Limitations

- **No offline merge** — File-level operations (create/delete/rename) don't have conflict resolution when reconnecting after offline edits
- **Single host** — If the host disconnects, the session ends
- **E2E covers file transfers, not real-time sync** — File content transferred via the control channel is end-to-end encrypted. Real-time CRDT sync data is processed by the server (same model as VS Code Live Share). Use TLS (`wss://`) in production.

## Documentation

- [Architecture](docs/architecture.md) — System design, protocols, and data flow
- [Server Setup](docs/server.md) — Installation, configuration, and deployment
- [Plugin Usage](docs/plugin.md) — Installation, commands, and features
- [Security](docs/security.md) — Encryption, authentication, and threat model

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
