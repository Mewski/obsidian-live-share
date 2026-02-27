# Plugin Usage

## Installation

### From Source

```bash
cd plugin && npm install && npm run build
```

Copy into your vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-live-share
cp main.js styles.css /path/to/vault/.obsidian/plugins/obsidian-live-share/
cp manifest.json /path/to/vault/.obsidian/plugins/obsidian-live-share/
```

Enable **Live Share** in **Settings > Community Plugins**.

### Via BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), add this repository, and enable the plugin.

## Settings

Open **Settings > Live Share**:

### Connection

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://localhost:3000` | URL of your Live Share server |
| Server password | — | Optional password if the server requires one |

### Identity

| Setting | Default | Description |
|---------|---------|-------------|
| Display name | `Anonymous` | Your name shown to collaborators |
| Cursor color | `#7c3aed` | Your cursor and selection color in the editor |

### Session

| Setting | Default | Description |
|---------|---------|-------------|
| Shared folder | — | Restrict sharing to a subfolder (empty = whole vault) |
| Require approval | `false` | Require host approval before guests can join |
| Approval timeout | `60` seconds | Auto-deny pending join requests after this duration (0 = no timeout) |

### Preferences

| Setting | Default | Description |
|---------|---------|-------------|
| Notifications | `true` | Show non-critical status notices |
| Auto-reconnect | `true` | Rejoin the previous session automatically on startup |

### Debug

| Setting | Default | Description |
|---------|---------|-------------|
| Debug logging | `false` | Write verbose debug logs to a file in the vault |
| Debug log path | `live-share-debug.md` | File path for debug output |

### Advanced

| Setting | Description |
|---------|-------------|
| Excluded patterns | Glob patterns for files to exclude from sync (e.g. `drafts/**`, `*.tmp`) |

When a session is active, the settings page also shows connection state, room ID, encryption status, and session actions.

## Commands

All commands are in the command palette (Ctrl/Cmd+P, type "Live Share").

| Command | Description | Access |
|---------|-------------|--------|
| Start session | Create a room and start hosting | Anyone |
| Join session | Paste an invite link to join | Anyone |
| End session | End the session for all participants | Host |
| Leave session | Leave the session | Guest |
| Copy invite link | Copy invite to clipboard | Anyone in session |
| Show collaborators panel | Open the presence sidebar | Anyone |
| Focus participants here | Send "look here" to all participants | Anyone in session |
| Summon all participants here | Navigate everyone to your cursor position | Host |
| Summon a specific participant | Pick a user and navigate them to your cursor | Host |
| Reload all files from host | Re-download all shared files | Guest |
| Toggle presentation mode | Auto-broadcast your navigation on file change | Host |
| Transfer host role | Offer host role to another user | Host |
| Set file permissions | Set per-file read-only/read-write for a specific guest | Host |
| Show audit log | View join/leave/kick/permission events | Host |
| Log in with GitHub | Start GitHub OAuth flow | Anyone |
| Log out | Clear stored authentication | Anyone |

## Presence Panel

The collaborators panel (right sidebar) shows each connected user with:

- Colored dot matching their cursor color
- Display name with "Host" badge if applicable
- Current file they're viewing
- **Follow**: Click to follow their navigation and scroll. Any local interaction unfollows.
- **Permission toggle** (host only): Switch between read-write and read-only
- **Summon** (host only): Navigate that user to your cursor position
- **Kick** (host only): Remove from session (with confirmation)

## Ribbon Icon

Click the collaborators icon in the left ribbon to open the presence panel. Right-click for a context menu with session actions.

## Status Bar

Shows connection state, user count, latency, and presentation mode status. Click to open the presence panel.

## Permissions

### Global Permissions

When **Require approval** is enabled, the host sees a modal to approve or deny each guest with read-write or read-only access. The host can change permissions at any time via the presence panel.

### Per-File Permissions

The host can set per-file overrides via the **Set file permissions** command. Per-file overrides take precedence over the user's global permission. Files with overrides show lock icons in the file explorer.

### Kick Protection

When the host kicks a user, that user must be re-approved by the host to rejoin the session. This applies even when **Require approval** is disabled — the server forces a one-time approval gate for kicked users.

## Host Transfer

The host can transfer the role via **Transfer host role**. The target sees a confirmation dialog. The server validates the transfer before swapping roles. All participants are notified of the new host.

## File Exclusion

Add glob patterns in **Settings > Live Share > Excluded patterns** to prevent specific files from syncing.

Default excludes: `.obsidian/**`, `.trash/**`.

Example patterns: `drafts/**`, `*.tmp`, `private/**`.

Uses glob syntax via [minimatch](https://github.com/isaacs/minimatch).

## Presentation Mode

When the host enables presentation mode via **Toggle presentation mode**, every file navigation the host makes is automatically broadcast to all participants. Guests will follow the host's active file in real time. The status bar shows when presentation mode is active.

## File Types

- **Text files** (`.md`, `.txt`, `.json`, `.css`, `.js`, `.ts`, `.html`, `.xml`, `.yaml`, `.toml`, `.csv`, etc.): Character-level real-time sync via Yjs
- **Binary files** (images, PDFs, etc.): Base64 transfer via the control channel with automatic chunking. Max 50 MB per file.
- **Canvas files** (`.canvas`): Real-time CRDT sync

## Cross-Platform Support

Live Share supports collaboration between Windows and macOS/Linux vaults. Windows-forbidden filename characters (`? * < > " | :`) are transparently mapped to fullwidth Unicode equivalents on Windows systems. This mapping is automatic — no configuration needed.

## Invite Link Format

Invite links use the format `obsliveshare:<base64>` containing the server URL, room ID, room token, encryption passphrase, and server password. The encryption passphrase and server password are embedded so the server never sees them directly.

You can also join via Obsidian protocol link: `obsidian://live-share?invite=obsliveshare%3A...`

Share invite links through a secure channel — anyone with the link can join the session.
