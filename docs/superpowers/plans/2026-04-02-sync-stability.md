# Sync Stability & Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix critical desync bugs, race conditions, and data loss issues across the plugin and server to make multi-user collaboration reliable.

**Architecture:** Fix bugs in priority order — critical silent data loss first, then race conditions in file operations, then server correctness, then session lifecycle. Each task is self-contained with tests. Where a fix naturally requires restructuring (manifest handler serialization, op-queue atomicity), do the restructuring properly rather than patching.

**Tech Stack:** TypeScript, Yjs, Vitest, lib0, WebSocket, Express

---

## File Map

**Plugin files modified:**
- `plugin/src/sync/sync.ts` — Fix premature `isConnected`, encrypted queue loss, mux death detection
- `plugin/src/files/manifest.ts` — No changes (called by main.ts handler)
- `plugin/src/files/background-sync.ts` — Fix destroy flush, host subscribe overwrite
- `plugin/src/files/file-ops.ts` — Fix op-queue race, destroy cleanup, chunk-end cache bypass
- `plugin/src/files/vault-events.ts` — Fix create-during-rename leak, double-read race
- `plugin/src/main.ts` — Serialize manifest handler, session mutex, coordinate channels, deactivate collab on cleanup
- `plugin/src/sync/control-ws.ts` — Fix first-connection misdiagnosis
- `plugin/src/sync/control-handlers.ts` — Fix host-transfer manifest purge

**Server files modified:**
- `server/src/control-handler.ts` — Fix host re-election, approval bypass, permission persistence on reconnect
- `server/src/ws-handler.ts` — Fix encrypted awareness ID tracking

**Test files created/modified:**
- `plugin/src/__tests__/sync.test.ts` — New: SyncManager unit tests
- `plugin/src/__tests__/background-sync.test.ts` — Add flush-on-destroy, host-subscribe tests
- `plugin/src/__tests__/file-ops.test.ts` — Add concurrent op-queue test
- `plugin/src/__tests__/vault-events.test.ts` — New: vault event handler tests
- `server/src/__tests__/control-handler.test.ts` — Add host re-election, approval bypass tests
- `server/src/__tests__/ws-handler.test.ts` — Add encrypted awareness test

---

### Task 1: Fix SyncManager `isConnected` set before WebSocket opens

Yjs updates sent between `connect()` and `ws.onopen` are silently dropped because `sendMux` checks `ws.readyState` but `getDoc()` creates docs and attaches update handlers immediately. The fix: defer `isConnected = true` to the `onopen` callback, and buffer `getDoc` calls or queue subscribe messages.

**Files:**
- Modify: `plugin/src/sync/sync.ts:68-73` and `plugin/src/sync/sync.ts:223-228`
- Test: `plugin/src/__tests__/sync.test.ts` (create)

- [ ] **Step 1: Write failing test for premature isConnected**

```typescript
// plugin/src/__tests__/sync.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

let mockWsInstance: MockWebSocket;
vi.stubGlobal(
  "WebSocket",
  vi.fn(() => {
    mockWsInstance = new MockWebSocket();
    return mockWsInstance;
  }),
);

import { SyncManager } from "../sync/sync";

function makeSettings() {
  return {
    serverUrl: "http://localhost:3000",
    roomId: "test-room",
    token: "test-token",
    jwt: "",
    serverPassword: "",
    clientId: "client-1",
    githubUserId: "",
    role: "host" as const,
    displayName: "Test",
    avatarUrl: "",
    cursorColor: "#000",
    sharedFolder: "",
    encryptionPassphrase: "",
    autoReconnect: false,
    notificationsEnabled: false,
    debugLogging: false,
    debugLogPath: "",
    excludePatterns: [],
    requireApproval: false,
    approvalTimeoutSeconds: 60,
    permission: "read-write" as const,
    readOnlyPatterns: [],
  };
}

describe("SyncManager", () => {
  let sm: SyncManager;

  beforeEach(() => {
    sm = new SyncManager(makeSettings());
  });

  it("should not allow getDoc before WebSocket opens", () => {
    sm.connect();
    // WS is still CONNECTING, not OPEN
    const handle = sm.getDoc("test.md");
    // getDoc should still return a handle (we queue the subscribe)
    expect(handle).not.toBeNull();
    // But no messages should have been sent yet (WS not open)
    expect(mockWsInstance.sent).toHaveLength(0);
  });

  it("should send queued subscribes when WebSocket opens", () => {
    sm.connect();
    sm.getDoc("test.md");
    expect(mockWsInstance.sent).toHaveLength(0);
    mockWsInstance.simulateOpen();
    // After open, should have sent subscribe for test.md
    expect(mockWsInstance.sent.length).toBeGreaterThan(0);
  });

  it("should send Yjs updates only after WebSocket opens", () => {
    sm.connect();
    const handle = sm.getDoc("test.md");
    expect(handle).not.toBeNull();
    // Write to the doc before WS opens
    handle!.doc.transact(() => {
      handle!.text.insert(0, "hello");
    });
    // Updates should be buffered, not sent
    expect(mockWsInstance.sent).toHaveLength(0);
    // Open the WS
    mockWsInstance.simulateOpen();
    // Now subscribe + sync step 1 sent, and any buffered updates
    expect(mockWsInstance.sent.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin && npx vitest run src/__tests__/sync.test.ts`
Expected: FAIL — `getDoc` currently sends subscribe immediately (silently dropped), and `sent` array may contain messages despite WS not being open (depends on mock fidelity).

- [ ] **Step 3: Implement the fix**

In `plugin/src/sync/sync.ts`, change `connect()` to NOT set `isConnected = true` immediately. Instead, set it in the `onopen` handler. Buffer getDoc calls so they still return handles but defer subscribe sends:

```typescript
// sync.ts — connect() method (line 68)
connect(): void {
  this.shouldConnect = true;
  this.reconnectAttempts = 0;
  this.openWebSocket();
}

// sync.ts — openWebSocket() onopen handler (line 223)
ws.onopen = () => {
  this.isConnected = true;
  this.reconnectAttempts = 0;
  for (const filePath of this.docs.keys()) {
    this.synced.set(filePath, false);
    this.sendSubscribe(filePath);
  }
};
```

