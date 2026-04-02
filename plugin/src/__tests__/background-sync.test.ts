import { TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../files/background-sync";

function mockFile(path: string) {
  const f = Object.create(TFile.prototype);
  f.path = path;
  f.stat = { size: 0, mtime: 0, ctime: 0 };
  return f;
}

function createVault() {
  return {
    getAbstractFileByPath: vi.fn(() => null),
    read: vi.fn(async () => ""),
    modify: vi.fn(async () => {}),
    create: vi.fn(async () => ({})),
    getFiles: vi.fn(() => []),
    createFolder: vi.fn(async () => ({})),
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

describe("BackgroundSync", () => {
  let vault: ReturnType<typeof createVault>;
  let syncManager: ReturnType<typeof createSyncManager>;
  let manifestManager: ReturnType<typeof createManifestManager>;
  let fileOpsManager: ReturnType<typeof createFileOpsManager>;
  let bg: BackgroundSync;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = createVault();
    syncManager = createSyncManager();
    manifestManager = createManifestManager();
    fileOpsManager = createFileOpsManager();
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);
  });

  afterEach(() => {
    bg.destroy();
    vi.useRealTimers();
  });

  it("subscribes to all text files from manifest", async () => {
    const entries = new Map([
      ["notes/hello.md", { hash: "abc", size: 5, mtime: 1 }],
      ["notes/world.md", { hash: "def", size: 5, mtime: 1 }],
      ["images/photo.png", { hash: "ghi", size: 100, mtime: 1, binary: true }],
    ]);
    manifestManager = createManifestManager(entries);
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    expect(syncManager._docs.has("notes/hello.md")).toBe(true);
    expect(syncManager._docs.has("notes/world.md")).toBe(true);
    expect(syncManager._docs.has("images/photo.png")).toBe(false);
  });

  it("host seeds empty Y.Text from vault content", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("test.md"));
    vault.read.mockResolvedValue("hello world");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    const { text } = syncManager.getDoc("test.md");
    expect(text.toString()).toBe("hello world");
  });

  it("host respects existing Y.Text from guests instead of overwriting", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("test.md"));
    vault.read.mockResolvedValue("local content");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    const { text } = syncManager.getDoc("test.md");
    text.insert(0, "existing remote content");

    await bg.startAll("host");

    // Y.Text keeps remote content — host does NOT overwrite it
    expect(text.toString()).toBe("existing remote content");
    // Instead the remote content is written to disk
    expect(vault.adapter.write).toHaveBeenCalledWith("test.md", "existing remote content");
  });

  it("guest writes remote Y.Text to vault if different from local", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    const fakeFile = mockFile("test.md");
    vault.getAbstractFileByPath.mockReturnValue(fakeFile);
    vault.read.mockResolvedValue("old content");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    const { text } = syncManager.getDoc("test.md");
    text.insert(0, "remote content");

    await bg.startAll("guest");
    vi.advanceTimersByTime(200);

    expect(vault.adapter.write).toHaveBeenCalledWith("test.md", "remote content");
  });

  it("flushes old active file to disk on switch", async () => {
    const entries = new Map([
      ["a.md", { hash: "abc", size: 5, mtime: 1 }],
      ["b.md", { hash: "def", size: 5, mtime: 1 }],
    ]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockImplementation((p: string) => mockFile(p));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    const { text: textA } = syncManager.getDoc("a.md");
    textA.delete(0, textA.length);
    textA.insert(0, "content of A");

    bg.setActiveFile("a.md");

    vault.adapter.write.mockClear();
    bg.setActiveFile("b.md");
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.adapter.write).toHaveBeenCalledWith("a.md", "content of A");
  });

  it("does not write to disk for the active file", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("test.md"));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");
    bg.setActiveFile("test.md");
    vault.modify.mockClear();

    const { doc } = syncManager.getDoc("test.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "remote edit");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    vi.advanceTimersByTime(2000);

    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("writes remote changes to disk after debounce", async () => {
    const entries = new Map([["bg.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("bg.md"));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");
    bg.setActiveFile("other.md");
    vault.modify.mockClear();

    const { doc } = syncManager.getDoc("bg.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "background edit");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    expect(vault.modify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.adapter.write).toHaveBeenCalledWith("bg.md", "background edit");
  });

  it("host pushes local text changes into Y.Doc", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    const fakeFile = mockFile("note.md");
    vault.getAbstractFileByPath.mockReturnValue(fakeFile);
    vault.read.mockResolvedValue("initial");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    vault.read.mockResolvedValue("updated externally");
    await bg.handleLocalTextModify("note.md");

    const { text } = syncManager.getDoc("note.md");
    expect(text.toString()).toBe("updated externally");
    expect(manifestManager.updateFile).toHaveBeenCalled();
  });

  it("handleLocalTextModify skips the active file", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("note.md"));
    vault.read.mockResolvedValue("initial");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");
    bg.setActiveFile("note.md");

    vault.read.mockResolvedValue("edited");
    await bg.handleLocalTextModify("note.md");

    const { text } = syncManager.getDoc("note.md");
    expect(text.toString()).toBe("initial");
  });

  it("handleLocalTextModify skips when writtenByUs", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("note.md"));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    const { doc } = syncManager.getDoc("note.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "from remote");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(0);

    expect(bg.isRecentDiskWrite("note.md")).toBe(true);

    vault.read.mockResolvedValue("local edit during suppression");
    await bg.handleLocalTextModify("note.md");

    const { text } = syncManager.getDoc("note.md");
    expect(text.toString()).toBe("from remote");
  });

  it("onFileAdded subscribes a new text file", async () => {
    vault.getAbstractFileByPath.mockReturnValue(null);
    await bg.onFileAdded("new-file.md");

    expect(syncManager._docs.has("new-file.md")).toBe(true);
  });

  it("onFileAdded ignores binary files", async () => {
    await bg.onFileAdded("photo.png");
    expect(syncManager._docs.has("photo.png")).toBe(false);
  });

  it("onFileRemoved cleans up observer", async () => {
    const entries = new Map([["rm.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");

    bg.onFileRemoved("rm.md");

    vault.modify.mockClear();
    const { doc } = syncManager.getDoc("rm.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "after removal");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("destroy flushes pending debounced writes to disk", async () => {
    const entries = new Map([["flush.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue(mockFile("flush.md"));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");
    bg.setActiveFile("other.md");
    vault.adapter.write.mockClear();

    const { doc } = syncManager.getDoc("flush.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "pending content");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    // Debounced write is scheduled but not yet executed
    expect(vault.adapter.write).not.toHaveBeenCalled();

    // destroy() should flush the pending write immediately
    bg.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.adapter.write).toHaveBeenCalledWith("flush.md", "pending content");
  });
});
