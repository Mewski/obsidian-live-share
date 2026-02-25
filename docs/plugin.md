# Plugin Usage

## Installation

### From Source

```bash
cd plugin
npm install
npm run build
```

Copy the built files into your vault's plugin directory:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-live-share
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-live-share/
```

Open Obsidian, go to **Settings > Community Plugins**, and enable **Obsidian Live Share**.

## Configuration

Open **Settings > Live Share**:

| Setting | Description |
|---------|-------------|
| **Server URL** | URL of your server (e.g. `http://localhost:4321`) |
| **Display name** | Your name shown to collaborators (whitespace-only names default to "Anonymous") |
| **Cursor color** | Pick your cursor color using the color picker |
| **Shared folder** | Subfolder to share (leave empty for the whole vault) |
| **Require approval** | When enabled, guests must be approved by the host before joining. The host can grant read-write or read-only access, or deny the request. |

When a session is active, the settings page also shows the connection state, room ID, token, and encryption status.

## Commands

All commands are accessible via the command palette (Ctrl/Cmd+P, then type "Live Share").

### Session Management

| Command | Description |
|---------|-------------|
| **Start session** | Create a new room and start hosting. Generates an E2E encryption passphrase and automatically copies the invite link to your clipboard. |
| **Join session** | Paste an invite link to join an existing session. Files sync automatically from the host. |
| **End session** | Leave the session (asks for confirmation). If you're the host, all participants are disconnected. |
| **Copy invite link** | Copy the current session's invite link to share with others. |

### Collaboration

| Command | Description | Access |
|---------|-------------|--------|
| **Show collaborators panel** | Open the presence sidebar showing connected users. | Anyone |
| **Focus participants here** | Send a notification to all participants with your current file and cursor position. They see a "Go to" button. | Anyone |
| **Summon all participants here** | Navigate all participants to your cursor location immediately. | Host only |
| **Summon a specific participant here** | Pick a user from a list and navigate them to your cursor. | Host only |
| **Reload all files from host** | Re-download all shared files from the host's vault. | Guest only |
| **Toggle presentation mode** | While active, every time you navigate to a different file, a focus request is automatically sent to all participants. | Host only |

### Authentication

| Command | Description |
|---------|-------------|
| **Log in with GitHub** | Opens the GitHub OAuth flow in your browser. |
| **Log out** | Clear stored JWT and GitHub identity. |

## Presence Panel

The collaborators panel (right sidebar) shows each connected user with:

- **Colored dot** matching their cursor color
- **Display name** with a "Host" badge if applicable
- **Current file** they're viewing
- **Follow button**: Click to follow their navigation and scroll. Click again to unfollow. Any keyboard, mouse, or scroll interaction automatically unfollows.
- **Permission toggle** (host only): Toggle a guest between read-write and read-only. Takes effect immediately.
- **Summon button** (host only): Navigate that specific user to your cursor
- **Kick button** (host only): Remove the user from the session (asks for confirmation)

## Status Bar

The status bar shows the current connection state:

- `Live Share: off`: No active session
- `Live Share: hosting (3) 42ms`: Hosting with 3 total users, 42ms latency
- `Live Share: joined (2) 38ms`: Joined with 2 total users, 38ms latency
- `Live Share: hosting (3) 42ms [presenting]`: Presentation mode active
Click the status bar to open the collaborators panel.

## Permissions

When **Require approval** is enabled and a guest joins, the host sees a modal to approve or deny the request. Approved guests receive either **read-write** or **read-only** access:

- **Read-write**: Full editing, file creation, deletion, and rename
- **Read-only**: Can view all shared files but cannot modify content. Enforced server-side on both Yjs document updates and control channel file operations.

When approval is disabled (default), all guests join with read-write access.

The host can change a guest's permission at any time via the permission toggle button in the presence panel. The change takes effect immediately.

## Host Disconnect

If the host disconnects, all guests are notified with a "host has left" notice. The session effectively ends since the host is the source of truth for file operations.

## File Exclusion

Create `.liveshare.json` in your vault root:

```json
{
  "exclude": ["drafts/**", "*.tmp", "private/**"]
}
```

Default excludes (always applied): `.obsidian/**`, `.liveshare.json`, `.trash/**`.

Patterns use glob syntax via [minimatch](https://github.com/isaacs/minimatch). Changes to `.liveshare.json` are picked up automatically while a session is active.

## File Types

- **Text files** (`.md`, `.txt`, `.json`, `.css`, `.js`, `.ts`, etc.): Synced character-by-character in real-time via Yjs CRDT
- **Binary files** (images, PDFs, etc.): Transferred as base64 via the control channel with automatic chunking for files over 512 KB. Maximum file size: 50 MB.

## Invite Link Format

Invite links are encoded as `obsliveshare:<base64>` where the base64 payload contains:

```json
{
  "s": "http://localhost:4321",
  "r": "room-id",
  "t": "room-token",
  "e": "encryption-passphrase"
}
```

The encryption passphrase is included in the link so the server never sees it. Share invite links through a secure channel.
