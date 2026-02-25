# Security

## End-to-End Encryption

When a host starts a session, a random 128-bit passphrase is generated and embedded in the invite link. This passphrase derives an AES-256-GCM key via PBKDF2 (100,000 iterations, SHA-256). The key encrypts file content in control channel messages before they leave the client.

**What is encrypted:**
- File content in `file-op` create messages (the actual text of new/synced files)

**What is NOT encrypted:**
- Yjs CRDT sync data -- the server processes sync protocol messages to provide persistence, late-join sync, and reconnection recovery. This is the same model used by VS Code Live Share and other real-time collaboration tools.
- Control message metadata (message types, file paths, presence info)

**Flow:**
1. Host starts session -- a random passphrase is generated
2. Passphrase is included in the invite link (never sent to the server)
3. Guest joins via invite link -- passphrase is extracted automatically
4. Both peers derive the same AES-256-GCM key from the passphrase
5. File content is encrypted before sending, decrypted on receipt

Use TLS (`wss://`) in production to encrypt all traffic in transit, including real-time sync data.

## Authentication

### Room Tokens

Each room has a random 24-character token. Only clients with the correct token can connect. Tokens are compared using timing-safe comparison to prevent timing attacks.

### GitHub OAuth (Optional)

When enabled, connections require a valid JWT signed with `JWT_SECRET` (expires after 7 days). See [Server Setup](server.md#github-oauth-optional) for configuration.

## Defenses

| Defense | Description |
|---|---|
| Path validation | All inbound file paths are validated to prevent path traversal (`..`, `.`, absolute paths rejected) |
| Avatar URL validation | Only `https:` URLs are rendered as avatar images |
| Cursor color validation | Only hex color values are accepted |
| Read-only enforcement | Enforced server-side; the server drops writes from read-only clients |
| File deletion safety | Remote deletions move files to Obsidian's trash, not permanent delete |
| Message type whitelist | The control channel only accepts known message types |
| REST rate limiting | 30 requests/min per IP on room endpoints, 10 requests/min on auth endpoints |
| WebSocket rate limiting | 100 messages per 10-second window per client; excess closes the connection |
| Payload limits | Yjs WebSocket: 10 MB max. Control WebSocket: 1 MB max |

## Threat Model

| Threat | Mitigation |
|---|---|
| Compromised server reads file content | E2E encryption of file content in control messages |
| Brute-force room token guessing | 24-character random tokens, rate limiting |
| Path traversal via malicious file ops | Server and client-side path validation |
| XSS via avatar URLs | Only `https:` URLs allowed |
| Message flooding | WebSocket rate limiting (100 msgs/10s) |
| Unauthorized edits by read-only guests | Server-side enforcement of read-only permissions |

## Recommendations

- Use TLS (`wss://`) in production to encrypt all traffic in transit
- Self-host the server for maximum control over your data
- Enable GitHub OAuth for authenticated sessions
- Use `.liveshare.json` exclusion patterns to avoid sharing sensitive files
