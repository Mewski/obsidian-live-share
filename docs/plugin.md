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

| Setting | Description |
|---------|-------------|
| Server URL | URL of your server (e.g. `http://localhost:4321`) |
| Display name | Your name shown to collaborators |
| Cursor color | Your cursor color in the editor |
| Shared folder | Subfolder to share (empty = whole vault) |
| Require approval | Require host approval for guests |
| Notifications | Toggle non-critical status notices |
| Auto-reconnect | Rejoin previous session on startup |
| Debug logging | Write debug logs to a vault file |

When a session is active, the settings page shows connection state, room ID, encryption status, and session actions.

## Commands

All commands are in the command palette (Ctrl/Cmd+P, type "Live Share").

| Command | Description | Access |
|---------|-------------|--------|
| Start session | Create a room and start hosting | Anyone |
| Join session | Paste an invite link to join | Anyone |
| End session | Leave the session (with confirmation) | Anyone in session |
| Leave session | Leave as guest | Guest |
| Copy invite link | Copy invite to clipboard | Anyone in session |
| Show collaborators panel | Open the presence sidebar | Anyone |
| Focus participants here | Send "look here" to all | Anyone in session |
| Summon all participants here | Navigate everyone to your cursor | Host |
| Summon a specific participant | Pick a user and navigate them | Host |
| Reload all files from host | Re-download all shared files | Guest |
| Toggle presentation mode | Auto-broadcast navigation on file change | Host |
| Transfer host role | Offer host role to another user | Host |
| Set file permissions | Per-file read-only/read-write for a guest | Host |
| Show audit log | View join/leave/kick/permission events | Host |
| Log in with GitHub | Start GitHub OAuth flow | Anyone |
| Log out | Clear stored authentication | Anyone |

## Presence Panel

The collaborators panel (right sidebar) shows each connected user with:

- Colored dot matching their cursor color
- Display name with "Host" badge if applicable
- Current file they're viewing
- **Follow**: Click to follow their navigation and scroll. Any interaction unfollows.
- **Permission toggle** (host): Toggle read-write / read-only
- **Summon** (host): Navigate that user to your cursor
- **Kick** (host): Remove from session (with confirmation)

## Ribbon Icon

Click the collaborators icon to open the presence panel. Right-click for a context menu with session actions.

## Status Bar

Shows connection state, user count, latency, and presentation mode status. Click to open the presence panel.

## Permissions

When **Require approval** is enabled, the host sees a modal to approve or deny each guest with read-write or read-only access. The host can change permissions at any time via the presence panel.

### Per-File Permissions

The host can set per-file overrides via **Set file permissions**. Per-file overrides take precedence over global permission. Files with overrides show lock icons in the file explorer.

## Host Transfer

The host can transfer the role via **Transfer host role**. The target sees a confirmation dialog. The server validates the transfer before swapping roles. All participants are notified.

## File Exclusion

Create `.liveshare.json` in your vault root:

```json
{
  "exclude": ["drafts/**", "*.tmp", "private/**"]
}
```

Default excludes: `.obsidian/**`, `.liveshare.json`, `.trash/**`. Uses glob syntax via minimatch.

## File Types

- **Text files** (`.md`, `.txt`, `.json`, `.css`, `.js`, `.ts`, etc.): Character-level real-time sync via Yjs
- **Binary files** (images, PDFs, etc.): Base64 transfer via control channel with automatic chunking. Max 50 MB.

## Invite Link Format

Invite links are `obsliveshare:<base64>` containing:

```json
{
  "s": "http://localhost:4321",
  "r": "room-id",
  "t": "room-token",
  "e": "encryption-passphrase",
  "p": "server-password"
}
```

The encryption passphrase and server password are embedded so the server never sees them directly. Share invite links through a secure channel.

You can also join via protocol link: `obsidian://live-share?invite=obsliveshare%3A...`
