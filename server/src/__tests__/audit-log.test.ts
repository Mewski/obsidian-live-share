import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type AuditEntry,
  appendLog,
  clearLogs,
  closeAuditLog,
  getLogs,
  initAuditLog,
} from "../audit-log.js";

const TEST_DB_PATH = path.join(import.meta.dirname ?? __dirname, ".tmp-audit-test");

beforeAll(() => {
  initAuditLog(TEST_DB_PATH);
});

afterEach(async () => {
  await clearLogs("room-a");
  await clearLogs("room-b");
});

afterAll(async () => {
  await closeAuditLog();
  fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
});

describe("appendLog / getLogs", () => {
  it("writes and retrieves a single entry", async () => {
    const entry: AuditEntry = {
      timestamp: Date.now(),
      event: "join",
      userId: "user-1",
      displayName: "Alice",
    };
    await appendLog("room-a", entry);
    const logs = await getLogs("room-a");
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("join");
    expect(logs[0].userId).toBe("user-1");
    expect(logs[0].displayName).toBe("Alice");
  });

  it("returns entries in reverse chronological order", async () => {
    await appendLog("room-a", {
      timestamp: 1000,
      event: "join",
      userId: "user-1",
      displayName: "First",
    });
    await appendLog("room-a", {
      timestamp: 2000,
      event: "leave",
      userId: "user-1",
      displayName: "First",
    });
    await appendLog("room-a", {
      timestamp: 3000,
      event: "kick",
      userId: "user-2",
      displayName: "Second",
    });

    const logs = await getLogs("room-a");
    expect(logs).toHaveLength(3);
    expect(logs[0].timestamp).toBe(3000);
    expect(logs[1].timestamp).toBe(2000);
    expect(logs[2].timestamp).toBe(1000);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await appendLog("room-a", {
        timestamp: i,
        event: "join",
        userId: `user-${i}`,
        displayName: `User ${i}`,
      });
    }

    const logs = await getLogs("room-a", 3);
    expect(logs).toHaveLength(3);
  });

  it("isolates entries between rooms", async () => {
    await appendLog("room-a", {
      timestamp: Date.now(),
      event: "join",
      userId: "user-1",
      displayName: "Alice",
    });
    await appendLog("room-b", {
      timestamp: Date.now(),
      event: "join",
      userId: "user-2",
      displayName: "Bob",
    });

    const logsA = await getLogs("room-a");
    expect(logsA).toHaveLength(1);
    expect(logsA[0].userId).toBe("user-1");

    const logsB = await getLogs("room-b");
    expect(logsB).toHaveLength(1);
    expect(logsB[0].userId).toBe("user-2");
  });

  it("stores optional details field", async () => {
    await appendLog("room-a", {
      timestamp: Date.now(),
      event: "permission-change",
      userId: "user-1",
      displayName: "Alice",
      details: "read-only",
    });

    const logs = await getLogs("room-a");
    expect(logs[0].details).toBe("read-only");
  });

  it("returns empty array for room with no entries", async () => {
    const logs = await getLogs("nonexistent-room");
    expect(logs).toEqual([]);
  });
});

describe("clearLogs", () => {
  it("removes all entries for a room", async () => {
    await appendLog("room-a", {
      timestamp: Date.now(),
      event: "join",
      userId: "user-1",
      displayName: "Alice",
    });
    await appendLog("room-a", {
      timestamp: Date.now(),
      event: "leave",
      userId: "user-1",
      displayName: "Alice",
    });

    await clearLogs("room-a");
    const logs = await getLogs("room-a");
    expect(logs).toHaveLength(0);
  });

  it("does not affect other rooms", async () => {
    await appendLog("room-a", {
      timestamp: Date.now(),
      event: "join",
      userId: "user-1",
      displayName: "Alice",
    });
    await appendLog("room-b", {
      timestamp: Date.now(),
      event: "join",
      userId: "user-2",
      displayName: "Bob",
    });

    await clearLogs("room-a");
    const logsB = await getLogs("room-b");
    expect(logsB).toHaveLength(1);
  });
});
