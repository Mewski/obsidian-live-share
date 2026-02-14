import { describe, it, expect, beforeEach, vi } from "vitest";
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

    it("includes a normal note file", () => {
      expect(manager.isIncluded("notes/hello.md")).toBe(true);
    });

    it("includes a root-level file", () => {
      expect(manager.isIncluded("README.md")).toBe(true);
    });

    it("includes a deeply nested normal file", () => {
      expect(manager.isIncluded("folder/subfolder/note.md")).toBe(true);
    });

    it("isIncluded is the inverse of isExcluded", () => {
      const paths = [
        ".obsidian/config",
        ".liveshare.json",
        ".trash/old.md",
        "notes/hello.md",
        "README.md",
      ];
      for (const path of paths) {
        expect(manager.isIncluded(path)).toBe(!manager.isExcluded(path));
      }
    });
  });

  describe("loadConfig with custom patterns", () => {
    it("merges custom exclude patterns with defaults", async () => {
      const mockVault = {
        getAbstractFileByPath: (path: string) => {
          if (path === ".liveshare.json") return { stat: {} };
          return null;
        },
        read: vi.fn(async () =>
          JSON.stringify({ exclude: ["*.tmp", "drafts/**"] }),
        ),
      };

      await manager.loadConfig(mockVault as any);

      // Custom patterns take effect
      expect(manager.isExcluded("test.tmp")).toBe(true);
      expect(manager.isExcluded("drafts/wip.md")).toBe(true);

      // Default patterns still apply
      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded(".liveshare.json")).toBe(true);
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);

      // Normal files still included
      expect(manager.isIncluded("notes/hello.md")).toBe(true);
    });
  });

  describe("loadConfig with missing config file", () => {
    it("uses default patterns when .liveshare.json does not exist", async () => {
      const mockVault = {
        getAbstractFileByPath: () => null,
        read: vi.fn(),
      };

      await manager.loadConfig(mockVault as any);

      // read should never have been called
      expect(mockVault.read).not.toHaveBeenCalled();

      // Defaults still work
      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isIncluded("notes/hello.md")).toBe(true);
    });
  });
});
