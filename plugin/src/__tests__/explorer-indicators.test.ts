import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockElement {
  classes: Set<string>;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
}

let elements: Map<string, MockElement>;

beforeEach(() => {
  elements = new Map();

  vi.stubGlobal("CSS", {
    escape: (value: string) => value.replace(/"/g, '\\"'),
  });

  vi.stubGlobal("document", {
    querySelector: vi.fn((selector: string) => {
      const match = selector.match(/data-path="(.+?)"/);
      if (!match) return null;
      const path = match[1].replace(/\\"/g, '"');
      if (!elements.has(path)) {
        const el: MockElement = {
          classes: new Set(),
          addClass(cls: string) {
            this.classes.add(cls);
          },
          removeClass(cls: string) {
            this.classes.delete(cls);
          },
        };
        elements.set(path, el);
      }
      return elements.get(path)!;
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const { ExplorerIndicators } = await import("../ui/explorer-indicators");

describe("ExplorerIndicators", () => {
  it("adds class to read-only file elements", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["secret.md"]);

    const el = elements.get("secret.md");
    expect(el).toBeDefined();
    expect(el!.classes.has("live-share-readonly")).toBe(true);
    indicators.destroy();
  });

  it("handles multiple files", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["a.md", "b.md"]);

    expect(elements.get("a.md")!.classes.has("live-share-readonly")).toBe(true);
    expect(elements.get("b.md")!.classes.has("live-share-readonly")).toBe(true);
    indicators.destroy();
  });

  it("removes class when updated with empty array", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["a.md"]);
    expect(elements.get("a.md")!.classes.has("live-share-readonly")).toBe(true);

    indicators.update([]);
    expect(elements.get("a.md")!.classes.has("live-share-readonly")).toBe(false);
    indicators.destroy();
  });

  it("removes classes on destroy", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["a.md", "b.md"]);
    indicators.destroy();

    expect(elements.get("a.md")!.classes.has("live-share-readonly")).toBe(false);
    expect(elements.get("b.md")!.classes.has("live-share-readonly")).toBe(false);
  });

  it("handles paths with special characters", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(['folder/file "name".md']);

    expect(document.querySelector).toHaveBeenCalled();
    indicators.destroy();
  });

  it("only adds class to new paths and removes from old ones", () => {
    const indicators = new ExplorerIndicators();
    indicators.update(["a.md", "b.md"]);
    indicators.update(["b.md", "c.md"]);

    expect(elements.get("a.md")!.classes.has("live-share-readonly")).toBe(false);
    expect(elements.get("b.md")!.classes.has("live-share-readonly")).toBe(true);
    expect(elements.get("c.md")!.classes.has("live-share-readonly")).toBe(true);
    indicators.destroy();
  });
});
