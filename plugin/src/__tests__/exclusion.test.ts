import { beforeEach, describe, expect, it } from "vitest";
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

    it("does not exclude .liveshare.json by default", () => {
      expect(manager.isExcluded(".liveshare.json")).toBe(false);
    });
  });

  describe("setPatterns", () => {
    it("merges custom patterns with defaults", () => {
      manager.setPatterns(["*.tmp", "drafts/**"]);

      expect(manager.isExcluded("test.tmp")).toBe(true);
      expect(manager.isExcluded("drafts/wip.md")).toBe(true);

      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);

      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });

    it("works with an empty array (defaults only)", () => {
      manager.setPatterns([]);

      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);
      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });

    it("can be called multiple times to replace custom patterns", () => {
      manager.setPatterns(["*.tmp"]);
      expect(manager.isExcluded("test.tmp")).toBe(true);
      expect(manager.isExcluded("private/secret.md")).toBe(false);

      manager.setPatterns(["private/**"]);
      expect(manager.isExcluded("test.tmp")).toBe(false);
      expect(manager.isExcluded("private/secret.md")).toBe(true);
    });
  });
});
