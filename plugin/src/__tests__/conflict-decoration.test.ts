import { describe, expect, it } from "vitest";
import { conflictExtension } from "../conflict-decoration";

describe("conflictExtension", () => {
  it("returns an array of extensions", () => {
    const ext = conflictExtension();
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it("returns a new instance each time", () => {
    const ext1 = conflictExtension();
    const ext2 = conflictExtension();
    expect(ext1).not.toBe(ext2);
  });
});
