import type { Permission } from "./persistence.js";

const permissions = new Map<string, Permission>();
const filePermissions = new Map<string, Permission>();

function permissionKey(roomId: string, userId: string): string {
  return `${roomId}:${userId}`;
}

function filePermissionKey(roomId: string, userId: string, filePath: string): string {
  return `${roomId}:${userId}:${filePath}`;
}

export function setPermission(roomId: string, userId: string, permission: Permission): void {
  permissions.set(permissionKey(roomId, userId), permission);
}

export function getPermission(roomId: string, userId: string): Permission | undefined {
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
  for (const key of filePermissions.keys()) {
    if (key.startsWith(prefix)) filePermissions.delete(key);
  }
}

export function setFilePermission(
  roomId: string,
  userId: string,
  filePath: string,
  permission: Permission,
): void {
  filePermissions.set(filePermissionKey(roomId, userId, filePath), permission);
}

export function getFilePermission(
  roomId: string,
  userId: string,
  filePath: string,
): Permission | undefined {
  return filePermissions.get(filePermissionKey(roomId, userId, filePath));
}

export function getEffectivePermission(
  roomId: string,
  userId: string,
  filePath?: string,
): Permission | undefined {
  if (filePath) {
    const fp = filePermissions.get(filePermissionKey(roomId, userId, filePath));
    if (fp) return fp;
  }
  return permissions.get(permissionKey(roomId, userId));
}

export function clearUserFilePermissions(roomId: string, userId: string): void {
  const prefix = `${roomId}:${userId}:`;
  for (const key of filePermissions.keys()) {
    if (key.startsWith(prefix)) filePermissions.delete(key);
  }
}
