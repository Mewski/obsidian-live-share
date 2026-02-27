import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { ExplorerIndicators } = await import("../ui/explorer-indicators");

describe("ExplorerIndicators", () => {
  it("creates a style element on construction", () => {
    const indicators = new ExplorerIndicators();
    expect(document.createElement).toHaveBeenCalledWith("style");
    expect(document.head.appendChild).toHaveBeenCalled();
    indicators.destroy();
  });

  it("generates CSS for read-only files", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["secret.md"]);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toContain("secret.md");
    expect(styleEl.textContent).toContain("\\1F512");
    indicators.destroy();
  });

  it("handles multiple files", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["a.md", "b.md"]);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toContain("a.md");
    expect(styleEl.textContent).toContain("b.md");
    indicators.destroy();
  });

  it("clears CSS when updated with empty array", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["a.md"]);
    indicators.update([]);

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
    indicators.update(['folder/file "name".md']);

    const styleEl = [...headChildren][0];
    expect(styleEl.textContent).toContain('\\"name\\"');
    indicators.destroy();
  });
});
