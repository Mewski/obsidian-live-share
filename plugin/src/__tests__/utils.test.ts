import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  isTextFile,
  normalizePath,
  toWsUrl,
} from "../utils";

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

describe("isTextFile", () => {
  it("returns true for markdown files", () => {
    expect(isTextFile("notes/readme.md")).toBe(true);
  });

  it("returns true for json files", () => {
    expect(isTextFile("config.json")).toBe(true);
  });

  it("returns false for image files", () => {
    expect(isTextFile("photo.png")).toBe(false);
    expect(isTextFile("image.jpg")).toBe(false);
  });

  it("returns false for files without extension", () => {
    expect(isTextFile("Makefile")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isTextFile("README.MD")).toBe(true);
    expect(isTextFile("style.CSS")).toBe(true);
  });
});

describe("arrayBufferToBase64 / base64ToArrayBuffer", () => {
  it("round-trips binary data", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const b64 = arrayBufferToBase64(original.buffer as ArrayBuffer);
    const result = new Uint8Array(base64ToArrayBuffer(b64));
    expect(result).toEqual(original);
  });

  it("handles empty buffer", () => {
    const empty = new ArrayBuffer(0);
    const b64 = arrayBufferToBase64(empty);
    const result = base64ToArrayBuffer(b64);
    expect(result.byteLength).toBe(0);
  });

  it("produces valid base64 string", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]);
    const b64 = arrayBufferToBase64(data.buffer as ArrayBuffer);
    expect(b64).toBe("SGVsbG8=");
  });

  it("round-trips large buffer", () => {
    const large = new Uint8Array(10000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const b64 = arrayBufferToBase64(large.buffer as ArrayBuffer);
    const result = new Uint8Array(base64ToArrayBuffer(b64));
    expect(result).toEqual(large);
  });
});
