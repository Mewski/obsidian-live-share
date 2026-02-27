import type { Permission } from "./persistence.js";

const permissions = new Map<string, Permission>();

function permissionKey(roomId: string, userId: string): string {
  return `${roomId}:${userId}`;
}

export function setPermission(
  roomId: string,
  userId: string,
  permission: Permission,
): void {
  permissions.set(permissionKey(roomId, userId), permission);
}

export function getPermission(
  roomId: string,
  userId: string,
): Permission | undefined {
  return permissions.get(permissionKey(roomId, userId));
}

export function clearPermission(roomId: string, userId: string): void {
  permissions.delete(permissionKey(roomId, userId));
}

export function clearRoomPermissions(roomId: string): void {
  const prefix = `${roomId}:`;
  for (const key of permissions.keys()) {
    if (key.startsWith(prefix)) permissions.delete(key);
  }
}
