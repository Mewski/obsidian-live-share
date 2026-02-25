import { describe, expect, it } from "vitest";
import { safeTokenCompare } from "../util.js";

describe("safeTokenCompare", () => {
  it("returns true for identical strings", () => {
    expect(safeTokenCompare("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeTokenCompare("abc123", "xyz789")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(safeTokenCompare("short", "much-longer-string")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(safeTokenCompare("", "notempty")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(safeTokenCompare("", "")).toBe(true);
  });

  it("returns false when one string is a prefix of the other", () => {
    expect(safeTokenCompare("abc", "abcdef")).toBe(false);
  });

  it("handles unicode strings", () => {
    expect(safeTokenCompare("hello\u{1F600}", "hello\u{1F600}")).toBe(true);
    expect(safeTokenCompare("hello\u{1F600}", "hello\u{1F601}")).toBe(false);
  });
});
