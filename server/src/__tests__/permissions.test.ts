import { afterEach, describe, expect, it } from "vitest";
import {
  clearPermission,
  clearRoomPermissions,
  getPermission,
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
});
