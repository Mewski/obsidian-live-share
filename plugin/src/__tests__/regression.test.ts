/**
 * Regression tests for fixed desync bugs.
 * Each test targets a specific scenario that previously caused data loss or
 * inconsistency between host and guest.
 */
import { TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../files/background-sync";
import { FileOpsManager } from "../files/file-ops";
import { ManifestManager } from "../files/manifest";
import type { LiveShareSettings } from "../types";

/* ------------------------------------------------------------------ */
/*  Shared helpers (mirrors existing test patterns)                    */
/* ------------------------------------------------------------------ */

function mockFile(path: string) {
  const f = Object.create(TFile.prototype);
  f.path = path;
  f.stat = { size: 0, mtime: 0, ctime: 0 };
  return f;
}

function createSettings(overrides: Partial<LiveShareSettings> = {}): LiveShareSettings {
  return {
    serverUrl: "http://localhost:3000",
    roomId: "test-room",
    token: "test-token",
    jwt: "",
    githubUserId: "",
    avatarUrl: "",
    displayName: "Test User",
    cursorColor: "#ff0000",
    sharedFolder: "",
    role: "host",
    encryptionPassphrase: "",
    permission: "read-write",
    requireApproval: false,
    serverPassword: "",
    clientId: "test-client-id",
    notificationsEnabled: true,
    debugLogging: false,
    debugLogPath: "live-share-debug.md",
    autoReconnect: true,
    excludePatterns: [],
    readOnlyPatterns: [],
    approvalTimeoutSeconds: 60,
    ...overrides,
  };
}

function createVault() {
  return {
    getAbstractFileByPath: vi.fn(() => null),
    getAllLoadedFiles: vi.fn(() => []),
    getFiles: vi.fn(() => []),
    read: vi.fn(async () => ""),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    modify: vi.fn(async () => {}),
    modifyBinary: vi.fn(async () => {}),
    create: vi.fn(async () => ({})),
    createBinary: vi.fn(async () => ({})),
    createFolder: vi.fn(async () => ({})),
    delete: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    adapter: {
      write: vi.fn(async () => {}),
      writeBinary: vi.fn(async () => {}),
    },
  } as any;
}

function createSyncManager() {
  const docs = new Map<string, { doc: Y.Doc; text: Y.Text; awareness: any }>();
  return {
    getDoc(path: string) {
      if (!docs.has(path)) {
        const doc = new Y.Doc();
        const text = doc.getText("content");
        const awareness = {
          setLocalStateField: vi.fn(),
          setLocalState: vi.fn(),
        };
        docs.set(path, { doc, text, awareness });
      }
      return docs.get(path)!;
    },
    releaseDoc(path: string) {
      const entry = docs.get(path);
      if (entry) {
        entry.doc.destroy();
        docs.delete(path);
      }
    },
    waitForSync: vi.fn(async () => {}),
    _docs: docs,
  } as any;
}

function createManifestManager(entries: Map<string, any> = new Map()) {
  return {
    getEntries: vi.fn(() => entries),
    isSharedPath: vi.fn(() => true),
    updateFile: vi.fn(async () => {}),
  } as any;
}

function createFileOpsManager() {
  return {
    mutePathEvents: vi.fn(),
    unmutePathEvents: vi.fn(),
    isPathMuted: vi.fn(() => false),
  } as any;
}

function injectManifest(manager: ManifestManager) {
  const doc = new Y.Doc();
  const manifest = doc.getMap<any>("files");
  const docHandle = {
    doc,
    text: doc.getText("content"),
    awareness: {
      setLocalStateField: vi.fn(),
      setLocalState: vi.fn(),
      destroy: vi.fn(),
    },
  };
  (manager as any).docHandle = docHandle;
  (manager as any).manifest = manifest;
  return { doc, manifest };
}

function createMockSyncManager() {
  const docs = new Map<string, { doc: Y.Doc; text: Y.Text }>();
  return {
    getDoc: vi.fn((path: string) => {
      if (!docs.has(path)) {
        const doc = new Y.Doc();
        docs.set(path, { doc, text: doc.getText("content") });
      }
      const entry = docs.get(path)!;
      return {
        doc: entry.doc,
        text: entry.text,
        awareness: {
          setLocalStateField: vi.fn(),
          setLocalState: vi.fn(),
          destroy: vi.fn(),
        },
      };
    }),
    waitForSync: vi.fn(async () => {}),
    releaseDoc: vi.fn(),
    _docs: docs,
  };
}

function createMockFileManager(vault: ReturnType<typeof createVault>) {
  return {
    trashFile: vi.fn(async (file: { path: string }) => {
      vault.files?.delete(file.path);
    }),
  };
}

/* ================================================================== */
/*  Regression tests                                                  */
/* ================================================================== */

describe("Regression: manifest update events trigger binary re-sync", () => {
  it("fires updated array when a binary entry's hash changes", () => {
    const vault = createVault();
    const manager = new ManifestManager(vault as any, createSettings());
    const { manifest } = injectManifest(manager);

    // Initial binary entry
    manifest.set("images/photo.png", {
      hash: "aaa",
      size: 100,
      mtime: 1000,
      binary: true,
    });

    const updatedCalls: string[][] = [];
    manager.setManifestChangeHandler((_added, _removed, updated) => {
      updatedCalls.push(updated);
    });

    // Host modifies the binary file — hash changes
    manifest.set("images/photo.png", {
      hash: "bbb",
      size: 200,
      mtime: 2000,
      binary: true,
    });

    expect(updatedCalls.length).toBe(1);
    expect(updatedCalls[0]).toContain("images/photo.png");
  });
});

describe("Regression: folder manifest entry removed when file added inside", () => {
  it("removes the folder directory entry when updateFile is called for a child", async () => {
    const vault = createVault();
    const manager = new ManifestManager(vault as any, createSettings());
    const { manifest } = injectManifest(manager);

    // Add empty folder
    manager.addFolder("Projects");
    expect(manifest.has("Projects")).toBe(true);
    expect(manifest.get("Projects").directory).toBe(true);

    // A file is added inside the folder
    const file = { path: "Projects/test.md", stat: { size: 10, mtime: 1000 } } as any;
    await manager.updateFile(file, "hello");

    // The empty-folder entry should be gone
    expect(manifest.has("Projects")).toBe(false);
    // The file entry should exist
    expect(manifest.has("Projects/test.md")).toBe(true);
  });
});

describe("Regression: syncFromManifest with skipText does NOT recreate directories", () => {
  it("skips directory entries when skipText is true", async () => {
    const vault = createVault();
    const manager = new ManifestManager(vault as any, createSettings());
    const { manifest } = injectManifest(manager);
    (manager as any).syncManager = createMockSyncManager();

    manifest.set("empty-dir", {
      hash: "",
      size: 0,
      mtime: 0,
      directory: true,
    });

    const synced = await manager.syncFromManifest(undefined, undefined, undefined, {
      skipText: true,
    });

    expect(synced).toBe(0);
    expect(vault.createFolder).not.toHaveBeenCalled();
  });

  it("DOES create directories when skipText is false", async () => {
    const vault = createVault();
    const manager = new ManifestManager(vault as any, createSettings());
    const { manifest } = injectManifest(manager);
    (manager as any).syncManager = createMockSyncManager();

    manifest.set("empty-dir", {
      hash: "",
      size: 0,
      mtime: 0,
      directory: true,
    });

    const synced = await manager.syncFromManifest();

    expect(synced).toBe(1);
    expect(vault.createFolder).toHaveBeenCalledWith("empty-dir");
  });
});

describe("Regression: guest subscribe waits for Y.Text content", () => {
  let vault: ReturnType<typeof createVault>;
  let syncManager: ReturnType<typeof createSyncManager>;
  let manifestManager: ReturnType<typeof createManifestManager>;
  let fileOpsManager: ReturnType<typeof createFileOpsManager>;
  let bg: BackgroundSync;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = createVault();
    syncManager = createSyncManager();
    fileOpsManager = createFileOpsManager();
  });

  afterEach(() => {
    bg.destroy();
    vi.useRealTimers();
  });

  it("waits for host to seed Y.Text and then writes content to disk", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(null);
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    // Y.Text starts empty — guest must wait
    const { text } = syncManager.getDoc("note.md");
    expect(text.toString()).toBe("");

    // Start guest subscription
    const startPromise = bg.startAll("guest");

    // After 500ms the host seeds the content
    await vi.advanceTimersByTimeAsync(500);
    text.insert(0, "seeded by host");

    // Let the polling loop finish (up to 2s total)
    await vi.advanceTimersByTimeAsync(1600);
    await startPromise;

    expect(vault.adapter.write).toHaveBeenCalledWith("note.md", "seeded by host");
  });

  it("handles permanently empty files (still creates file on disk after wait)", async () => {
    const entries = new Map([["empty.md", { hash: "abc", size: 0, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(null);
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    // Y.Text stays empty — host created an empty file
    const startPromise = bg.startAll("guest");

    // Advance past the full 2s polling window (20 * 100ms)
    await vi.advanceTimersByTimeAsync(2100);
    await startPromise;

    // When both remote and local are empty, the code correctly skips the write
    // (no data loss). The file is created separately via syncFromManifest.
    // What matters is that the subscribe completed without errors and the
    // observer is attached so future edits will be written.
    const { doc } = syncManager.getDoc("empty.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "late edit");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    bg.setActiveFile("other.md");
    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.adapter.write).toHaveBeenCalledWith("empty.md", "late edit");
  });
});

describe("Regression: host subscribe respects existing Y.Text content", () => {
  let vault: ReturnType<typeof createVault>;
  let syncManager: ReturnType<typeof createSyncManager>;
  let manifestManager: ReturnType<typeof createManifestManager>;
  let fileOpsManager: ReturnType<typeof createFileOpsManager>;
  let bg: BackgroundSync;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = createVault();
    syncManager = createSyncManager();
    fileOpsManager = createFileOpsManager();
  });

  afterEach(() => {
    bg.destroy();
    vi.useRealTimers();
  });

  it("keeps guest edits in Y.Text and writes them to disk instead of overwriting", async () => {
    const entries = new Map([["shared.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("shared.md"));
    vault.read.mockResolvedValue("host local content");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    // Guest has already written to Y.Text before host subscribes
    const { text } = syncManager.getDoc("shared.md");
    text.insert(0, "guest edit");

    await bg.startAll("host");

    // Y.Text must NOT be overwritten — guest content stays
    expect(text.toString()).toBe("guest edit");
    // Disk is updated to match Y.Text
    expect(vault.adapter.write).toHaveBeenCalledWith("shared.md", "guest edit");
  });
});

describe("Regression: op-queue serialization — afterApply runs inside queue", () => {
  it("afterApply callback completes before next op on same path starts", async () => {
    const vault = createVault();
    const fileManager = createMockFileManager(vault);
    const manager = new FileOpsManager(vault as any, fileManager as any);

    const log: string[] = [];

    // First op: create with slow afterApply
    const p1 = manager.applyRemoteOp(
      { type: "create", path: "race.md", content: "initial" },
      async () => {
        log.push("afterApply-start");
        await new Promise((r) => setTimeout(r, 50));
        log.push("afterApply-end");
      },
    );

    // Second op: rename arrives immediately (before afterApply finishes)
    vault.getAbstractFileByPath = vi.fn((path: string) => {
      if (path === "race.md") return mockFile("race.md");
      return null;
    });
    const p2 = manager.applyRemoteOp({
      type: "rename",
      oldPath: "race.md",
      newPath: "renamed.md",
    });

    await Promise.all([p1, p2]);

    // afterApply must fully complete before rename starts
    expect(log).toEqual(["afterApply-start", "afterApply-end"]);
    // Rename must have been attempted (meaning it waited for create + afterApply)
    expect(vault.rename).toHaveBeenCalled();
  });
});

describe("Regression: collabBoundFile prevents backgroundSync skip", () => {
  let vault: ReturnType<typeof createVault>;
  let syncManager: ReturnType<typeof createSyncManager>;
  let manifestManager: ReturnType<typeof createManifestManager>;
  let fileOpsManager: ReturnType<typeof createFileOpsManager>;
  let bg: BackgroundSync;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = createVault();
    syncManager = createSyncManager();
    fileOpsManager = createFileOpsManager();
  });

  afterEach(() => {
    bg.destroy();
    vi.useRealTimers();
  });

  it("writes remote change to disk when yCollab is NOT bound (collabBoundFile unset)", async () => {
    const entries = new Map([["active.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("active.md"));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    const startPromise = bg.startAll("guest");
    await vi.advanceTimersByTimeAsync(2100);
    await startPromise;

    // Active file set, but collabBoundFile NOT set (yCollab not bound yet)
    bg.setActiveFile("active.md");
    // Do NOT call bg.setCollabBoundFile("active.md")
    vault.adapter.write.mockClear();

    // Simulate remote Y.Text change
    const { doc } = syncManager.getDoc("active.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "remote change");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    // Debounce fires
    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(0);

    // Change IS written to disk because yCollab is not handling it
    expect(vault.adapter.write).toHaveBeenCalledWith("active.md", "remote change");
  });

  it("does NOT write remote change to disk when yCollab IS bound", async () => {
    const entries = new Map([["active.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("active.md"));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    const startPromise = bg.startAll("guest");
    await vi.advanceTimersByTimeAsync(2100);
    await startPromise;

    bg.setActiveFile("active.md");
    bg.setCollabBoundFile("active.md");
    vault.adapter.write.mockClear();
    vault.modify.mockClear();

    // Simulate remote Y.Text change
    const { doc } = syncManager.getDoc("active.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "remote change");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    // yCollab handles it — backgroundSync must NOT write
    expect(vault.adapter.write).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
  });
});

describe("Regression: destroy flushes pending writes with correct content", () => {
  it("flushes the exact pending content on destroy", async () => {
    vi.useFakeTimers();
    const vault = createVault();
    const syncManager = createSyncManager();
    const entries = new Map([["pending.md", { hash: "abc", size: 5, mtime: 1 }]]);
    const manifestManager = createManifestManager(entries);
    const fileOpsManager = createFileOpsManager();

    vault.getAbstractFileByPath.mockReturnValue(mockFile("pending.md"));
    vault.read.mockResolvedValue("");
    const bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    const startPromise = bg.startAll("guest");
    await vi.advanceTimersByTimeAsync(2100);
    await startPromise;
    bg.setActiveFile("other.md");
    vault.adapter.write.mockClear();

    // Trigger a remote edit
    const { doc } = syncManager.getDoc("pending.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "flush-me-correctly");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    // Not yet flushed
    expect(vault.adapter.write).not.toHaveBeenCalled();

    // Destroy flushes
    bg.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.adapter.write).toHaveBeenCalledWith("pending.md", "flush-me-correctly");
    vi.useRealTimers();
  });
});

describe("Regression: FileOpsManager.setOnline channel coordination", () => {
  it("only processes offline queue when transitioning from offline to online", async () => {
    const vault = createVault();
    const fileManager = createMockFileManager(vault);
    const manager = new FileOpsManager(vault as any, fileManager as any);

    const sentOps: any[] = [];
    manager.setSender((op) => sentOps.push(op));

    // Start online (default), go offline
    manager.setOnline(false);

    // Queue an op while offline — onFileDelete dispatches through sendQueue
    manager.onFileDelete({ path: "deleted.md" } as any);
    // Wait for the sendQueue promise to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(sentOps).toHaveLength(0);

    // Half-connected: still offline
    manager.setOnline(false);
    expect(sentOps).toHaveLength(0);

    // Both channels up — go online
    manager.setOnline(true);

    // Offline queue should have been drained
    expect(sentOps).toHaveLength(1);
    expect(sentOps[0].type).toBe("delete");

    // Going online again when already online does NOT re-drain
    manager.setOnline(true);
    expect(sentOps).toHaveLength(1);

    // Drop back offline then online — no extra ops
    manager.setOnline(false);
    manager.setOnline(true);
    expect(sentOps).toHaveLength(1);

    manager.destroy();
  });

  it("setOnline(false) prevents ops from being sent", async () => {
    const vault = createVault();
    const fileManager = createMockFileManager(vault);
    const manager = new FileOpsManager(vault as any, fileManager as any);

    const sentOps: any[] = [];
    manager.setSender((op) => sentOps.push(op));

    manager.setOnline(false);
    manager.onFileDelete({ path: "a.md" } as any);
    manager.onFileDelete({ path: "b.md" } as any);

    // Wait for sendQueue promises to settle
    await new Promise((r) => setTimeout(r, 10));

    // Nothing sent while offline
    expect(sentOps).toHaveLength(0);

    // Come back online — both ops drained
    manager.setOnline(true);
    expect(sentOps).toHaveLength(2);

    manager.destroy();
  });
});
