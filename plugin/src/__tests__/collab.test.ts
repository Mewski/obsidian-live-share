import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock y-codemirror.next
vi.mock("y-codemirror.next", () => ({
  yCollab: vi.fn((_text: any, _awareness: any) => "yCollab-extension"),
}));

// Track reconfigure calls
const reconfigureCalls: unknown[] = [];
const ofCalls: unknown[] = [];

// Mock @codemirror/state with a proper Compartment class
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
  return { Compartment: MockCompartment };
});

// Mock sync module
vi.mock("../sync", () => ({
  waitForSync: vi.fn(async () => {}),
  SyncManager: vi.fn(),
}));

// Import after mocks are set up
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
    toString: () => "remote",
  };
  const doc = {
    transact: vi.fn((fn: () => void) => fn()),
  };
  const provider = {
    awareness: { setLocalStateField: vi.fn() },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
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

    it("does not seed content when remote doc already has content", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 42 });

      await collab.activateForFile(view as any, "test.md", syncManager as any, "host");

      expect(syncManager._text.insert).not.toHaveBeenCalled();
    });

    it("activates yCollab extension after successful sync", async () => {
      const view = createMockView();
      const syncManager = createMockSyncManager({ textLength: 5 });

      await collab.activateForFile(view as any, "test.md", syncManager as any, "host");

      expect(view.dispatch).toHaveBeenCalled();
      expect(reconfigureCalls).toContainEqual("yCollab-extension");
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

      const yCollabDispatches = reconfigureCalls.filter((c) => c === "yCollab-extension");
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
