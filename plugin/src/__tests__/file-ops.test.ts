import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileOpsManager } from "../file-ops";
import type { FileOp } from "../types";

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
    createBinary: vi.fn(async (path: string, _buf: ArrayBuffer) => {
      const file = { path, extension: path.split(".").pop() || "" };
      files.set(path, file);
      return file;
    }),
    modify: vi.fn(async () => {}),
    modifyBinary: vi.fn(async () => {}),
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
    readBinary: vi.fn(async () => new ArrayBuffer(8)),
    createFolder: vi.fn(async () => ({})),
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

    it("creates a folder for folder-create op", async () => {
      await manager.applyRemoteOp({
        type: "folder-create",
        path: "new-folder",
      });
      expect(vault.createFolder).toHaveBeenCalledWith("new-folder");
    });

    it("skips folder-create when folder already exists", async () => {
      vault.files.set("existing-folder", {
        path: "existing-folder",
        extension: "",
      });
      await manager.applyRemoteOp({
        type: "folder-create",
        path: "existing-folder",
      });
      expect(vault.createFolder).not.toHaveBeenCalled();
    });

    it("suppresses local broadcasts during remote apply", async () => {
      vault.create.mockImplementation(async (path: string) => {
        const file = { path, extension: "md" };
        vault.files.set(path, file);
        manager.onFileCreate(file as any);
        return file;
      });

      await manager.applyRemoteOp({
        type: "create",
        path: "remote.md",
        content: "hi",
      });

      expect(sentOps.length).toBe(0);

      manager.onFileDelete({ path: "other.md" } as any);
      await vi.waitFor(() => expect(sentOps.length).toBe(1));
    });
  });

  describe("local event handlers", () => {
    it("broadcasts file create with content", async () => {
      const file = { path: "created.md", extension: "md" } as any;
      manager.onFileCreate(file);
      await new Promise((r) => setTimeout(r, 10));
      expect(sentOps.length).toBe(1);
      expect(sentOps[0]).toEqual({
        type: "create",
        path: "created.md",
        content: "file content",
      });
    });

    it("broadcasts folder-create for folders", () => {
      const folder = { path: "my-folder" } as any;
      manager.onFileCreate(folder);
      expect(sentOps).toEqual([{ type: "folder-create", path: "my-folder" }]);
    });

    it("broadcasts file delete", async () => {
      manager.onFileDelete({ path: "deleted.md" } as any);
      await vi.waitFor(() => expect(sentOps).toEqual([{ type: "delete", path: "deleted.md" }]));
    });

    it("broadcasts file rename", async () => {
      manager.onFileRename({ path: "new-name.md" } as any, "old-name.md");
      await vi.waitFor(() =>
        expect(sentOps).toEqual([
          { type: "rename", oldPath: "old-name.md", newPath: "new-name.md" },
        ]),
      );
    });

    it("does not broadcast when no sender is set", () => {
      const mgr = new FileOpsManager(vault as any);
      mgr.onFileDelete({ path: "x.md" } as any);
    });
  });

  describe("path safety", () => {
    it("rejects absolute paths starting with /", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "/etc/passwd",
        content: "bad",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("rejects absolute paths starting with backslash", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "\\Windows\\system32\\bad",
        content: "bad",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("rejects paths with .. traversal", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "shared/../../../etc/passwd",
        content: "bad",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("rejects paths with . segment", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "shared/./hidden",
        content: "bad",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("rejects empty paths", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "",
        content: "bad",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("rejects rename with unsafe oldPath", async () => {
      await manager.applyRemoteOp({
        type: "rename",
        oldPath: "../escape.md",
        newPath: "safe.md",
      });
      expect(vault.rename).not.toHaveBeenCalled();
    });

    it("rejects rename with unsafe newPath", async () => {
      vault.files.set("safe.md", { path: "safe.md", extension: "md" });
      await manager.applyRemoteOp({
        type: "rename",
        oldPath: "safe.md",
        newPath: "/etc/evil.md",
      });
      expect(vault.rename).not.toHaveBeenCalled();
    });
  });

  describe("binary operations", () => {
    it("creates binary file from base64 content", async () => {
      await manager.applyRemoteOp({
        type: "create",
        path: "image.png",
        content: "AQID",
        binary: true,
      });
      expect(vault.createBinary).toHaveBeenCalled();
      const [path, buf] = vault.createBinary.mock.calls[0];
      expect(path).toBe("image.png");
      expect(buf instanceof ArrayBuffer).toBe(true);
    });

    it("modifies existing binary file", async () => {
      const file = { path: "image.png", extension: "png" };
      vault.files.set("image.png", file);

      await manager.applyRemoteOp({
        type: "modify",
        path: "image.png",
        content: "AQID",
        binary: true,
      });
      expect(vault.modifyBinary).toHaveBeenCalled();
    });
  });

  describe("chunk assembly", () => {
    it("assembles text chunks and creates file", async () => {
      await manager.applyRemoteOp({
        type: "chunk-start",
        path: "big.md",
        totalSize: 10,
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "big.md",
        index: 0,
        data: "Hello",
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "big.md",
        index: 1,
        data: "World",
      });
      await manager.applyRemoteOp({
        type: "chunk-end",
        path: "big.md",
      });
      expect(vault.create).toHaveBeenCalledWith("big.md", "HelloWorld");
    });

    it("assembles text chunks and modifies existing file", async () => {
      vault.files.set("big.md", { path: "big.md", extension: "md" });

      await manager.applyRemoteOp({
        type: "chunk-start",
        path: "big.md",
        totalSize: 10,
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "big.md",
        index: 0,
        data: "Hello",
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "big.md",
        index: 1,
        data: "World",
      });
      await manager.applyRemoteOp({
        type: "chunk-end",
        path: "big.md",
      });

      expect(vault.modify).toHaveBeenCalled();
    });

    it("assembles binary chunks and creates binary file", async () => {
      await manager.applyRemoteOp({
        type: "chunk-start",
        path: "big.png",
        totalSize: 6,
        binary: true,
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "big.png",
        index: 0,
        data: "AQID",
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "big.png",
        index: 1,
        data: "BAUG",
      });
      await manager.applyRemoteOp({
        type: "chunk-end",
        path: "big.png",
      });
      expect(vault.createBinary).toHaveBeenCalled();
    });

    it("ignores chunk-end without a matching chunk-start", async () => {
      await manager.applyRemoteOp({
        type: "chunk-end",
        path: "orphan.md",
      });
      expect(vault.create).not.toHaveBeenCalled();
    });

    it("rejects chunk-start for files exceeding MAX_FILE_SIZE (50MB)", async () => {
      await manager.applyRemoteOp({
        type: "chunk-start",
        path: "huge.bin",
        totalSize: 51 * 1024 * 1024,
      });
      await manager.applyRemoteOp({
        type: "chunk-data",
        path: "huge.bin",
        index: 0,
        data: "some-data",
      });
      await manager.applyRemoteOp({
        type: "chunk-end",
        path: "huge.bin",
      });
      expect(vault.create).not.toHaveBeenCalled();
      expect(vault.createBinary).not.toHaveBeenCalled();
    });
  });

  describe("error recovery", () => {
    it("decrements suppressCount even when vault operation throws", async () => {
      vault.create.mockRejectedValueOnce(new Error("disk full"));

      await manager.applyRemoteOp({
        type: "create",
        path: "fail.md",
        content: "data",
      });

      manager.onFileDelete({ path: "local.md" } as any);
      await vi.waitFor(() => expect(sentOps).toHaveLength(1));
      expect(sentOps[0].type).toBe("delete");
    });

    it("continues processing after a failed modify", async () => {
      const file = { path: "test.md", extension: "md" };
      vault.files.set("test.md", file);
      vault.modify.mockRejectedValueOnce(new Error("locked"));

      await manager.applyRemoteOp({
        type: "modify",
        path: "test.md",
        content: "updated",
      });

      await manager.applyRemoteOp({
        type: "create",
        path: "next.md",
        content: "ok",
      });
      expect(vault.create).toHaveBeenCalledWith("next.md", "ok");
    });
  });

  describe("modify operations", () => {
    it("modifies existing text file content", async () => {
      const file = { path: "doc.md", extension: "md" };
      vault.files.set("doc.md", file);

      await manager.applyRemoteOp({
        type: "modify",
        path: "doc.md",
        content: "updated content",
      });
      expect(vault.modify).toHaveBeenCalledWith(file, "updated content");
    });

    it("silently ignores modify of nonexistent file", async () => {
      await manager.applyRemoteOp({
        type: "modify",
        path: "missing.md",
        content: "x",
      });
      expect(vault.modify).not.toHaveBeenCalled();
    });
  });

  describe("local event edge cases", () => {
    it("handles binary file create (reads as binary)", async () => {
      const file = { path: "photo.png", extension: "png" } as any;
      manager.onFileCreate(file);

      await new Promise((r) => setTimeout(r, 10));
      expect(sentOps.length).toBe(1);
      expect(sentOps[0].type).toBe("create");
      expect((sentOps[0] as any).binary).toBe(true);
    });

    it("does not broadcast binary modify for text files (they use Yjs)", () => {
      const file = { path: "notes.md", extension: "md" } as any;
      manager.onFileModify(file);
      expect(sentOps.length).toBe(0);
    });

    it("broadcasts binary modify for binary files", async () => {
      const file = { path: "image.png", extension: "png" } as any;
      manager.onFileModify(file);

      await new Promise((r) => setTimeout(r, 10));
      expect(sentOps.length).toBe(1);
      expect(sentOps[0].type).toBe("modify");
      expect((sentOps[0] as any).binary).toBe(true);
    });
  });
});
