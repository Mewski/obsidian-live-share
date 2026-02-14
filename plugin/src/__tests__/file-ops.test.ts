import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileOpsManager } from "../file-ops";
import type { FileOp } from "../types";

// Minimal Vault mock
function createMockVault() {
  const files = new Map<string, { path: string; extension: string }>();

  return {
    files,
    getAbstractFileByPath(path: string) {
      return files.get(path) ?? null;
    },
    create: vi.fn(async (path: string, _content: string) => {
      const file = { path, extension: path.split(".").pop() || "" };
      files.set(path, file);
      return file;
    }),
    delete: vi.fn(async (file: { path: string }) => {
      files.delete(file.path);
    }),
    trash: vi.fn(async (file: { path: string }) => {
      files.delete(file.path);
    }),
    rename: vi.fn(async (file: { path: string }, newPath: string) => {
      files.delete(file.path);
      file.path = newPath;
      files.set(newPath, file as { path: string; extension: string });
    }),
    read: vi.fn(async () => "file content"),
  };
}

describe("FileOpsManager", () => {
  let vault: ReturnType<typeof createMockVault>;
  let manager: FileOpsManager;
  let sentOps: FileOp[];

  beforeEach(() => {
    vault = createMockVault();
    manager = new FileOpsManager(vault as any);
    sentOps = [];
    manager.setSender((op) => sentOps.push(op));
  });

  describe("applyRemoteOp", () => {
    it("creates a file that does not exist", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "new.md",
        content: "# New",
      });
      expect(vault.create).toHaveBeenCalledWith("new.md", "# New");
    });

    it("skips creation if file already exists", async () => {
      vault.files.set("existing.md", { path: "existing.md", extension: "md" });
      await manager.applyRemoteOp({
        type: "create",
        path: "existing.md",
        content: "x",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("moves deleted file to trash", async () => {
      const file = { path: "bye.md", extension: "md" };
      vault.files.set("bye.md", file);
      await manager.applyRemoteOp({ type: "delete", path: "bye.md" });
      expect(vault.trash).toHaveBeenCalledWith(file, true);
    });

    it("silently ignores delete of nonexistent file", async () => {
      await manager.applyRemoteOp({ type: "delete", path: "nope.md" });
      expect(vault.trash).not.toHaveBeenCalled();
    });

    it("renames an existing file", async () => {
      const file = { path: "old.md", extension: "md" };
      vault.files.set("old.md", file);
      await manager.applyRemoteOp({
        type: "rename",
        oldPath: "old.md",
        newPath: "new.md",
      });
      expect(vault.rename).toHaveBeenCalledWith(file, "new.md");
    });

    it("silently ignores rename of nonexistent file", async () => {
      await manager.applyRemoteOp({
        type: "rename",
        oldPath: "gone.md",
        newPath: "x.md",
      });
      expect(vault.rename).not.toHaveBeenCalled();
    });

    it("suppresses local broadcasts during remote apply", async () => {
      // Make vault.create trigger onFileCreate synchronously (simulating Obsidian behavior)
      vault.create.mockImplementation(async (path: string) => {
        const file = { path, extension: "md" };
        vault.files.set(path, file);
        // This simulates the vault event firing during the create call
        manager.onFileCreate(file as any);
        return file;
      });

      await manager.applyRemoteOp({
        type: "create",
        path: "remote.md",
        content: "hi",
      });

      // The onFileCreate during applyRemoteOp should have been suppressed
      expect(sentOps.length).toBe(0);

      // After applyRemoteOp, suppress is off — local events should go through
      manager.onFileDelete({ path: "other.md" } as any);
      expect(sentOps.length).toBe(1);
    });
  });

  describe("local event handlers", () => {
    it("broadcasts file create with content", async () => {
      const file = { path: "created.md", extension: "md" } as any;
      manager.onFileCreate(file);

      // read is async, wait a tick
      await new Promise((r) => setTimeout(r, 10));

      expect(sentOps.length).toBe(1);
      expect(sentOps[0]).toEqual({
        type: "create",
        path: "created.md",
        content: "file content",
      });
    });

    it("does not broadcast folder creation", () => {
      // Folders don't have 'extension' property
      const folder = { path: "my-folder" } as any;
      manager.onFileCreate(folder);
      expect(sentOps.length).toBe(0);
    });

    it("broadcasts file delete", () => {
      manager.onFileDelete({ path: "deleted.md" } as any);
      expect(sentOps).toEqual([{ type: "delete", path: "deleted.md" }]);
    });

    it("broadcasts file rename", () => {
      manager.onFileRename({ path: "new-name.md" } as any, "old-name.md");
      expect(sentOps).toEqual([{ type: "rename", oldPath: "old-name.md", newPath: "new-name.md" }]);
    });

    it("does not broadcast when no sender is set", () => {
      const mgr = new FileOpsManager(vault as any);
      // No setSender called
      mgr.onFileDelete({ path: "x.md" } as any);
      // Should not throw, just silently skip
    });
  });
});
