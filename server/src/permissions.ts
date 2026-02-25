/** Shared permission store between control channel and Yjs WebSocket handler. */

// Key: `${roomId}:${userId}`, Value: permission level
const permissions = new Map<string, "read-write" | "read-only">();

function key(roomId: string, userId: string): string {
  return `${roomId}:${userId}`;
}

export function setPermission(
  roomId: string,
  userId: string,
  permission: "read-write" | "read-only",
): void {
  permissions.set(key(roomId, userId), permission);
}

export function getPermission(
  roomId: string,
  userId: string,
): "read-write" | "read-only" | undefined {
  return permissions.get(key(roomId, userId));
}

export function clearPermission(roomId: string, userId: string): void {
  permissions.delete(key(roomId, userId));
}

export function clearRoom(roomId: string): void {
  for (const k of permissions.keys()) {
    if (k.startsWith(`${roomId}:`)) {
      permissions.delete(k);
    }
  }
}
