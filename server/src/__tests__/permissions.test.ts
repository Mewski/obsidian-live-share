import { afterEach, describe, expect, it } from "vitest";
import {
  clearPermission,
  clearRoomPermissions,
  clearUserFilePermissions,
  getEffectivePermission,
  getFilePermission,
  getPermission,
  setFilePermission,
  setPermission,
} from "../permissions.js";

afterEach(() => {
  clearRoomPermissions("room-a");
  clearRoomPermissions("room-b");
});

describe("setPermission / getPermission", () => {
  it("stores and retrieves a permission", () => {
    setPermission("room-a", "user-1", "read-only");
    expect(getPermission("room-a", "user-1")).toBe("read-only");
  });

  it("returns undefined for unknown user", () => {
    expect(getPermission("room-a", "unknown")).toBeUndefined();
  });

  it("overwrites an existing permission", () => {
    setPermission("room-a", "user-1", "read-only");
    setPermission("room-a", "user-1", "read-write");
    expect(getPermission("room-a", "user-1")).toBe("read-write");
  });

  it("isolates permissions between rooms", () => {
    setPermission("room-a", "user-1", "read-only");
    setPermission("room-b", "user-1", "read-write");
    expect(getPermission("room-a", "user-1")).toBe("read-only");
    expect(getPermission("room-b", "user-1")).toBe("read-write");
  });

  it("isolates permissions between users", () => {
    setPermission("room-a", "user-1", "read-only");
    setPermission("room-a", "user-2", "read-write");
    expect(getPermission("room-a", "user-1")).toBe("read-only");
    expect(getPermission("room-a", "user-2")).toBe("read-write");
  });
});

describe("clearPermission", () => {
  it("removes a single user permission", () => {
    setPermission("room-a", "user-1", "read-only");
    setPermission("room-a", "user-2", "read-write");
    clearPermission("room-a", "user-1");
    expect(getPermission("room-a", "user-1")).toBeUndefined();
    expect(getPermission("room-a", "user-2")).toBe("read-write");
  });

  it("is a no-op for non-existent permission", () => {
    clearPermission("room-a", "nobody");
    expect(getPermission("room-a", "nobody")).toBeUndefined();
  });
});

describe("clearRoomPermissions", () => {
  it("removes all permissions for a room", () => {
    setPermission("room-a", "user-1", "read-only");
    setPermission("room-a", "user-2", "read-write");
    setPermission("room-b", "user-1", "read-only");
    clearRoomPermissions("room-a");
    expect(getPermission("room-a", "user-1")).toBeUndefined();
    expect(getPermission("room-a", "user-2")).toBeUndefined();
    expect(getPermission("room-b", "user-1")).toBe("read-only");
  });

  it("is a no-op for non-existent room", () => {
    clearRoomPermissions("no-such-room");
  });

  it("also clears file permissions for the room", () => {
    setFilePermission("room-a", "user-1", "notes.md", "read-only");
    setFilePermission("room-b", "user-1", "notes.md", "read-only");
    clearRoomPermissions("room-a");
    expect(getFilePermission("room-a", "user-1", "notes.md")).toBeUndefined();
    expect(getFilePermission("room-b", "user-1", "notes.md")).toBe("read-only");
  });
});

describe("setFilePermission / getFilePermission", () => {
  it("stores and retrieves a file permission", () => {
    setFilePermission("room-a", "user-1", "notes.md", "read-only");
    expect(getFilePermission("room-a", "user-1", "notes.md")).toBe("read-only");
  });

  it("returns undefined for unknown file", () => {
    expect(getFilePermission("room-a", "user-1", "unknown.md")).toBeUndefined();
  });

  it("overwrites an existing file permission", () => {
    setFilePermission("room-a", "user-1", "notes.md", "read-only");
    setFilePermission("room-a", "user-1", "notes.md", "read-write");
    expect(getFilePermission("room-a", "user-1", "notes.md")).toBe("read-write");
  });

  it("isolates permissions between files", () => {
    setFilePermission("room-a", "user-1", "a.md", "read-only");
    setFilePermission("room-a", "user-1", "b.md", "read-write");
    expect(getFilePermission("room-a", "user-1", "a.md")).toBe("read-only");
    expect(getFilePermission("room-a", "user-1", "b.md")).toBe("read-write");
  });

  it("isolates permissions between users", () => {
    setFilePermission("room-a", "user-1", "notes.md", "read-only");
    setFilePermission("room-a", "user-2", "notes.md", "read-write");
    expect(getFilePermission("room-a", "user-1", "notes.md")).toBe("read-only");
    expect(getFilePermission("room-a", "user-2", "notes.md")).toBe("read-write");
  });

  it("isolates permissions between rooms", () => {
    setFilePermission("room-a", "user-1", "notes.md", "read-only");
    setFilePermission("room-b", "user-1", "notes.md", "read-write");
    expect(getFilePermission("room-a", "user-1", "notes.md")).toBe("read-only");
    expect(getFilePermission("room-b", "user-1", "notes.md")).toBe("read-write");
  });
});

describe("getEffectivePermission", () => {
  it("returns file-level override when set", () => {
    setPermission("room-a", "user-1", "read-write");
    setFilePermission("room-a", "user-1", "secret.md", "read-only");
    expect(getEffectivePermission("room-a", "user-1", "secret.md")).toBe("read-only");
  });

  it("falls back to room-level when no file override", () => {
    setPermission("room-a", "user-1", "read-write");
    expect(getEffectivePermission("room-a", "user-1", "other.md")).toBe("read-write");
  });

  it("returns room-level when filePath is undefined", () => {
    setPermission("room-a", "user-1", "read-only");
    expect(getEffectivePermission("room-a", "user-1")).toBe("read-only");
  });

  it("returns undefined when no permissions set", () => {
    expect(getEffectivePermission("room-a", "unknown-user", "file.md")).toBeUndefined();
  });
});

describe("clearUserFilePermissions", () => {
  it("removes only that user's file permissions", () => {
    setFilePermission("room-a", "user-1", "a.md", "read-only");
    setFilePermission("room-a", "user-1", "b.md", "read-only");
    setFilePermission("room-a", "user-2", "a.md", "read-write");
    clearUserFilePermissions("room-a", "user-1");
    expect(getFilePermission("room-a", "user-1", "a.md")).toBeUndefined();
    expect(getFilePermission("room-a", "user-1", "b.md")).toBeUndefined();
    expect(getFilePermission("room-a", "user-2", "a.md")).toBe("read-write");
  });

  it("does not affect room-level permissions", () => {
    setPermission("room-a", "user-1", "read-write");
    setFilePermission("room-a", "user-1", "notes.md", "read-only");
    clearUserFilePermissions("room-a", "user-1");
    expect(getPermission("room-a", "user-1")).toBe("read-write");
  });
});
