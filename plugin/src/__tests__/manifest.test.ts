import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ExclusionManager } from "../files/exclusion";
import { ManifestManager } from "../files/manifest";
import type { LiveShareSettings } from "../types";

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
    approvalTimeoutSeconds: 60,
    ...overrides,
  };
}

function createVault() {
  return {
    getFiles: vi.fn(() => []),
    getAllLoadedFiles: vi.fn(() => []),
    getAbstractFileByPath: vi.fn((): Record<string, unknown> | null => null),
    read: vi.fn(async () => ""),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    modify: vi.fn(async () => {}),
    create: vi.fn(async () => ({})),
    createFolder: vi.fn(async () => ({})),
  };
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
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),
    updateSettings: vi.fn(),
    _docs: docs,
  };
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

describe("ManifestManager", () => {
  let vault: ReturnType<typeof createVault>;

  beforeEach(() => {
    vault = createVault();
  });

  describe("isSharedPath", () => {
    describe("without shared folder", () => {
      it("considers all paths shared", () => {
        const manager = new ManifestManager(vault as any, createSettings());
        expect(manager.isSharedPath("notes/hello.md")).toBe(true);
        expect(manager.isSharedPath("deeply/nested/path/file.md")).toBe(true);
        expect(manager.isSharedPath("root.md")).toBe(true);
      });

      it("normalizes backslashes", () => {
        const manager = new ManifestManager(vault as any, createSettings());
        expect(manager.isSharedPath("folder\\file.md")).toBe(true);
      });
    });

    describe("with shared folder set", () => {
      it("includes files inside the shared folder", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "shared" }),
        );
        expect(manager.isSharedPath("shared/note.md")).toBe(true);
        expect(manager.isSharedPath("shared/sub/deep.md")).toBe(true);
      });

      it("includes the shared folder path itself", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "shared" }),
        );
        expect(manager.isSharedPath("shared")).toBe(true);
      });

      it("excludes files outside the shared folder", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "shared" }),
        );
        expect(manager.isSharedPath("other/note.md")).toBe(false);
        expect(manager.isSharedPath("root.md")).toBe(false);
      });

      it("does not match a folder that merely starts with the shared folder name", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "shared" }),
        );
        expect(manager.isSharedPath("shared-extra/file.md")).toBe(false);
      });

      it("handles shared folder with trailing slash", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "shared/" }),
        );
        expect(manager.isSharedPath("shared/note.md")).toBe(true);
        expect(manager.isSharedPath("other/note.md")).toBe(false);
      });

      it("handles backslashes in file paths", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "shared" }),
        );
        expect(manager.isSharedPath("shared\\note.md")).toBe(true);
        expect(manager.isSharedPath("other\\note.md")).toBe(false);
      });
    });

    describe("with exclusion manager", () => {
      it("excludes files matching exclusion patterns", () => {
        const manager = new ManifestManager(vault as any, createSettings());
        const exclusion = new ExclusionManager();
        manager.setExclusionManager(exclusion);

        expect(manager.isSharedPath(".obsidian/config")).toBe(false);
        expect(manager.isSharedPath(".obsidian/plugins/foo/main.js")).toBe(false);
        expect(manager.isSharedPath(".trash/deleted.md")).toBe(false);
      });

      it("allows non-excluded files", () => {
        const manager = new ManifestManager(vault as any, createSettings());
        const exclusion = new ExclusionManager();
        manager.setExclusionManager(exclusion);

        expect(manager.isSharedPath("notes/hello.md")).toBe(true);
        expect(manager.isSharedPath("README.md")).toBe(true);
      });
    });

    describe("updateSettings", () => {
      it("changes shared folder dynamically", () => {
        const manager = new ManifestManager(
          vault as any,
          createSettings({ sharedFolder: "folderA" }),
        );
        expect(manager.isSharedPath("folderA/note.md")).toBe(true);
        expect(manager.isSharedPath("folderB/note.md")).toBe(false);

        manager.updateSettings(createSettings({ sharedFolder: "folderB" }));
        expect(manager.isSharedPath("folderA/note.md")).toBe(false);
        expect(manager.isSharedPath("folderB/note.md")).toBe(true);
      });
    });
  });

  describe("updateFile", () => {
    it("adds a text file entry to the manifest", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = {
        path: "notes/hello.md",
        stat: { size: 42, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "Hello, world!");

      const entry = manifest.get("notes/hello.md");
      expect(entry).toBeDefined();
      expect(entry.hash).toBeTypeOf("string");
      expect(entry.hash.length).toBe(64);
      expect(entry.size).toBe(13);
      expect(entry.mtime).toBe(1000);
      expect(entry.binary).toBeUndefined();
    });

    it("adds a binary file entry to the manifest", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
      const file = {
        path: "images/photo.png",
        stat: { size: 5, mtime: 2000 },
      } as any;
      await manager.updateFile(file, buf);

      const entry = manifest.get("images/photo.png");
      expect(entry).toBeDefined();
      expect(entry.hash).toBeTypeOf("string");
      expect(entry.hash.length).toBe(64);
      expect(entry.size).toBe(5);
      expect(entry.mtime).toBe(2000);
      expect(entry.binary).toBe(true);
    });

    it("does not add entry for files outside the shared folder", async () => {
      const manager = new ManifestManager(vault as any, createSettings({ sharedFolder: "shared" }));
      const { manifest } = injectManifest(manager);

      const file = {
        path: "outside/file.md",
        stat: { size: 10, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "content");

      expect(manifest.size).toBe(0);
    });

    it("does nothing if manifest is not initialized", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const file = {
        path: "notes/hello.md",
        stat: { size: 42, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "Hello, world!");
    });

    it("normalizes backslashes in paths", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = {
        path: "notes\\hello.md",
        stat: { size: 5, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "Hello");

      expect(manifest.has("notes/hello.md")).toBe(true);
      expect(manifest.has("notes\\hello.md")).toBe(false);
    });
  });

  describe("hash computation", () => {
    it("produces the same hash for identical text content", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file1 = { path: "a.md", stat: { size: 5, mtime: 1000 } } as any;
      const file2 = { path: "b.md", stat: { size: 5, mtime: 2000 } } as any;

      await manager.updateFile(file1, "same content");
      await manager.updateFile(file2, "same content");

      expect(manifest.get("a.md").hash).toBe(manifest.get("b.md").hash);
    });

    it("produces different hashes for different text content", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file1 = { path: "a.md", stat: { size: 5, mtime: 1000 } } as any;
      const file2 = { path: "b.md", stat: { size: 5, mtime: 1000 } } as any;

      await manager.updateFile(file1, "content A");
      await manager.updateFile(file2, "content B");

      expect(manifest.get("a.md").hash).not.toBe(manifest.get("b.md").hash);
    });

    it("produces the same hash for identical binary content", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const bytes = new Uint8Array([10, 20, 30]);
      const buf1 = bytes.buffer.slice(0);
      const buf2 = bytes.buffer.slice(0);
      const file1 = { path: "a.png", stat: { size: 3, mtime: 1000 } } as any;
      const file2 = { path: "b.png", stat: { size: 3, mtime: 2000 } } as any;

      await manager.updateFile(file1, buf1);
      await manager.updateFile(file2, buf2);

      expect(manifest.get("a.png").hash).toBe(manifest.get("b.png").hash);
    });

    it("produces different hashes for different binary content", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const buf1 = new Uint8Array([1, 2, 3]).buffer;
      const buf2 = new Uint8Array([4, 5, 6]).buffer;
      const file1 = { path: "a.png", stat: { size: 3, mtime: 1000 } } as any;
      const file2 = { path: "b.png", stat: { size: 3, mtime: 1000 } } as any;

      await manager.updateFile(file1, buf1);
      await manager.updateFile(file2, buf2);

      expect(manifest.get("a.png").hash).not.toBe(manifest.get("b.png").hash);
    });

    it("updates hash when file content changes", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = { path: "doc.md", stat: { size: 5, mtime: 1000 } } as any;
      await manager.updateFile(file, "version 1");
      const hash1 = manifest.get("doc.md").hash;

      file.stat.mtime = 2000;
      await manager.updateFile(file, "version 2");
      const hash2 = manifest.get("doc.md").hash;

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("removeFile", () => {
    it("removes an existing file from the manifest", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = {
        path: "notes/hello.md",
        stat: { size: 5, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "Hello");
      expect(manifest.has("notes/hello.md")).toBe(true);

      manager.removeFile("notes/hello.md");
      expect(manifest.has("notes/hello.md")).toBe(false);
    });

    it("does nothing when removing a nonexistent file", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      injectManifest(manager);
      manager.removeFile("nonexistent.md");
    });

    it("does nothing when manifest is not initialized", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      manager.removeFile("anything.md");
    });

    it("normalizes backslashes when removing", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = {
        path: "notes/hello.md",
        stat: { size: 5, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "Hello");

      manager.removeFile("notes\\hello.md");
      expect(manifest.has("notes/hello.md")).toBe(false);
    });
  });

  describe("renameFile", () => {
    it("moves the manifest entry from old path to new path", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = { path: "old.md", stat: { size: 5, mtime: 1000 } } as any;
      await manager.updateFile(file, "content");
      const originalEntry = manifest.get("old.md");

      manager.renameFile("old.md", "new.md");

      expect(manifest.has("old.md")).toBe(false);
      expect(manifest.has("new.md")).toBe(true);
      expect(manifest.get("new.md").hash).toBe(originalEntry.hash);
      expect(manifest.get("new.md").size).toBe(originalEntry.size);
    });

    it("calls releaseDoc on the sync manager for the old path", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      injectManifest(manager);

      const file = { path: "old.md", stat: { size: 5, mtime: 1000 } } as any;
      await manager.updateFile(file, "content");

      const mockSyncManager = { releaseDoc: vi.fn() };
      manager.renameFile("old.md", "new.md", mockSyncManager as any);

      expect(mockSyncManager.releaseDoc).toHaveBeenCalledWith("old.md");
    });

    it("does not throw when no sync manager is provided", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      injectManifest(manager);

      const file = { path: "old.md", stat: { size: 5, mtime: 1000 } } as any;
      await manager.updateFile(file, "content");
      manager.renameFile("old.md", "new.md");
    });

    it("does nothing when old path does not exist in the manifest", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      manager.renameFile("nonexistent.md", "new.md");
      expect(manifest.has("new.md")).toBe(false);
    });

    it("does nothing when manifest is not initialized", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      manager.renameFile("old.md", "new.md");
    });

    it("normalizes backslashes in both paths", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const file = {
        path: "folder/old.md",
        stat: { size: 5, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "content");

      manager.renameFile("folder\\old.md", "folder\\new.md");

      expect(manifest.has("folder/old.md")).toBe(false);
      expect(manifest.has("folder/new.md")).toBe(true);
    });

    it("releases the normalized old path from the sync manager", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      injectManifest(manager);

      const file = {
        path: "folder/old.md",
        stat: { size: 5, mtime: 1000 },
      } as any;
      await manager.updateFile(file, "content");

      const mockSyncManager = { releaseDoc: vi.fn() };
      manager.renameFile("folder\\old.md", "folder\\new.md", mockSyncManager as any);

      expect(mockSyncManager.releaseDoc).toHaveBeenCalledWith("folder/old.md");
    });
  });

  describe("syncFromManifest path validation", () => {
    it("rejects paths starting with /", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("/etc/passwd", { hash: "abc", size: 10, mtime: 1000 });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(0);
    });

    it("rejects paths starting with backslash", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("\\Windows\\system32\\bad", {
        hash: "abc",
        size: 10,
        mtime: 1000,
      });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(0);
    });

    it("rejects paths with .. traversal", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("shared/../../../etc/passwd", {
        hash: "abc",
        size: 10,
        mtime: 1000,
      });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(0);
    });

    it("rejects paths starting with ..", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("../escape.md", { hash: "abc", size: 10, mtime: 1000 });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(0);
    });

    it("rejects empty paths", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("", { hash: "abc", size: 10, mtime: 1000 });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(0);
    });

    it("allows paths with consecutive dots in filenames", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("file..name.png", {
        hash: "abc",
        size: 10,
        mtime: 1000,
        binary: true,
      });

      const requestBinary = vi.fn();
      const synced = await manager.syncFromManifest(undefined, undefined, requestBinary);

      expect(synced).toBe(1);
      expect(requestBinary).toHaveBeenCalledWith("file..name.png");
    });

    it("skips unsafe paths and syncs only valid ones", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("/absolute.md", { hash: "a", size: 1, mtime: 1000 });
      manifest.set("../escape.md", { hash: "b", size: 1, mtime: 1000 });
      manifest.set("", { hash: "c", size: 1, mtime: 1000 });
      manifest.set("safe-binary.png", {
        hash: "d",
        size: 1,
        mtime: 1000,
        binary: true,
      });

      const requestBinary = vi.fn();
      const synced = await manager.syncFromManifest(undefined, undefined, requestBinary);

      expect(synced).toBe(1);
      expect(requestBinary).toHaveBeenCalledWith("safe-binary.png");
    });
  });

  describe("syncFromManifest skipText", () => {
    it("skips text files when skipText is true", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("notes.md", { hash: "a", size: 10, mtime: 1000 });
      manifest.set("image.png", {
        hash: "b",
        size: 20,
        mtime: 1000,
        binary: true,
      });

      const requestBinary = vi.fn();
      const synced = await manager.syncFromManifest(undefined, undefined, requestBinary, {
        skipText: true,
      });

      expect(synced).toBe(1);
      expect(requestBinary).toHaveBeenCalledWith("image.png");
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("does not skip text files when skipText is not set", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      const mockSyncManager = createMockSyncManager();
      (manager as any).syncManager = mockSyncManager;

      manifest.set("notes.md", { hash: "a", size: 10, mtime: 1000 });

      await manager.syncFromManifest(undefined, undefined, undefined, {
        skipText: false,
      });

      expect(mockSyncManager.getDoc).toHaveBeenCalledWith("notes.md");
      expect(mockSyncManager.waitForSync).toHaveBeenCalledWith("notes.md");
    });
  });

  describe("setManifestChangeHandler", () => {
    it("fires callback with added keys on new entries", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const added: string[][] = [];
      const removed: string[][] = [];
      manager.setManifestChangeHandler((a, r) => {
        added.push(a);
        removed.push(r);
      });

      manifest.set("new-file.md", { hash: "abc", size: 10, mtime: 1000 });

      expect(added.length).toBe(1);
      expect(added[0]).toContain("new-file.md");
      expect(removed[0]).toEqual([]);
    });

    it("fires callback with removed keys on deletion", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      manifest.set("file.md", { hash: "abc", size: 10, mtime: 1000 });

      const added: string[][] = [];
      const removed: string[][] = [];
      manager.setManifestChangeHandler((a, r) => {
        added.push(a);
        removed.push(r);
      });

      manifest.delete("file.md");

      expect(removed.length).toBe(1);
      expect(removed[0]).toContain("file.md");
      expect(added[0]).toEqual([]);
    });

    it("ignores update events on existing keys", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      manifest.set("file.md", { hash: "abc", size: 10, mtime: 1000 });

      const added: string[][] = [];
      manager.setManifestChangeHandler((a) => {
        added.push(a);
      });

      manifest.set("file.md", { hash: "def", size: 20, mtime: 2000 });

      expect(added.length).toBe(0);
    });

    it("replaces the previous observer when called again", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      const firstCalls: number[] = [];
      const secondCalls: number[] = [];

      manager.setManifestChangeHandler(() => firstCalls.push(1));
      manifest.set("a.md", { hash: "abc", size: 10, mtime: 1000 });
      expect(firstCalls.length).toBe(1);

      manager.setManifestChangeHandler(() => secondCalls.push(1));
      manifest.set("b.md", { hash: "def", size: 10, mtime: 1000 });

      expect(firstCalls.length).toBe(1);
      expect(secondCalls.length).toBe(1);
    });

    it("does nothing if manifest is not initialized", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      manager.setManifestChangeHandler(() => {});
    });
  });

  describe("addFolder", () => {
    it("adds a directory entry to the manifest", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      manager.addFolder("empty-dir");

      expect(manifest.has("empty-dir")).toBe(true);
      const entry = manifest.get("empty-dir");
      expect(entry.directory).toBe(true);
      expect(entry.hash).toBe("");
      expect(entry.size).toBe(0);
    });

    it("does not overwrite an existing entry", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);

      manifest.set("existing", { hash: "abc", size: 10, mtime: 1000 });
      manager.addFolder("existing");

      expect(manifest.get("existing").hash).toBe("abc");
    });

    it("does nothing when manifest is not initialized", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      manager.addFolder("folder");
    });

    it("respects sharedFolder setting", () => {
      const manager = new ManifestManager(vault as any, createSettings({ sharedFolder: "shared" }));
      const { manifest } = injectManifest(manager);

      manager.addFolder("outside");
      expect(manifest.has("outside")).toBe(false);

      manager.addFolder("shared/inside");
      expect(manifest.has("shared/inside")).toBe(true);
    });
  });

  describe("syncFromManifest directories", () => {
    it("creates directories from directory entries", async () => {
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

    it("skips directory entries that already exist locally", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      vault.getAbstractFileByPath.mockReturnValueOnce({ path: "existing-dir" });
      manifest.set("existing-dir", {
        hash: "",
        size: 0,
        mtime: 0,
        directory: true,
      });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(0);
      expect(vault.createFolder).not.toHaveBeenCalled();
    });

    it("creates nested directory paths", async () => {
      const manager = new ManifestManager(vault as any, createSettings());
      const { manifest } = injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();

      manifest.set("a/b/c", {
        hash: "",
        size: 0,
        mtime: 0,
        directory: true,
      });

      const synced = await manager.syncFromManifest();
      expect(synced).toBe(1);
      expect(vault.createFolder).toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("cleans up docHandle, manifest, syncManager, and observer", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      injectManifest(manager);
      (manager as any).syncManager = createMockSyncManager();
      manager.setManifestChangeHandler(() => {});

      manager.destroy();

      expect((manager as any).docHandle).toBeNull();
      expect((manager as any).manifest).toBeNull();
      expect((manager as any).syncManager).toBeNull();
      expect((manager as any).observer).toBeNull();
    });

    it("is safe to call multiple times", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      injectManifest(manager);

      manager.destroy();
      manager.destroy();
    });

    it("is safe to call without prior connect", () => {
      const manager = new ManifestManager(vault as any, createSettings());
      manager.destroy();
    });
  });
});
