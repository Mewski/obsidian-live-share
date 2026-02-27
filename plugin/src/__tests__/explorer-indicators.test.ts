import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "../types";

interface MockStyleElement {
  id: string;
  textContent: string;
  tagName: string;
  remove: ReturnType<typeof vi.fn>;
}

let headChildren: Set<MockStyleElement>;

beforeEach(() => {
  headChildren = new Set();

  vi.stubGlobal("document", {
    createElement: vi.fn((tag: string) => {
      const el: MockStyleElement = {
        id: "",
        textContent: "",
        tagName: tag.toUpperCase(),
        remove: vi.fn(() => {
          headChildren.delete(el);
        }),
      };
      return el;
    }),
    head: {
      appendChild: vi.fn((el: MockStyleElement) => {
        headChildren.add(el);
      }),
    },
    getElementById: vi.fn((id: string) => {
      for (const child of headChildren) {
        if (child.id === id) return child;
      }
      return null;
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const { ExplorerIndicators } = await import("../explorer-indicators");

describe("ExplorerIndicators", () => {
  it("creates a style element on construction", () => {
    const indicators = new ExplorerIndicators();
    expect(document.createElement).toHaveBeenCalledWith("style");
    expect(document.head.appendChild).toHaveBeenCalled();
    indicators.destroy();
  });

  it("generates CSS for read-only files", () => {
    const indicators = new ExplorerIndicators();
    const perms = new Map<string, Permission>([["secret.md", "read-only"]]);
    indicators.update(perms);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toContain("secret.md");
    expect(styleEl.textContent).toContain("\\1F512");
    indicators.destroy();
  });

  it("handles multiple files", () => {
    const indicators = new ExplorerIndicators();
    const perms = new Map<string, Permission>([
      ["a.md", "read-only"],
      ["b.md", "read-only"],
    ]);
    indicators.update(perms);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toContain("a.md");
    expect(styleEl.textContent).toContain("b.md");
    indicators.destroy();
  });

  it("does not generate CSS for read-write files", () => {
    const indicators = new ExplorerIndicators();
    const perms = new Map<string, Permission>([["normal.md", "read-write"]]);
    indicators.update(perms);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toBe("");
    indicators.destroy();
  });

  it("clears CSS when updated with empty map", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(new Map<string, Permission>([["a.md", "read-only"]]));
    indicators.update(new Map());

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toBe("");
    indicators.destroy();
  });

  it("removes style element on destroy", () => {
    const indicators = new ExplorerIndicators();
    const styleEl = [...headChildren][0];
    indicators.destroy();
    expect(styleEl.remove).toHaveBeenCalled();
  });

  it("handles paths with special characters", () => {
    const indicators = new ExplorerIndicators();
    const perms = new Map<string, Permission>([['folder/file "name".md', "read-only"]]);
    indicators.update(perms);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toContain('\\"name\\"');
    indicators.destroy();
  });
});
