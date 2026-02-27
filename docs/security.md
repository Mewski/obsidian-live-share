# Security

## End-to-End Encryption

When a host starts a session, a random 128-bit passphrase is generated and embedded in the invite link. This passphrase derives an AES-256-GCM key via PBKDF2 (100,000 iterations, SHA-256).

**What is encrypted:**
- File content in `file-op` messages
- Chunk data and file paths in `file-chunk-*` messages

**What is NOT encrypted:**
- Yjs CRDT sync data (relayed as opaque binary; use TLS to protect in transit)
- Control message metadata (message types, presence info)

**Key derivation:**
1. Salt derived from passphrase via SHA-256 (first 16 bytes)
2. PBKDF2 derives a 256-bit AES-GCM key
3. All peers with the same passphrase derive the same key
4. Each encryption uses a random 12-byte IV prepended to ciphertext

The passphrase is in the invite link and never sent to the server.

## Authentication

### Room Tokens

Each room has a random 24-character token (nanoid). Compared using `crypto.timingSafeEqual`.

### GitHub OAuth (Optional)

When enabled, all WebSocket connections require a valid JWT (7-day expiry). The server uses JWT-verified identity for host determination.

## Server-Side Enforcement

| Operation | Enforcement |
|-----------|-------------|
| Yjs writes from read-only clients | Silently dropped |
| File ops from read-only clients | Silently dropped |
| Summon, kick, session-end from non-host | Dropped |
| Per-file permission overrides | Checked before relaying file-ops |
| Host transfer | Validated against pending offer |
| Kicked user rejoin | Forced through host approval flow |

## Defenses

| Defense | Description |
|---------|-------------|
| Path validation | `..`, `.`, and absolute paths rejected |
| Avatar URL validation | Only `https:` URLs from `githubusercontent.com` |
| Cursor color validation | Only valid hex colors applied |
| REST rate limiting | 30 req/min on rooms, 10 req/min on auth |
| WebSocket rate limiting | 100 msgs/10s per client |
| Payload limits | Yjs: 10 MB, control: 2 MB |
| Chunk validation | All chunks verified before writing to disk |
| Chunk index bounds | Indices validated against expected range |
| Server password | Optional `SERVER_PASSWORD` restricts all access |
| CSS injection prevention | Explorer indicator CSS escapes special characters |
| Offline queue coalescing | Renames update paths of previously queued ops |
| File deletion safety | Uses Obsidian's trash (recoverable) |
| Kick protection | Kicked users cannot bypass approval on rejoin |
| Cross-platform path safety | Canonical paths on wire, local-only filesystem transformations |

## Threat Model

| Threat | Mitigation |
|--------|------------|
| Server reads file content | E2E encryption; use TLS for Yjs data |
| Room token guessing | 24-char random tokens, rate limiting |
| Path traversal | Client and server-side validation |
| XSS via avatars | URL allowlist, HTML escaping |
| Message flooding | Rate limiting, connection close on violation |
| Unauthorized edits | Server-side read-only enforcement |
| Guest impersonating host | Server determines host via JWT or first-connected |
| Unauthorized host transfer | Server validates pending offer |
| Kicked user rejoining | Server forces approval flow regardless of room settings |
| Windows filename attacks | Transparent fullwidth character mapping at filesystem boundary |

## Recommendations

- Enable TLS (`wss://`) to encrypt all traffic
- Self-host the server for full control
- Enable GitHub OAuth for authenticated sessions
- Use file exclusion patterns in settings to exclude sensitive files
- Share invite links through a secure channel