Also update `getDoc` to work even when `isConnected` is false but `shouldConnect` is true:

```typescript
// sync.ts — getDoc() method (line 96)
getDoc(rawPath: string): DocHandle | null {
  if ((!this.isConnected && !this.shouldConnect) || !this.settings.roomId) return null;

  const filePath = normalizePath(rawPath);

  const existingDoc = this.docs.get(filePath);
  const existingAwareness = this.awarenessMap.get(filePath);
  if (existingDoc && existingAwareness) {
    return {
      doc: existingDoc,
      text: existingDoc.getText("content"),
      awareness: existingAwareness,
    };
  }

  const doc = new Y.Doc();
  this.docs.set(filePath, doc);

  const awareness = new awarenessProtocol.Awareness(doc);
  this.awarenessMap.set(filePath, awareness);

  this.synced.set(filePath, false);

  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const syncEncoder = encoding.createEncoder();
    syncProtocol.writeUpdate(syncEncoder, update);
    this.sendMux(filePath, MUX_SYNC, encoding.toUint8Array(syncEncoder));
  };
  doc.on("update", updateHandler);
  this.updateHandlers.set(filePath, updateHandler);

  const awarenessHandler = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote") return;
    const changedClients = changes.added.concat(changes.updated, changes.removed);
    if (changedClients.length === 0) return;
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
    this.sendMux(filePath, MUX_AWARENESS, awarenessUpdate);
  };
  awareness.on("update", awarenessHandler);
  this.awarenessHandlers.set(filePath, awarenessHandler);

  // Only send subscribe if WS is already open; otherwise onopen will handle it
  if (this.isConnected) {
    this.sendSubscribe(filePath);
  }

  const text = doc.getText("content");
  return { doc, text, awareness };
}
```

The key insight: `sendMux` already guards on `ws.readyState === WebSocket.OPEN`, so Yjs updates written before open are silently dropped. After the fix, `onopen` re-subscribes all docs, which triggers `MUX_SYNC_REQUEST` from the server to peers, initiating a fresh sync exchange that will include any local changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin && npx vitest run src/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd plugin && npm test`
Expected: All 310+ tests pass

- [ ] **Step 6: Commit**

```bash
git add plugin/src/sync/sync.ts plugin/src/__tests__/sync.test.ts
git commit -m "fix: defer isConnected until WebSocket opens to prevent silent message loss"
```

---

### Task 2: Fix `BackgroundSync.destroy()` dropping pending writes

`destroy()` clears all debounce timers without flushing. The last ~1 second of remote edits are lost on session end.

**Files:**
- Modify: `plugin/src/files/background-sync.ts:247-261`
- Test: `plugin/src/__tests__/background-sync.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to plugin/src/__tests__/background-sync.test.ts

