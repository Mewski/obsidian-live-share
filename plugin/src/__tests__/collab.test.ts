import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("yjs", () => ({
  createRelativePositionFromTypeIndex: vi.fn((_type: any, index: number) => ({
    type: null,
    tname: null,
    item: null,
    index,
  })),
}));

vi.mock("y-codemirror.next", () => ({
  yCollab: vi.fn((_text: any, _awareness: any, _opts: any) => ["yCollab-extension"]),
}));

const reconfigureCalls: unknown[] = [];
const ofCalls: unknown[] = [];

vi.mock("@codemirror/state", () => {
  class MockCompartment {
    of(ext: unknown) {
      ofCalls.push(ext);
      return { type: "compartment-of", value: ext };
    }
    reconfigure(ext: unknown) {
      reconfigureCalls.push(ext);
      return { type: "reconfigure", value: ext };
    }
  }
  const readOnlyFacet = { of: (val: boolean) => ({ readOnly: val }) };
  const MockStateEffect = {
    define: () => ({
      of: (val: unknown) => ({ type: "state-effect", value: val }),
    }),
  };
  const MockStateField = {
    define: () => "mock-state-field",
  };
  const MockTransaction = { remote: "remote" };
  const MockRangeSet = {
    empty: [],
    of: (ranges: unknown[]) => ranges,
  };
  return {
    Compartment: MockCompartment,
    EditorState: { readOnly: readOnlyFacet },
    RangeSet: MockRangeSet,
    StateEffect: MockStateEffect,
    StateField: MockStateField,
    Transaction: MockTransaction,
  };
});

vi.mock("@codemirror/view", () => {
  class MockGutterMarker {
    range(from: number) {
      return { from, marker: this };
    }
  }
  return {
    Decoration: {
      mark: () => ({ range: () => ({}) }),
      set: () => "mock-decoration-set",
      none: "mock-decoration-none",
    },
    EditorView: {
      updateListener: { of: () => "mock-update-listener" },
      decorations: { from: () => "mock-decorations-from" },
      domEventHandlers: () => "mock-dom-event-handlers",
    },
    GutterMarker: MockGutterMarker,
    ViewPlugin: { fromClass: (cls: unknown) => ({ extension: cls }) },
    gutter: () => "mock-gutter",
  };
});

const { CollabManager } = await import("../editor/collab");

function createMockView() {
  return {
    dispatch: vi.fn(),
    state: {
      doc: {
        toString: () => "local content",
      },
      selection: {
        main: { anchor: 0, head: 0 },
      },
    },
  };
}

function createMockSyncManager(opts?: {
  returnNull?: boolean;
  textLength?: number;
}) {
  const text = {
    length: opts?.textLength ?? 0,
    insert: vi.fn(),
    delete: vi.fn(),
    toString: () => (opts?.textLength ? "remote" : ""),
  };
  const meta = new Map<string, unknown>();
  const doc = {
    transact: vi.fn((fn: () => void) => fn()),
    getMap: vi.fn(() => ({
      get: (key: string) => meta.get(key),
      set: (key: string, value: unknown) => meta.set(key, value),
    })),
  };
  const awareness = {
    setLocalStateField: vi.fn(),
    setLocalState: vi.fn(),
  };

  return {
    getDoc: vi.fn((_path: string) => {
      if (opts?.returnNull) return null;
      return { doc, text, awareness };
    }),
    waitForSync: vi.fn(async () => {}),
    _text: text,
    _doc: doc,
    _awareness: awareness,
  };
}

