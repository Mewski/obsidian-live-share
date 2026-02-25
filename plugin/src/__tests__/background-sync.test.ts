import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../background-sync";

vi.mock("y-websocket", () => ({
  WebsocketProvider: vi.fn(),
}));

function createVault() {
  return {
    getAbstractFileByPath: vi.fn(() => null),
    read: vi.fn(async () => ""),
    modify: vi.fn(async () => {}),
    create: vi.fn(async () => ({})),
    getFiles: vi.fn(() => []),
    createFolder: vi.fn(async () => ({})),
  } as any;
}

function createSyncManager() {
  const docs = new Map<string, { doc: Y.Doc; text: Y.Text; provider: any }>();
  return {
    getDoc(path: string) {
      if (!docs.has(path)) {
        const doc = new Y.Doc();
        const text = doc.getText("content");
        const provider = {
          synced: true,
          once: vi.fn(),
          on: vi.fn(),
          destroy: vi.fn(),
        };
        docs.set(path, { doc, text, provider });
      }
      return docs.get(path)!;
    },
    releaseDoc(path: string) {
      const entry = docs.get(path);
      if (entry) {
        entry.provider.destroy();
        entry.doc.destroy();
        docs.delete(path);
      }
    },
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
    suppressPath: vi.fn(),
    unsuppressPath: vi.fn(),
    isPathSuppressed: vi.fn(() => false),
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

  // -----------------------------------------------------------------------
  // startAll
  // -----------------------------------------------------------------------

  it("subscribes to all text files from manifest", async () => {
    const entries = new Map([
      ["notes/hello.md", { hash: "abc", size: 5, mtime: 1 }],
      ["notes/world.md", { hash: "def", size: 5, mtime: 1 }],
      ["images/photo.png", { hash: "ghi", size: 100, mtime: 1, binary: true }],
    ]);
    manifestManager = createManifestManager(entries);
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    // Should have created docs for 2 text files, not the binary
    expect(syncManager._docs.has("notes/hello.md")).toBe(true);
    expect(syncManager._docs.has("notes/world.md")).toBe(true);
    expect(syncManager._docs.has("images/photo.png")).toBe(false);
  });

  it("host seeds empty Y.Text from vault content", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "test.md" });
    vault.read.mockResolvedValue("hello world");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    const { text } = syncManager.getDoc("test.md");
    expect(text.toString()).toBe("hello world");
  });

  it("host does not overwrite non-empty Y.Text", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "test.md" });
    vault.read.mockResolvedValue("local content");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    // Pre-populate Y.Text
    const { text } = syncManager.getDoc("test.md");
    text.insert(0, "existing remote content");

    await bg.startAll("host");

    expect(text.toString()).toBe("existing remote content");
  });

  it("guest writes remote Y.Text to vault if different from local", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    const fakeFile = { path: "test.md" };
    vault.getAbstractFileByPath.mockReturnValue(fakeFile);
    vault.read.mockResolvedValue("old content");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    // Pre-populate Y.Text with remote content
    const { text } = syncManager.getDoc("test.md");
    text.insert(0, "remote content");

    await bg.startAll("guest");
    // Flush suppression timer
    vi.advanceTimersByTime(200);

    expect(vault.modify).toHaveBeenCalledWith(fakeFile, "remote content");
  });

  // -----------------------------------------------------------------------
  // setActiveFile
  // -----------------------------------------------------------------------

  it("flushes old active file to disk on switch", async () => {
    const entries = new Map([
      ["a.md", { hash: "abc", size: 5, mtime: 1 }],
      ["b.md", { hash: "def", size: 5, mtime: 1 }],
    ]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockImplementation((p: string) => ({
      path: p,
    }));
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    // Simulate content in a.md Y.Doc
    const { text: textA } = syncManager.getDoc("a.md");
    textA.delete(0, textA.length);
    textA.insert(0, "content of A");

    bg.setActiveFile("a.md");
    // a.md is now active — no flush yet

    // Switch to b.md — should flush a.md to disk
    vault.modify.mockClear();
    bg.setActiveFile("b.md");

    expect(vault.modify).toHaveBeenCalledWith({ path: "a.md" }, "content of A");
  });

  // -----------------------------------------------------------------------
  // observer skips active file
  // -----------------------------------------------------------------------

  it("does not write to disk for the active file", async () => {
    const entries = new Map([["test.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "test.md" });
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");
    bg.setActiveFile("test.md");
    vault.modify.mockClear();

    // Simulate a remote change
    const { doc } = syncManager.getDoc("test.md");
    // Apply via a separate doc to simulate a remote transaction
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "remote edit");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    vi.advanceTimersByTime(2000);

    // Active file should NOT be written by background sync
    expect(vault.modify).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // debounced disk write for background files
  // -----------------------------------------------------------------------

  it("writes remote changes to disk after debounce", async () => {
    const entries = new Map([["bg.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "bg.md" });
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");
    // Set a different file as active so bg.md is a background file
    bg.setActiveFile("other.md");
    vault.modify.mockClear();

    // Simulate remote change
    const { doc } = syncManager.getDoc("bg.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "background edit");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    // Before debounce — no write yet
    expect(vault.modify).not.toHaveBeenCalled();

    // After debounce
    vi.advanceTimersByTime(1100);
    // Allow async to flush
    await vi.advanceTimersByTimeAsync(0);

    expect(vault.modify).toHaveBeenCalledWith({ path: "bg.md" }, "background edit");
  });

  // -----------------------------------------------------------------------
  // handleLocalTextModify
  // -----------------------------------------------------------------------

  it("host pushes local text changes into Y.Doc", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    const fakeFile = { path: "note.md", stat: { size: 20, mtime: 1 } };
    vault.getAbstractFileByPath.mockReturnValue(fakeFile);
    vault.read.mockResolvedValue("initial");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    // Now simulate an external edit
    vault.read.mockResolvedValue("updated externally");
    await bg.handleLocalTextModify("note.md");

    const { text } = syncManager.getDoc("note.md");
    expect(text.toString()).toBe("updated externally");
    expect(manifestManager.updateFile).toHaveBeenCalled();
  });

  it("handleLocalTextModify skips the active file", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "note.md" });
    vault.read.mockResolvedValue("initial");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");
    bg.setActiveFile("note.md");

    vault.read.mockResolvedValue("edited");
    await bg.handleLocalTextModify("note.md");

    const { text } = syncManager.getDoc("note.md");
    // Should still be "initial" because active file is skipped
    expect(text.toString()).toBe("initial");
  });

  it("handleLocalTextModify skips when writtenByUs", async () => {
    const entries = new Map([["note.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "note.md" });
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("host");

    // Trigger a background write to set writtenByUs
    const { doc } = syncManager.getDoc("note.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "from remote");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(0);

    // Now writtenByUs should be set (within the 100ms window)
    expect(bg.isWrittenByUs("note.md")).toBe(true);

    vault.read.mockResolvedValue("local edit during suppression");
    await bg.handleLocalTextModify("note.md");

    // Should not have pushed local content because writtenByUs
    const { text } = syncManager.getDoc("note.md");
    expect(text.toString()).toBe("from remote");
  });

  // -----------------------------------------------------------------------
  // onFileAdded / onFileRemoved
  // -----------------------------------------------------------------------

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

    // Simulate remote change — should NOT trigger a write
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

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  it("destroy flushes pending writes and cleans up", async () => {
    const entries = new Map([["flush.md", { hash: "abc", size: 5, mtime: 1 }]]);
    manifestManager = createManifestManager(entries);
    vault.getAbstractFileByPath.mockReturnValue({ path: "flush.md" });
    vault.read.mockResolvedValue("");
    bg = new BackgroundSync(vault, syncManager, manifestManager, fileOpsManager);

    await bg.startAll("guest");
    vault.modify.mockClear();

    // Simulate remote change — starts debounce timer
    const { doc } = syncManager.getDoc("flush.md");
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "pending content");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));
    remoteDoc.destroy();

    // Destroy before debounce fires — should flush immediately
    bg.destroy();

    expect(vault.modify).toHaveBeenCalledWith({ path: "flush.md" }, "pending content");
  });
});