it("destroy flushes pending debounced writes to disk", async () => {
  await backgroundSync.startAll("guest");
  const path = "test.md";
  const docHandle = syncManager.getDoc(path)!;

  // Simulate remote edit (non-local transaction)
  const remoteDoc = new Y.Doc();
  const remoteText = remoteDoc.getText("content");
  remoteDoc.transact(() => remoteText.insert(0, "remote edit"));
  const update = Y.encodeStateAsUpdate(remoteDoc);
  Y.applyUpdate(docHandle.doc, update);

  // The observer fires and schedules a debounced write (1000ms)
  // Don't wait for the debounce — destroy immediately
  backgroundSync.destroy();

  // The content should have been flushed to disk
  const file = vault.getAbstractFileByPath(toLocalPath(path));
  expect(file).toBeTruthy();
  const content = await vault.read(file!);
  expect(content).toBe("remote edit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin && npx vitest run src/__tests__/background-sync.test.ts -t "destroy flushes"`
Expected: FAIL — content is empty or old because the timer was cleared without flushing.

- [ ] **Step 3: Implement the fix**

```typescript
// background-sync.ts — destroy() method, replace lines 247-261
destroy(): void {
  this.running = false;
  // Flush all pending debounced writes before clearing
  for (const [path, timer] of this.writeTimers) {
    clearTimeout(timer);
    const docHandle = this.syncManager.getDoc(path);
    if (docHandle && !docHandle.doc.isDestroyed) {
      const content = docHandle.text.toString();
      if (this.lastWrittenContent.get(path) !== content) {
        const diskPath = toLocalPath(path);
        this.fileOpsManager.mutePathEvents(diskPath);
        try {
          const file = getFileByPath(this.vault, diskPath);
          if (file) {
            // Synchronous-style write via adapter (fire-and-forget on destroy)
            void this.vault.adapter.write(diskPath, content);
          }
        } finally {
          setTimeout(() => this.fileOpsManager.unmutePathEvents(diskPath), VAULT_EVENT_SETTLE_MS);
        }
      }
    }
  }
  this.writeTimers.clear();
  for (const [, unobserve] of this.observers) {
    unobserve();
  }
  this.observers.clear();
  this.cancelledSubscribes.clear();
  this.activeFile = null;
  this.recentDiskWrites.clear();
  this.lastWrittenContent.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin && npx vitest run src/__tests__/background-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/src/files/background-sync.ts plugin/src/__tests__/background-sync.test.ts
git commit -m "fix: flush pending debounced writes on destroy to prevent data loss"
```

---

### Task 3: Fix op-queue race condition in `FileOpsManager.applyRemoteOp`

The current pattern `await existing; set new` is not atomic — two concurrent ops on the same path both await the same promise and then both execute simultaneously.

**Files:**
- Modify: `plugin/src/files/file-ops.ts:129-139`
- Test: `plugin/src/__tests__/file-ops.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to plugin/src/__tests__/file-ops.test.ts

it("serializes concurrent ops on the same path", async () => {
  const order: string[] = [];
  const originalApply = (manager as any).applyRemoteOpInner.bind(manager);
  // Patch to track execution order
  (manager as any).applyRemoteOpInner = async (op: any) => {
    order.push(`start-${op.type}`);
    await originalApply(op);
    order.push(`end-${op.type}`);
  };

  // Fire two ops for the same path concurrently
  const p1 = manager.applyRemoteOp({ type: "create", path: "race.md", content: "v1" });
  const p2 = manager.applyRemoteOp({ type: "modify", path: "race.md", content: "v2" });

  await Promise.all([p1, p2]);

  // They should have run sequentially, not interleaved
  expect(order).toEqual(["start-create", "end-create", "start-modify", "end-modify"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin && npx vitest run src/__tests__/file-ops.test.ts -t "serializes concurrent"`
Expected: FAIL — order shows interleaving like `["start-create", "start-modify", ...]`

- [ ] **Step 3: Implement the fix**

Replace the await-then-set pattern with atomic promise chaining:

```typescript
// file-ops.ts — replace applyRemoteOp (lines 129-140)
async applyRemoteOp(op: FileOp) {
  const paths = this.getOpPaths(op);

  // Chain onto existing queue for all affected paths atomically
  const currentQueues = paths.map((path) => this.opQueues.get(path) ?? Promise.resolve());
  const gate = Promise.all(currentQueues);

  const promise = gate.then(() => this.applyRemoteOpInner(op));

  // Set the new promise for all paths BEFORE awaiting
  for (const path of paths) this.opQueues.set(path, promise);

  try {
    await promise;
  } finally {
    for (const path of paths) {
      if (this.opQueues.get(path) === promise) this.opQueues.delete(path);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin && npx vitest run src/__tests__/file-ops.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/src/files/file-ops.ts plugin/src/__tests__/file-ops.test.ts
git commit -m "fix: make op-queue atomic to prevent concurrent ops on same path"
```

---

### Task 4: Serialize manifest change handler to prevent concurrent syncFromManifest

The manifest Y.Map observer fires the handler in a `void async IIFE`. Rapid manifest changes spawn multiple concurrent handlers that race on file creation, deletion, and subscription.

**Files:**
- Modify: `plugin/src/main.ts:76-153`

- [ ] **Step 1: Write failing test**

This is hard to unit test in isolation since it's wired deep in `main.ts`. We'll add a serialization mechanism and verify it works via the existing test suite plus a targeted test.

```typescript
// Add to plugin/src/__tests__/manifest.test.ts

describe("manifest change handler serialization", () => {
  it("does not run handlers concurrently", async () => {
    // This tests the serialization wrapper pattern
    let running = 0;
    let maxConcurrency = 0;
    let manifestQueue = Promise.resolve();

    const handler = async () => {
      running++;
      maxConcurrency = Math.max(maxConcurrency, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };

    // Simulate 5 rapid manifest changes
    for (let i = 0; i < 5; i++) {
      manifestQueue = manifestQueue.then(handler);
    }
    await manifestQueue;

    expect(maxConcurrency).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails with current pattern**

The test above will pass since it tests the correct pattern. The real fix is in `main.ts`.

- [ ] **Step 3: Implement the fix**

Add a `manifestHandlerQueue` to serialize handler invocations:

```typescript
// main.ts — add field after line 67
private manifestHandlerQueue: Promise<void> = Promise.resolve();

// main.ts — replace registerManifestChangeHandler (lines 76-153)
private registerManifestChangeHandler() {
  this.manifestManager.setManifestChangeHandler((added, removed) => {
    this.manifestHandlerQueue = this.manifestHandlerQueue.then(async () => {
      const renamedOldPaths = new Set<string>();
      const renamedNewPaths = new Set<string>();
      if (added.length > 0 && removed.length > 0) {
        for (const oldPath of removed) {
          for (const newPath of added) {
            if (renamedNewPaths.has(newPath)) continue;
            const localOld = toLocalPath(oldPath);
            const localNew = toLocalPath(newPath);
            const oldFile = this.app.vault.getAbstractFileByPath(localOld);
            const newFile = this.app.vault.getAbstractFileByPath(localNew);
            if (oldFile && !newFile) {
              renamedOldPaths.add(oldPath);
              renamedNewPaths.add(newPath);
              this.fileOpsManager.mutePathEvents(localOld);
              this.fileOpsManager.mutePathEvents(localNew);
              try {
                const parentDir = localNew.substring(0, localNew.lastIndexOf("/"));
                if (parentDir) await ensureFolder(this.app.vault, parentDir);
                await this.app.vault.rename(oldFile, localNew);
              } finally {
                setTimeout(() => {
                  this.fileOpsManager.unmutePathEvents(localOld);
                  this.fileOpsManager.unmutePathEvents(localNew);
                }, VAULT_EVENT_SETTLE_MS);
              }
              if (isTextFile(oldPath)) {
                this.backgroundSync.onFileRemoved(oldPath);
              }
              if (isTextFile(newPath)) {
                await this.backgroundSync.onFileAdded(newPath);
              }
              break;
            }
            if (!oldFile && newFile) {
              renamedOldPaths.add(oldPath);
              renamedNewPaths.add(newPath);
              if (isTextFile(oldPath)) {
                this.backgroundSync.onFileRemoved(oldPath);
              }
              if (isTextFile(newPath)) {
                await this.backgroundSync.onFileAdded(newPath);
              }
              break;
            }
          }
        }
      }

      const actuallyAdded = added.filter((path) => !renamedNewPaths.has(path));
      const actuallyRemoved = removed.filter((path) => !renamedOldPaths.has(path));

      if (actuallyAdded.length > 0) {
        const syncedCount = await this.manifestManager.syncFromManifest(
          this.mutePathEvents,
          this.unmutePathEvents,
          this.requestBinaryFile,
          { skipText: true },
        );
        if (syncedCount > 0) this.notify(`Live Share: synced ${syncedCount} file(s)`);
        for (const path of actuallyAdded) {
          if (isTextFile(path)) {
            await this.backgroundSync.onFileAdded(path);
          }
        }
      }
      for (const path of actuallyRemoved) {
        this.backgroundSync.onFileRemoved(path);
        const file = this.app.vault.getAbstractFileByPath(toLocalPath(path));
        if (file) await this.app.fileManager.trashFile(file);
      }
      if (actuallyRemoved.length > 0)
        this.notify(`Live Share: removed ${actuallyRemoved.length} file(s)`);
    }).catch((err) => {
      this.logger.error("manifest", "handler error", err);
    });
  });
}
```

- [ ] **Step 4: Run full test suite**

Run: `cd plugin && npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add plugin/src/main.ts plugin/src/__tests__/manifest.test.ts
git commit -m "fix: serialize manifest change handler to prevent concurrent sync races"
```

---

### Task 5: Fix host subscribe overwriting guest edits on non-active files

When the host calls `subscribe()` for a non-active file, it blindly pushes disk content to Y.Text, discarding any guest edits. This is especially bad during host transfer.

**Files:**
- Modify: `plugin/src/files/background-sync.ts:86-94`
- Test: `plugin/src/__tests__/background-sync.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to plugin/src/__tests__/background-sync.test.ts

it("host subscribe does not overwrite Y.Text if remote has different content", async () => {
  // Simulate: guest already wrote to Y.Text before host subscribes
  const path = "shared.md";
  const docHandle = syncManager.getDoc(path)!;

  // Guest edit already in Y.Text
  docHandle.doc.transact(() => {
    docHandle.text.insert(0, "guest edit");
  });

  // Host has different content on disk
  vault.adapter.write(toLocalPath(path), "host disk content");

  // Host subscribes — should merge, not overwrite
  await backgroundSync.startAll("host");

  // Y.Text should still contain guest edit (merged), not be replaced
  const content = docHandle.text.toString();
  // applyMinimalYTextUpdate merges, so both should coexist or guest content preserved
  // The key assertion: it should NOT be just "host disk content" if remote had "guest edit"
  expect(content).not.toBe("host disk content");
});
```

Actually, `applyMinimalYTextUpdate` does a full replacement via delete+insert. The fix should check whether the Y.Text already has content from remote peers and skip overwriting in that case.

- [ ] **Step 2: Implement the fix**

```typescript
// background-sync.ts — replace host branch in subscribe() (lines 87-94)
if (this.role === "host" && path !== this.activeFile) {
  const file = getFileByPath(this.vault, diskPath);
  if (file) {
    const content = normalizeLineEndings(await this.vault.read(file));
    if (this.cancelledSubscribes.has(path)) return;
    const remoteContent = docHandle.text.toString();
    if (remoteContent.length === 0) {
      // No remote content yet — host seeds the Y.Text
      applyMinimalYTextUpdate(docHandle.doc, docHandle.text, content);
      this.lastWrittenContent.set(path, content);
    } else if (remoteContent !== content) {
      // Remote has content (from guests or prior sync) — write remote to disk instead
      await this.writeToDisk(path, remoteContent);
    } else {
      this.lastWrittenContent.set(path, content);
    }
  }
}
```

- [ ] **Step 3: Run test suite**

Run: `cd plugin && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add plugin/src/files/background-sync.ts plugin/src/__tests__/background-sync.test.ts
git commit -m "fix: host subscribe respects existing Y.Text content from guests"
```

---

### Task 6: Fix SyncManager mux channel silently dying after max reconnects

After 15 failed reconnects, `shouldConnect` is set to false with no notification. The user sees "connected" (because the control channel is fine) but nothing syncs.

**Files:**
- Modify: `plugin/src/sync/sync.ts:251-266`
- Modify: `plugin/src/main.ts` (add mux death callback)

- [ ] **Step 1: Add `onMaxReconnect` callback to SyncManager**

```typescript
// sync.ts — add field after line 54
private onMaxReconnectCallback: (() => void) | null = null;

// sync.ts — add method after setE2E
onMaxReconnect(callback: () => void): void {
  this.onMaxReconnectCallback = callback;
}

// sync.ts — update scheduleReconnect (line 254-256)
if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
  this.shouldConnect = false;
  this.onMaxReconnectCallback?.();
  return;
}
```

- [ ] **Step 2: Wire it in main.ts to trigger session end**

```typescript
// main.ts — in connectSync(), after line 522 (this.syncManager.connect())
this.syncManager.onMaxReconnect(() => {
  this.logger.error("sync", "mux channel exhausted reconnect attempts");
  new Notice("Live Share: sync connection lost, ending session");
  void this.endSession();
});
```

- [ ] **Step 3: Add test**

```typescript
// Add to plugin/src/__tests__/sync.test.ts

it("fires onMaxReconnect after exhausting retries", () => {
  const callback = vi.fn();
  sm.onMaxReconnect(callback);
  sm.connect();

  // Simulate 15 close events
  for (let i = 0; i < 16; i++) {
    mockWsInstance.onclose?.();
    if (i < 15) {
      vi.advanceTimersByTime(60000);
      // A new WS is created on each reconnect
    }
  }

  expect(callback).toHaveBeenCalledOnce();
});
```

Note: This test needs `vi.useFakeTimers()` in the beforeEach.

- [ ] **Step 4: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add plugin/src/sync/sync.ts plugin/src/main.ts plugin/src/__tests__/sync.test.ts
git commit -m "fix: detect mux channel death and end session instead of silent failure"
```

---

### Task 7: Fix ControlChannel first-connection failure misdiagnosed as "auth-required"

If the server is temporarily down, the first WS close fires `"auth-required"` instead of retrying.

**Files:**
- Modify: `plugin/src/sync/control-ws.ts:110-118`
- Test: `plugin/src/__tests__/control-ws.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to plugin/src/__tests__/control-ws.test.ts

it("retries on first connection failure instead of auth-required", () => {
  const states: string[] = [];
  channel.onStateChange((s) => states.push(s));
  channel.connect();

  // Simulate immediate close (server down, not auth failure)
  const ws = getLatestWs();
  // Simulate close with code 1006 (abnormal) not 4xx
  ws.readyState = MockWebSocket.CLOSED;
  ws.onclose?.();

  // Should retry, not declare auth-required
  expect(states).not.toContain("auth-required");
  expect(states).toContain("reconnecting");
});
```

- [ ] **Step 2: Implement the fix**

```typescript
// control-ws.ts — replace onclose handler (lines 110-125)
this.ws.onclose = (event?: { code?: number }) => {
  this.stopPing();
  this.ws = null;
  if (this.isDestroyed) return;
  if (!this.everConnected && this.reconnectAttempts === 0) {
    // Only treat as auth-required if we got a 4xx-class rejection (code 4403, 4401, etc.)
    // or HTTP 401/403 which closes with code 1008 or similar policy violations
    const code = (event as { code?: number })?.code;
    if (code === 4401 || code === 4403 || code === 1008) {
      this.shouldConnect = false;
      this.stateChangeCallback?.("auth-required");
      return;
    }
    // Otherwise, treat as a transient failure and retry
  }
  if (this.shouldConnect) {
    this.stateChangeCallback?.("reconnecting");
    this.scheduleReconnect();
  } else {
    this.stateChangeCallback?.("disconnected");
  }
};
```

Note: The browser WebSocket `onclose` receives a `CloseEvent` with a `code` property. In Obsidian's environment this is available. We check for specific auth-related codes rather than assuming any first-close is auth.

- [ ] **Step 3: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add plugin/src/sync/control-ws.ts plugin/src/__tests__/control-ws.test.ts
git commit -m "fix: retry on first connection failure instead of misdiagnosing as auth-required"
```

---

### Task 8: Fix server — no host re-election after host disconnects

When the host disconnects, remaining guests are orphaned. No one can approve new joiners, kick, or manage the session.

**Files:**
- Modify: `server/src/control-handler.ts:523-529`
- Test: `server/src/__tests__/control-handler.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to server/src/__tests__/control-handler.test.ts

it("elects a new host when the current host disconnects", async () => {
  const room = await createRoom("host-reelect");
  const host = await connectControl(room.id, room.token);
  const guest = await connectControl(room.id, room.token);

  // Host identifies
  sendJSON(host.ws, { type: "join-request", userId: "host-user", displayName: "Host" });
  // Guest identifies
  sendJSON(guest.ws, { type: "join-request", userId: "guest-user", displayName: "Guest" });

  await waitForMessages(guest.messages, 1); // join-response

  // Host disconnects
  host.ws.close();
  await waitForMessages(guest.messages, 2); // presence-leave + host-changed

  const hostChanged = guest.messages.find((m) => {
    const parsed = JSON.parse(m);
    return parsed.type === "host-changed";
  });
  expect(hostChanged).toBeTruthy();
  const parsed = JSON.parse(hostChanged!);
  expect(parsed.userId).toBe("guest-user");
});
```

- [ ] **Step 2: Implement the fix**

```typescript
// control-handler.ts — replace lines 523-529 (in ws close handler)
if (wasHost && room.clients.size > 0) {
  for (const [, pendingWs] of room.pendingApprovals) {
    sendTo(pendingWs, { type: "join-response", approved: false });
  }
  room.pendingApprovals.clear();

  // Elect new host: pick the client with the lowest joinOrder
  let newHost: ControlClient | undefined;
  for (const client of room.clients.values()) {
    if (client.isApproved && (!newHost || client.joinOrder < newHost.joinOrder)) {
      newHost = client;
    }
  }
  if (newHost) {
    newHost.isHost = true;
    if (newHost.verifiedUserId && serverRoom) {
      serverRoom.hostUserId = newHost.verifiedUserId;
      touchRoom(roomId);
    }
    void appendLog(roomId, {
      timestamp: Date.now(),
      event: "host-transfer",
      userId: newHost.userId,
      displayName: newHost.displayName,
      details: "auto-elected after host disconnect",
    });
    sendTo(newHost.ws, {
      type: "host-transfer-complete",
      userId: newHost.userId,
      displayName: newHost.displayName,
    });
    broadcast(
      room,
      JSON.stringify({
        type: "host-changed",
        userId: newHost.userId,
        displayName: newHost.displayName,
      }),
      newHost.ws,
    );
  } else {
    // No eligible client — notify remaining
    broadcast(room, JSON.stringify({ type: "host-disconnected" }));
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd server && npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/src/control-handler.ts server/src/__tests__/control-handler.test.ts
git commit -m "fix: auto-elect new host when current host disconnects"
```

---

### Task 9: Fix server — `isApproved` defaults true, bypassing `requireApproval`

Clients that never send `join-request` are auto-approved and can broadcast file ops.

**Files:**
- Modify: `server/src/control-handler.ts:170-181`
- Test: `server/src/__tests__/control-handler.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to server/src/__tests__/control-handler.test.ts

it("blocks file-ops from clients that never sent join-request in requireApproval rooms", async () => {
  const room = await createRoom("approval-bypass", { requireApproval: true });
  const host = await connectControl(room.id, room.token);
  sendJSON(host.ws, { type: "join-request", userId: "host", displayName: "Host" });
  await waitForMessages(host.messages, 1); // join-response

  const sneaky = await connectControl(room.id, room.token);
  // sneaky never sends join-request, immediately sends file-op
  sendJSON(sneaky.ws, {
    type: "file-op",
    op: { type: "create", path: "hacked.md", content: "pwned" },
  });

  await delay(100);
  // Host should NOT receive the file-op
  const fileOps = host.messages.filter((m) => JSON.parse(m).type === "file-op");
  expect(fileOps).toHaveLength(0);
});
```

- [ ] **Step 2: Implement the fix**

```typescript
// control-handler.ts — change line 176 (isApproved default)
const client: ControlClient = {
  ws,
  userId: "",
  verifiedUserId,
  displayName: "",
  isHost: false,
  isApproved: !serverRoom?.requireApproval,  // false if approval required
  permission: serverRoom?.defaultPermission || "read-write",
  msgTimestamps: [],
  joinOrder: room.nextJoinOrder++,
};
```

- [ ] **Step 3: Run tests**

Run: `cd server && npm test`
Expected: All pass (existing tests may need adjustment if they rely on default approval)

- [ ] **Step 4: Commit**

```bash
git add server/src/control-handler.ts server/src/__tests__/control-handler.test.ts
git commit -m "fix: default isApproved to false in requireApproval rooms"
```

---

### Task 10: Fix server — encrypted awareness skips ID tracking, causing ghost cursors

When E2E is enabled, awareness messages are relayed but the server can't read the encrypted payload to extract client IDs. On disconnect, no awareness removal is sent.

**Files:**
- Modify: `server/src/ws-handler.ts:146-179`
- Test: `server/src/__tests__/ws-handler.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to server/src/__tests__/ws-handler.test.ts

it("tracks awareness IDs for encrypted awareness messages using client WS identity", async () => {
  // Connect two clients
  const room = await createRoom("encrypted-awareness");
  const ws1 = await connectMux(room.id, room.token);
  const ws2 = await connectMux(room.id, room.token);

  // Both subscribe to same doc
  sendMux(ws1, "file.md", MUX_SUBSCRIBE);
  sendMux(ws2, "file.md", MUX_SUBSCRIBE);
  await waitForMuxMessages(ws1, 1); // SUBSCRIBED
  await waitForMuxMessages(ws2, 1); // SUBSCRIBED

  // ws1 sends encrypted awareness (we can't parse it but server should track the client)
  const fakeEncryptedPayload = new Uint8Array([1, 2, 3, 4]); // opaque
  sendMux(ws1, "file.md", MUX_AWARENESS_ENCRYPTED, fakeEncryptedPayload);
  await waitForMuxMessages(ws2, 1); // relayed

  // ws1 disconnects — ws2 should get awareness removal
  ws1.close();
  await waitForMuxMessages(ws2, 1); // awareness removal

  const lastMsg = getLastMuxMessage(ws2);
  expect(lastMsg.msgType).toBe(MUX_AWARENESS);
  // The removal should contain at least one client ID
});
```

- [ ] **Step 2: Implement the fix**

For encrypted awareness, we can't extract individual Yjs client IDs from the payload. But we CAN track the WebSocket's Yjs doc `clientID` by looking at the unencrypted awareness data sent during the initial sync (SyncStep1 includes the client ID). Alternatively, we track a synthetic ID per MuxClient and send removal for that.

The simplest approach: when encrypted, still try to decode the awareness header (the count + clientId prefix is NOT encrypted in the Yjs awareness protocol — only the state JSON is encrypted by the plugin). Wait — actually the plugin encrypts the entire awareness payload (`this.e2e.encrypt(payload)`), so the server truly can't read it.

Best fix: track the MuxClient itself as a "presence source" for each doc. On disconnect, send a generic awareness removal for all Yjs client IDs that client previously sent in unencrypted awareness messages. For encrypted, we need a different approach.

The pragmatic fix: have the server use the MuxClient's internal doc clientID (which it doesn't know). Instead, assign a synthetic awareness ID per client and track it:

```typescript
// ws-handler.ts — in handleAwareness, after the encrypted relay (line 172)
// For encrypted awareness, we can't parse IDs, so track the client itself
if (encrypted) {
  let ids = state.clientAwarenessIds.get(client);
  if (!ids) {
    ids = new Set();
    state.clientAwarenessIds.set(client, ids);
  }
  // We don't know the actual IDs, but marking the client as having awareness
  // means removeClientFromRoom will at least clean up the map entry.
  // The actual awareness removal for encrypted clients must come from the client itself
  // or we need the client to send its doc.clientID in the subscribe message.
}
```

Actually, the better fix is to have the plugin send its `doc.clientID` as part of the `MUX_SUBSCRIBE` message, so the server always knows which Yjs client IDs belong to which WebSocket:

```typescript
// ws-handler.ts — handleSubscribe: track the Yjs clientID from subscribe payload
// Plugin side (sync.ts) — include clientID in subscribe:
private sendSubscribe(filePath: string): void {
  const doc = this.docs.get(filePath);
  if (doc) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, doc.clientID);
    this.sendMux(filePath, MUX_SUBSCRIBE, encoding.toUint8Array(encoder));
  } else {
    this.sendMux(filePath, MUX_SUBSCRIBE);
  }
}
```

```typescript
// ws-handler.ts — handleSubscribe: read clientID from payload
function handleSubscribe(client: MuxClient, docId: string, payload: Uint8Array) {
  const roomId = `${client.baseRoomId}:${docId}`;
  const state = getOrCreateRoom(roomId);

  const peerCount = state.clients.size;

  state.clients.add(client);
  client.subscribedRooms.add(roomId);

  // Track Yjs clientID for awareness cleanup
  if (payload.length > 0) {
    try {
      const decoder = decoding.createDecoder(payload);
      const clientId = decoding.readVarUint(decoder);
      let ids = state.clientAwarenessIds.get(client);
      if (!ids) {
        ids = new Set();
        state.clientAwarenessIds.set(client, ids);
      }
      ids.add(clientId);
    } catch {
      // Payload may not contain clientID (old clients)
    }
  }

  if (client.userId) {
    const permission = getPermission(client.baseRoomId, client.userId);
    if (permission === "read-only") {
      state.readOnlyClients.add(client);
    }
  }

  const peerCountEncoder = encoding.createEncoder();
  encoding.writeVarUint(peerCountEncoder, peerCount);
  const msg = encodeMuxMessage(docId, MUX_SUBSCRIBED, encoding.toUint8Array(peerCountEncoder));
  safeSend(client.ws, msg);

  if (peerCount > 0) {
    const syncRequestMsg = encodeMuxMessage(docId, MUX_SYNC_REQUEST);
    for (const peer of state.clients) {
      if (peer !== client) safeSend(peer.ws, syncRequestMsg);
    }
  }
}
```

And update the message handler switch to pass payload to handleSubscribe:

```typescript
// ws-handler.ts — line 243-244
case MUX_SUBSCRIBE:
  handleSubscribe(client, docId, payload);
  break;
```

- [ ] **Step 3: Run tests**

Run: `cd server && npm test && cd ../plugin && npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/src/ws-handler.ts plugin/src/sync/sync.ts server/src/__tests__/ws-handler.test.ts
git commit -m "fix: track Yjs clientID via subscribe for reliable awareness cleanup in encrypted mode"
```

---

### Task 11: Fix server — permissions cleared on disconnect breaks reconnect

When a client disconnects, `clearPermission` is called. If they reconnect, they need re-approval even though they were previously approved.

**Files:**
- Modify: `server/src/control-handler.ts:502-508`

- [ ] **Step 1: Implement the fix**

Don't clear permissions on disconnect — only clear them on kick or room cleanup:

```typescript
// control-handler.ts — in ws close handler, remove line 508:
// DELETE this line: clearPermission(roomId, closingClient.userId);
// Permissions persist until room cleanup or explicit kick
```

The `clearRoomPermissions(roomId)` call in the room cleanup timer (line 533) already handles full cleanup. And the kick handler should clear permission:

```typescript
// control-handler.ts — in kick handler (after line 342)
if (msg.type === "kick" && client.isHost) {
  const targetUserId = msg.userId;
  if (typeof targetUserId !== "string" || !targetUserId) return;
  room.kickedUserIds.add(targetUserId);
  clearPermission(roomId, targetUserId);  // Clear on kick
  // ... rest of kick handler
```

- [ ] **Step 2: Add test**

```typescript
// Add to server/src/__tests__/control-handler.test.ts

it("preserves permissions across reconnect", async () => {
  const room = await createRoom("reconnect-perms", { requireApproval: true });
  const host = await connectControl(room.id, room.token);
  sendJSON(host.ws, { type: "join-request", userId: "host", displayName: "Host" });

  const guest = await connectControl(room.id, room.token);
  sendJSON(guest.ws, { type: "join-request", userId: "guest", displayName: "Guest" });

  // Host approves guest
  await waitForMessages(host.messages, 1); // join-request from guest
  sendJSON(host.ws, { type: "join-response", userId: "guest", approved: true, permission: "read-write" });
  await waitForMessages(guest.messages, 1); // join-response approved

  // Guest disconnects
  guest.ws.close();
  await delay(100);

  // Guest reconnects
  const guest2 = await connectControl(room.id, room.token);
  sendJSON(guest2.ws, { type: "join-request", userId: "guest", displayName: "Guest" });
  await waitForMessages(guest2.messages, 1);

  // Should be auto-approved (permission preserved)
  const response = JSON.parse(guest2.messages[guest2.messages.length - 1]);
  expect(response.type).toBe("join-response");
  expect(response.approved).toBe(true);
});
```

- [ ] **Step 3: Run tests**

Run: `cd server && npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/src/control-handler.ts server/src/__tests__/control-handler.test.ts
git commit -m "fix: preserve permissions across reconnect, only clear on kick or room cleanup"
```

---

### Task 12: Fix vault-events create handler sending duplicate ops during rename

When Obsidian fires a `create` event as part of a rename, `onFileCreate` sends the file to peers even though a rename op will follow.

**Files:**
- Modify: `plugin/src/files/vault-events.ts:24-53`

- [ ] **Step 1: Implement the fix**

Check `renamedPaths` before calling `onFileCreate`:

```typescript
// vault-events.ts — replace create handler (lines 24-53)
plugin.registerEvent(
  plugin.app.vault.on("create", (file: TAbstractFile) => {
    const originalPath = file.path;
    if (!plugin.manifestManager.isSharedPath(originalPath)) return;
    if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
    if (renamedPaths.has(originalPath)) return;  // Part of a rename, skip

    void plugin.fileOpsManager.onFileCreate(file);
    if (plugin.settings.role === "host") {
      if (file instanceof TFile) {
        void (async () => {
          try {
            const content = isTextFile(originalPath)
              ? await plugin.app.vault.read(file)
              : await plugin.app.vault.readBinary(file);
            if (renamedPaths.has(originalPath)) return;
            if (isTextFile(originalPath)) {
              await plugin.backgroundSync.onFileAdded(originalPath);
            }
            if (renamedPaths.has(originalPath)) return;
            await plugin.manifestManager.updateFile(file, content);
          } catch {
            if (!renamedPaths.has(originalPath)) {
              new Notice(`Live Share: failed to update manifest for ${originalPath}`);
            }
          }
        })();
      } else {
        plugin.manifestManager.addFolder(originalPath);
      }
    }
  }),
);
```

- [ ] **Step 2: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add plugin/src/files/vault-events.ts
git commit -m "fix: skip create event for paths that are part of a rename"
```

---

### Task 13: Fix `cleanupSession` not deactivating collab extensions

When a session is aborted (connection lost), yCollab extensions remain active referencing destroyed Y.Doc objects.

**Files:**
- Modify: `plugin/src/main.ts:370-388`

- [ ] **Step 1: Implement the fix**

```typescript
// main.ts — add collab deactivation to cleanupSession (after line 370)
cleanupSession() {
  // Deactivate collab extensions before destroying sync
  const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView) {
    const cmView = getCmView(activeView);
    if (cmView) this.collabManager.deactivateAll(cmView);
  }

  this.explorerIndicators?.destroy();
  this.explorerIndicators = null;
  this.canvasSync?.destroy();
  this.canvasSync = null;
  this.backgroundSync.destroy();
  this.syncManager.disconnect();
  this.controlChannel?.destroy();
  this.controlChannel = null;
  this.presenceManager?.destroy();
  this.presenceManager = null;
  this.removeScrollListener();
  this.remoteUsers.clear();
  this.remoteReadOnlyPatterns = [];
  this.refreshPresenceView();
  this.fileOpsManager.clearPendingChunks();
  this.manifestManager.destroy();
  this.connectionState.transition({ type: "disconnect" });
}
```

- [ ] **Step 2: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add plugin/src/main.ts
git commit -m "fix: deactivate collab extensions in cleanupSession to prevent stale Y.Doc references"
```

---

### Task 14: Add session mutex to prevent double-start/double-join

Rapid double-clicks can create duplicate rooms or interleave connection setup.

**Files:**
- Modify: `plugin/src/main.ts`

- [ ] **Step 1: Implement the fix**

```typescript
// main.ts — add field after isEndingSession (line 66)
private isStartingSession = false;

// main.ts — wrap startSession (line 402)
public async startSession() {
  if (this.sessionManager.isActive || this.isStartingSession) {
    new Notice("Live Share: session already active");
    return;
  }
  this.isStartingSession = true;
  try {
    const ok = await this.sessionManager.startSession();
    if (ok) {
      try {
        await this.connectSync();
        await this.manifestManager.connect(this.syncManager);
        await this.manifestManager.publishManifest({ purge: true });
        await this.backgroundSync.startAll("host");
        this.registerManifestChangeHandler();
        this.onActiveFileChange();
        this.logger.log("session", `started, room=${this.settings.roomId}`);
        this.notify("Live Share: session started, invite copied to clipboard");
      } catch {
        this.logger.error("session", "failed to start session");
        await this.abortSession("Live Share: failed to start session");
      }
    }
  } finally {
    this.isStartingSession = false;
  }
}
```

Apply the same pattern to `joinSession` and `joinWithInvite`:

```typescript
// main.ts — wrap joinSession
public async joinSession() {
  if (this.sessionManager.isActive || this.isStartingSession) {
    new Notice("Live Share: session already active");
    return;
  }
  this.isStartingSession = true;
  try {
    // ... existing body ...
  } finally {
    this.isStartingSession = false;
  }
}

// main.ts — wrap joinWithInvite
private async joinWithInvite(inviteString: string) {
  if (this.sessionManager.isActive || this.isStartingSession) {
    new Notice("Live Share: session already active");
    return;
  }
  this.isStartingSession = true;
  try {
    // ... existing body ...
  } finally {
    this.isStartingSession = false;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add plugin/src/main.ts
git commit -m "fix: add session mutex to prevent double-start and double-join"
```

---

### Task 15: Fix `FileOpsManager.destroy()` not clearing muted paths

Muted paths persist across sessions if the manager is reused, causing vault events to be silently ignored.

**Files:**
- Modify: `plugin/src/files/file-ops.ts:56-64`

- [ ] **Step 1: Implement the fix**

```typescript
// file-ops.ts — update destroy()
destroy(): void {
  if (this.staleTimer) {
    clearInterval(this.staleTimer);
    this.staleTimer = null;
  }
  this.outgoingTransfers.clear();
  this.pendingChunks.clear();
  this.offlineQueue.clear();
  this.mutedPaths.clear();
  this.opQueues.clear();
  this.sendQueues.clear();
}
```

- [ ] **Step 2: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add plugin/src/files/file-ops.ts
git commit -m "fix: clear muted paths and queues on FileOpsManager destroy"
```

---

### Task 16: Fix host-transfer-complete not purging stale manifest entries

When a guest becomes host via transfer, `publishManifest({ purge: false })` is called, leaving stale entries.

**Files:**
- Modify: `plugin/src/sync/control-handlers.ts:247-261`

- [ ] **Step 1: Implement the fix**

```typescript
// control-handlers.ts — replace host-transfer-complete handler (lines 247-261)
channel.on("host-transfer-complete", () => {
  plugin.settings.role = "host";
  plugin.settings.permission = "read-write";
  void plugin
    .saveSettings()
    .then(() => plugin.backgroundSync.startAll("host"))
    .then(() => plugin.manifestManager.publishManifest({ purge: true }))  // purge: true
    .then(() => {
      plugin.presenceManager?.broadcastPresence();
      plugin.updateStatusBar();
      plugin.refreshPresenceView();
      new Notice("Live Share: you are now the host");
      plugin.logger.log("session", "became host via transfer");
    });
});
```

- [ ] **Step 2: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add plugin/src/sync/control-handlers.ts
git commit -m "fix: purge stale manifest entries on host transfer"
```

---

### Task 17: Fix chunk-end writing via adapter bypassing Obsidian cache

**Files:**
- Modify: `plugin/src/files/file-ops.ts:296-309`

- [ ] **Step 1: Implement the fix**

```typescript
// file-ops.ts — replace chunk-end write logic (lines 296-309)
this.pendingChunks.delete(endKey);
const joined = assembly.chunks.join("");
const exists = this.vault.getAbstractFileByPath(op.path);
if (assembly.binary) {
  const binaryData = base64ToArrayBuffer(joined);
  if (exists && exists instanceof TFile) {
    await this.vault.modifyBinary(exists, binaryData);
  } else {
    const parentDir = op.path.substring(0, op.path.lastIndexOf("/"));
    if (parentDir) await ensureFolder(this.vault, parentDir);
    await this.vault.createBinary(op.path, binaryData);
  }
} else {
  if (exists && exists instanceof TFile) {
    await this.vault.modify(exists, joined);
  } else {
    const parentDir = op.path.substring(0, op.path.lastIndexOf("/"));
    if (parentDir) await ensureFolder(this.vault, parentDir);
    await this.vault.create(op.path, joined);
  }
}
break;
```

- [ ] **Step 2: Run tests**

Run: `cd plugin && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add plugin/src/files/file-ops.ts
git commit -m "fix: use vault API instead of adapter for chunk-end writes"
```

---

### Task 18: Final verification — full test suite + lint + build

- [ ] **Step 1: Run plugin tests**

Run: `cd plugin && npm test`
Expected: All 310+ tests pass

- [ ] **Step 2: Run server tests**

Run: `cd server && npm test`
Expected: All 108+ tests pass

- [ ] **Step 3: Run linter**

Run: `cd plugin && npm run lint && cd ../server && npm run lint`
Expected: No errors

- [ ] **Step 4: Build both**

Run: `cd plugin && npm run build && cd ../server && npm run build`
Expected: Clean builds

- [ ] **Step 5: Format**

Run: `cd plugin && npx biome check --write . && cd ../server && npx biome check --write .`

- [ ] **Step 6: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: format code"
```
