import { describe, expect, it } from "vitest";
import { normalizePath, toWsUrl } from "../utils";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("folder\\subfolder\\file.md")).toBe("folder/subfolder/file.md");
  });

  it("leaves forward slashes unchanged", () => {
    expect(normalizePath("folder/subfolder/file.md")).toBe("folder/subfolder/file.md");
  });

  it("handles mixed slashes", () => {
    expect(normalizePath("folder\\sub/file.md")).toBe("folder/sub/file.md");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  it("handles multiple consecutive backslashes", () => {
    expect(normalizePath("a\\\\b")).toBe("a//b");
  });

  it("handles Windows-style absolute path", () => {
    expect(normalizePath("C:\\Users\\vault\\note.md")).toBe("C:/Users/vault/note.md");
  });
});

describe("toWsUrl", () => {
  it("converts http to ws", () => {
    expect(toWsUrl("http://localhost:4321")).toBe("ws://localhost:4321");
  });

  it("converts https to wss", () => {
    expect(toWsUrl("https://share.example.com")).toBe("wss://share.example.com");
  });

  it("only replaces the leading http", () => {
    expect(toWsUrl("http://example.com/http/path")).toBe("ws://example.com/http/path");
  });

  it("handles http with port", () => {
    expect(toWsUrl("http://192.168.1.1:4321")).toBe("ws://192.168.1.1:4321");
  });
});
