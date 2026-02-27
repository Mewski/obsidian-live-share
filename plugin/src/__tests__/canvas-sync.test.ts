import { TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

function createMockVault() {
  const files = new Map<string, string>();
  return {
    read: vi.fn(async (file: any) => files.get(file.path) ?? ""),
    readBinary: vi.fn(),
    adapter: {
      write: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
      }),
      writeBinary: vi.fn(),
      read: vi.fn(async (path: string) => files.get(path) ?? ""),
    },
    getAbstractFileByPath: vi.fn((path: string) => {
      if (files.has(path)) {
        const f = new TFile();
        f.path = path;
        return f;
      }
      return null;
    }),
    _files: files,
  };
}

function createMockSyncManager() {
  const docs = new Map<string, { doc: Y.Doc; text: Y.Text; awareness: unknown }>();
  return {
    getDoc(docId: string) {
      if (!docs.has(docId)) {
        const doc = new Y.Doc();
        docs.set(docId, {
          doc,
          text: doc.getText("content"),
          awareness: { setLocalStateField: vi.fn() },
        });
      }
      return docs.get(docId)!;
    },
    releaseDoc: vi.fn(),
    waitForSync: vi.fn(async () => {}),
    _docs: docs,
  };
}

function createMockFileOps() {
  return {
    mutePathEvents: vi.fn(),
    unmutePathEvents: vi.fn(),
  };
}

// We need to import after setting up the vault mock
const { CanvasSync } = await import("../canvas-sync");

describe("CanvasSync", () => {
  let vault: ReturnType<typeof createMockVault>;
  let syncManager: ReturnType<typeof createMockSyncManager>;
  let fileOps: ReturnType<typeof createMockFileOps>;
  let canvasSync: InstanceType<typeof CanvasSync>;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = createMockVault();
    syncManager = createMockSyncManager();
    fileOps = createMockFileOps();
    canvasSync = new CanvasSync(vault as any, syncManager as any, fileOps as any);
  });

  it("isCanvasFile detects .canvas extension", () => {
    expect(canvasSync.isCanvasFile("test.canvas")).toBe(true);
    expect(canvasSync.isCanvasFile("test.md")).toBe(false);
  });

  it("subscribe as host populates Y.Map from file content", async () => {
    const canvasContent = JSON.stringify({
      nodes: [
        {
          id: "n1",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          type: "text",
          text: "Hello",
        },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n1" }],
    });
    vault._files.set("test.canvas", canvasContent);

    await canvasSync.subscribe("test.canvas", "host");

    const docHandle = syncManager.getDoc("__canvas__:test.canvas");
    const nodesMap = docHandle.doc.getMap("nodes");
    const edgesMap = docHandle.doc.getMap("edges");

    expect(nodesMap.size).toBe(1);
    expect(edgesMap.size).toBe(1);
    const node = nodesMap.get("n1") as Y.Map<unknown>;
    expect(node.get("text")).toBe("Hello");
  });

  it("subscribe as guest writes Y.Map content to disk when data exists", async () => {
    // Pre-populate the Y.Map
    const docHandle = syncManager.getDoc("__canvas__:test.canvas");
    const nodesMap = docHandle.doc.getMap<Y.Map<unknown>>("nodes");
    const node = new Y.Map<unknown>();
    node.set("id", "n1");
    node.set("x", 50);
    node.set("y", 50);
    nodesMap.set("n1", node);

    await canvasSync.subscribe("test.canvas", "guest");

    // Should have written to disk
    expect(vault.adapter.write).toHaveBeenCalled();
    const writtenContent = vault.adapter.write.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].x).toBe(50);
  });

  it("isSubscribed returns true after subscribe", async () => {
    expect(canvasSync.isSubscribed("test.canvas")).toBe(false);
    vault._files.set("test.canvas", '{"nodes":[],"edges":[]}');
    await canvasSync.subscribe("test.canvas", "host");
    expect(canvasSync.isSubscribed("test.canvas")).toBe(true);
  });

  it("unsubscribe removes the subscription", async () => {
    vault._files.set("test.canvas", '{"nodes":[],"edges":[]}');
    await canvasSync.subscribe("test.canvas", "host");
    canvasSync.unsubscribe("test.canvas");

    expect(canvasSync.isSubscribed("test.canvas")).toBe(false);
    expect(syncManager.releaseDoc).toHaveBeenCalledWith("__canvas__:test.canvas");
  });

  it("handleLocalModify updates Y.Map from disk content", async () => {
    vault._files.set("test.canvas", '{"nodes":[],"edges":[]}');
    await canvasSync.subscribe("test.canvas", "host");

    // Simulate local modification
    vault._files.set(
      "test.canvas",
      JSON.stringify({
        nodes: [{ id: "new-node", x: 100, y: 200 }],
        edges: [],
      }),
    );

    await canvasSync.handleLocalModify("test.canvas");

    const docHandle = syncManager.getDoc("__canvas__:test.canvas");
    const nodesMap = docHandle.doc.getMap("nodes");
    expect(nodesMap.size).toBe(1);
    const node = nodesMap.get("new-node") as Y.Map<unknown>;
    expect(node.get("x")).toBe(100);
    expect(node.get("y")).toBe(200);
  });

  it("isRecentDiskWrite returns false initially", () => {
    expect(canvasSync.isRecentDiskWrite("test.canvas")).toBe(false);
  });

  it("destroy cleans up all subscriptions and timers", async () => {
    vault._files.set("a.canvas", '{"nodes":[],"edges":[]}');
    vault._files.set("b.canvas", '{"nodes":[],"edges":[]}');
    await canvasSync.subscribe("a.canvas", "host");
    await canvasSync.subscribe("b.canvas", "host");

    canvasSync.destroy();

    expect(canvasSync.isSubscribed("a.canvas")).toBe(false);
    expect(canvasSync.isSubscribed("b.canvas")).toBe(false);
    expect(syncManager.releaseDoc).toHaveBeenCalledTimes(2);
  });

  it("concurrent node moves merge correctly via shared Y.Doc", async () => {
    const canvasContent = JSON.stringify({
      nodes: [
        { id: "n1", x: 0, y: 0 },
        { id: "n2", x: 100, y: 100 },
      ],
      edges: [],
    });
    vault._files.set("test.canvas", canvasContent);

    await canvasSync.subscribe("test.canvas", "host");

    const docHandle = syncManager.getDoc("__canvas__:test.canvas");
    const nodesMap = docHandle.doc.getMap<Y.Map<unknown>>("nodes");

    // Simulate two concurrent updates
    docHandle.doc.transact(() => {
      const n1 = nodesMap.get("n1")!;
      n1.set("x", 50);
    });

    docHandle.doc.transact(() => {
      const n2 = nodesMap.get("n2")!;
      n2.set("y", 200);
    });

    // Both changes should be present
    const n1 = nodesMap.get("n1") as Y.Map<unknown>;
    const n2 = nodesMap.get("n2") as Y.Map<unknown>;
    expect(n1.get("x")).toBe(50);
    expect(n2.get("y")).toBe(200);
  });

  it("handles malformed canvas JSON gracefully", async () => {
    vault._files.set("bad.canvas", "not valid json");
    await canvasSync.subscribe("bad.canvas", "host");

    const docHandle = syncManager.getDoc("__canvas__:bad.canvas");
    const nodesMap = docHandle.doc.getMap("nodes");
    expect(nodesMap.size).toBe(0);
  });
});
