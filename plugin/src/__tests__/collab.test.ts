import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("y-codemirror.next", () => ({
  yCollab: vi.fn((_text: any, _awareness: any) => "yCollab-extension"),
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
  return {
    Compartment: MockCompartment,
    EditorState: { readOnly: readOnlyFacet },
  };
});

vi.mock("../sync", () => ({
  waitForSync: vi.fn(async () => {}),
  SyncManager: vi.fn(),
}));

const { CollabManager } = await import("../collab");
const { waitForSync } = await import("../sync");

function createMockView() {
  return {
    dispatch: vi.fn(),
    state: {
      doc: {
        toString: () => "local content",
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
  const doc = {
    transact: vi.fn((fn: () => void) => fn()),
  };
  const provider = {
    awareness: { setLocalStateField: vi.fn(), setLocalState: vi.fn() },
    synced: true,
  };

  return {
    getDoc: vi.fn((_path: string) => {
      if (opts?.returnNull) return null;
      return { doc, text, provider };
    }),
    _text: text,
    _doc: doc,
    _provider: provider,
  };
}

describe("CollabManager", () => {
  let collab: InstanceType<typeof CollabManager>;

  beforeEach(() => {
    collab = new CollabManager();
    reconfigureCalls.length = 0;
    ofCalls.length = 0;
    vi.resetAllMocks();
    vi.mocked(waitForSync).mockResolvedValue(undefined);
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
      vi.mocked(waitForSync).mockRejectedValueOnce(new Error("timeout"));
      const view = createMockView();
      const syncManager = createMockSyncManager();

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
      expect(reconfigureCalls).toContainEqual(["yCollab-extension"]);
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
      expect(lastReconfigure).toHaveLength(2);
      expect(lastReconfigure[0]).toBe("yCollab-extension");
      expect(lastReconfigure[1]).toEqual({ readOnly: true });
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
      expect(reconfigureCalls).toContainEqual(["yCollab-extension"]);
    });

    it("bails out if file switched during sync wait", async () => {
      let resolveWait!: () => void;
      vi.mocked(waitForSync).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveWait = resolve;
          }),
      );

      const view = createMockView();
      const syncManager = createMockSyncManager();

      const promise = collab.activateForFile(view as any, "first.md", syncManager as any, "host");

      collab.deactivateAll(view as any);

      resolveWait();
      await promise;

      const yCollabDispatches = reconfigureCalls.filter(
        (c) => Array.isArray(c) && c.includes("yCollab-extension"),
      );
      expect(yCollabDispatches).toHaveLength(0);
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