describe("CollabManager", () => {
  let collab: InstanceType<typeof CollabManager>;

  beforeEach(() => {
    collab = new CollabManager();
    reconfigureCalls.length = 0;
    ofCalls.length = 0;
    vi.resetAllMocks();
  });

  describe("getBaseExtension", () => {
    it("returns a base extension from the compartment", () => {
      const ext = collab.getBaseExtension();
      expect(ext).toBeDefined();
      expect(ofCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("activateForFile", () => {
    it("reconfigures to empty when filePath is null", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager();

      await collab.activateForFile(view as any, null, syncManager as any);

      expect(view.dispatch).toHaveBeenCalledOnce();
      expect(reconfigureCalls).toContainEqual([]);
    });

    it("reconfigures to empty when syncManager.getDoc returns null", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ returnNull: true });

      await collab.activateForFile(view as any, "test.md", syncManager as any);

      expect(syncManager.getDoc).toHaveBeenCalledWith("test.md");
      expect(view.dispatch).toHaveBeenCalledOnce();
      expect(reconfigureCalls).toContainEqual([]);
    });

    it("reconfigures to empty when sync times out", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager();
      syncManager.waitForSync.mockRejectedValueOnce(new Error("timeout"));

      await collab.activateForFile(view as any, "test.md", syncManager as any);

      expect(view.dispatch).toHaveBeenCalledOnce();
      expect(reconfigureCalls).toContainEqual([]);
    });

    it("seeds content from host when remote doc is empty", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 0 });

      await collab.activateForFile(view as any, "test.md", syncManager as any, "host");

      expect(syncManager._doc.transact).toHaveBeenCalled();
      expect(syncManager._text.insert).toHaveBeenCalledWith(0, "local content");
    });

    it("does not seed content when role is guest", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 0 });

      await collab.activateForFile(view as any, "test.md", syncManager as any, "guest");

      expect(syncManager._text.insert).not.toHaveBeenCalled();
    });

    it("does not seed content when role is undefined", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 0 });

      await collab.activateForFile(view as any, "test.md", syncManager as any);

      expect(syncManager._text.insert).not.toHaveBeenCalled();
    });

    it("host overwrites remote doc when content differs", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 42 });

      await collab.activateForFile(view as any, "test.md", syncManager as any, "host");

      expect(syncManager._text.delete).toHaveBeenCalledWith(0, 6);
      expect(syncManager._text.insert).toHaveBeenCalledWith(0, "local content");
    });

    it("activates yCollab extension after successful sync", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 5 });

      await collab.activateForFile(view as any, "test.md", syncManager as any, "host");

      expect(view.dispatch).toHaveBeenCalled();
      const lastReconfigure = reconfigureCalls[reconfigureCalls.length - 1] as unknown[];
      expect(lastReconfigure[0]).toBe("yCollab-extension");
    });

    it("adds readOnly extension for read-only permission", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 5 });

      await collab.activateForFile(
        view as any,
        "test.md",
        syncManager as any,
        "guest",
        "read-only",
      );

      expect(view.dispatch).toHaveBeenCalled();
      const lastReconfigure = reconfigureCalls[reconfigureCalls.length - 1] as unknown[];
      expect(lastReconfigure[0]).toBe("yCollab-extension");
      expect(lastReconfigure).toContainEqual({ readOnly: true });
    });

    it("does not add readOnly extension for read-write permission", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 5 });

      await collab.activateForFile(
        view as any,
        "test.md",
        syncManager as any,
        "guest",
        "read-write",
      );

      expect(view.dispatch).toHaveBeenCalled();
      const lastReconfigure = reconfigureCalls[reconfigureCalls.length - 1] as unknown[];
      expect(lastReconfigure[0]).toBe("yCollab-extension");
      expect(lastReconfigure).not.toContainEqual({ readOnly: true });
    });

    it("bails out if file switched during sync wait", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager();
      let resolveWait!: () => void;
      syncManager.waitForSync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveWait = resolve;
          }),
      );

      const promise = collab.activateForFile(view as any, "first.md", syncManager as any, "host");

      collab.deactivateAll(view as any);

      resolveWait();
      await promise;

      const yCollabDispatches = reconfigureCalls.filter(
        (c) => Array.isArray(c) && c.includes("yCollab-extension"),
      );
      expect(yCollabDispatches).toHaveLength(0);
    });

    it("keeps old awareness active until the new binding is ready", async () => {
      const firstView = createMockView();
      const secondView = createMockView();
      const firstSync = createMockSyncManager({ textLength: 5 });
      const secondSync = createMockSyncManager({ textLength: 5 });
      // Purpose-built structural doubles for the CodeMirror and sync-manager boundaries.
      const firstEditorView = firstView as unknown as Parameters<
        InstanceType<typeof CollabManager>["activateForFile"]
      >[0];
      const secondEditorView = secondView as unknown as Parameters<
        InstanceType<typeof CollabManager>["activateForFile"]
      >[0];
      const firstSyncManager = firstSync as unknown as Parameters<
        InstanceType<typeof CollabManager>["activateForFile"]
      >[2];
      const secondSyncManager = secondSync as unknown as Parameters<
        InstanceType<typeof CollabManager>["activateForFile"]
      >[2];
      let secondSynced = false;
      secondSync.waitForSync.mockImplementation(() =>
        vi.waitUntil(() => secondSynced, { interval: 1, timeout: 100 }).then(() => undefined),
      );

      await collab.activateForFile(firstEditorView, "first.md", firstSyncManager, "host");
      firstSync._awareness.setLocalState.mockClear();

      const transition = collab.activateForFile(
        secondEditorView,
        "second.md",
        secondSyncManager,
        "host",
      );
      await Promise.resolve();

      expect(firstSync._awareness.setLocalState).not.toHaveBeenCalled();

      secondSynced = true;
      await transition;

      expect(firstSync._awareness.setLocalState).toHaveBeenCalledWith(null);
      expect(secondSync._awareness.setLocalStateField).toHaveBeenCalledWith(
        "cursor",
        expect.any(Object),
      );
    });
  });

  describe("activateForFile with empty file path", () => {
    it("reconfigures to empty extension for empty string path", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager();

      await collab.activateForFile(view as any, "", syncManager as any);

      expect(view.dispatch).toHaveBeenCalledOnce();
      expect(reconfigureCalls).toContainEqual([]);
    });
  });

  describe("deactivateAll", () => {
    it("reconfigures compartment to empty and clears currentPath", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager();

      await collab.activateForFile(view as any, "test.md", syncManager as any);

      reconfigureCalls.length = 0;
      view.dispatch.mockClear();

      collab.deactivateAll(view as any);

      expect(view.dispatch).toHaveBeenCalledOnce();
      expect(reconfigureCalls).toContainEqual([]);
    });
  });
});
