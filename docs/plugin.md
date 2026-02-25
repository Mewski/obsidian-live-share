# Plugin Usage

## Installation

1. Build the plugin:
   ```bash
   cd plugin
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-live-share/`
3. Enable "Live Share" in Obsidian's Community Plugins settings

## Configuration

Open Settings > Live Share:

- **Server URL** -- URL of your Live Share server (e.g. `http://localhost:4321`)
- **Display name** -- Your name shown to collaborators
- **Cursor color** -- Your cursor color (hex format)
- **Shared folder** -- Subfolder to share (empty = whole vault)

## Commands

| Command | Description |
|---|---|
| Start session | Create a room and start hosting |
| Join session | Join via invite link |
| End session | Disconnect from the current session |
| Copy invite link | Copy invite link to clipboard |
| Show collaborators panel | Open the presence sidebar |
| Log in with GitHub | Authenticate via GitHub OAuth |
| Log out | Clear stored authentication |
| Focus participants here | Send your cursor location to all participants |
| Summon all participants here | Navigate all participants to your location |

## Hosting a Session

1. Run **Live Share: Start session**
2. Enter a session name
3. An invite link is copied to your clipboard automatically
4. Share the link with collaborators

## Joining a Session

1. Run **Live Share: Join session**
2. Paste the invite link
3. Files sync from the host's vault

## Features

- **Live cursors** -- See other participants' cursors and selections in real-time
- **File sync** -- File creates, deletes, and renames are synced automatically
- **Presence panel** -- See who's connected and what file they're viewing
- **Follow mode** -- Follow a user's navigation and scroll position; any interaction automatically unfollows
- **Focus/Summon** -- Notify participants of your cursor location, or navigate them to it
- **Guest approval** -- Optionally require host approval for guests (Read-Write, Read-Only, or Deny)
- **Kick** -- Hosts can remove participants from the presence panel

## File Exclusion

Create `.liveshare.json` in your vault root:

```json
{
  "exclude": ["drafts/**", "*.tmp", "private/**"]
}
```

Default excludes: `.obsidian/**`, `.liveshare.json`, `.trash/**`

Both text and binary files are shared. Text files sync in real-time via Yjs; binary files (images, PDFs, etc.) are transferred via the control channel with base64 encoding and automatic chunking for large files (50 MB limit).
