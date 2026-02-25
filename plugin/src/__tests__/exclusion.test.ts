import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExclusionManager } from "../exclusion";

describe("ExclusionManager", () => {
  let manager: ExclusionManager;

  beforeEach(() => {
    manager = new ExclusionManager();
  });

  describe("default exclusion patterns", () => {
    it("excludes .obsidian/config", () => {
      expect(manager.isExcluded(".obsidian/config")).toBe(true);
    });

    it("excludes deeply nested .obsidian paths", () => {
      expect(manager.isExcluded(".obsidian/plugins/foo/main.js")).toBe(true);
    });

    it("excludes .liveshare.json (exact match)", () => {
      expect(manager.isExcluded(".liveshare.json")).toBe(true);
    });

    it("excludes .trash/deleted.md", () => {
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);
    });

    it("does not exclude a normal note file", () => {
      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });

    it("does not exclude a root-level file", () => {
      expect(manager.isExcluded("README.md")).toBe(false);
    });

    it("does not exclude a deeply nested normal file", () => {
      expect(manager.isExcluded("folder/subfolder/note.md")).toBe(false);
    });
  });

  describe("loadConfig with custom patterns", () => {
    it("merges custom exclude patterns with defaults", async () => {
      const mockVault = {
        getAbstractFileByPath: (path: string) => {
          if (path === ".liveshare.json") return { stat: {} };
          return null;
        },
        read: vi.fn(async () => JSON.stringify({ exclude: ["*.tmp", "drafts/**"] })),
      };

      await manager.loadConfig(mockVault as any);

      expect(manager.isExcluded("test.tmp")).toBe(true);
      expect(manager.isExcluded("drafts/wip.md")).toBe(true);

      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded(".liveshare.json")).toBe(true);
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);

      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });
  });

  describe("loadConfig with missing config file", () => {
    it("uses default patterns when .liveshare.json does not exist", async () => {
      const mockVault = {
        getAbstractFileByPath: () => null,
        read: vi.fn(),
      };

      await manager.loadConfig(mockVault as any);

      expect(mockVault.read).not.toHaveBeenCalled();

      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });
  });
});
