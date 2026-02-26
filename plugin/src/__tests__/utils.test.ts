import { describe, expect, it, vi } from "vitest";
import {
  applyMinimalYTextUpdate,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  ensureFolder,
  getPathWarning,
  isTextFile,
  normalizeLineEndings,
  normalizePath,
  parseJwtPayload,
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

describe("normalizeLineEndings", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("converts lone CR to LF", () => {
    expect(normalizeLineEndings("a\rb\rc")).toBe("a\nb\nc");
  });

  it("handles mixed line endings", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves already-normalized content unchanged", () => {
    expect(normalizeLineEndings("a\nb\nc")).toBe("a\nb\nc");
  });

  it("handles empty string", () => {
    expect(normalizeLineEndings("")).toBe("");
  });
});

describe("applyMinimalYTextUpdate", () => {
  function createMockText(initial: string) {
    let content = initial;
    return {
      toString: () => content,
      get length() {
        return content.length;
      },
      delete(pos: number, len: number) {
        content = content.slice(0, pos) + content.slice(pos + len);
      },
      insert(pos: number, s: string) {
        content = content.slice(0, pos) + s + content.slice(pos);
      },
    };
  }

  const mockDoc = { transact: (fn: () => void) => fn() };

  it("does nothing for identical strings", () => {
    const text = createMockText("hello");
    applyMinimalYTextUpdate(mockDoc, text, "hello");
    expect(text.toString()).toBe("hello");
  });

  it("handles empty to non-empty", () => {
    const text = createMockText("");
    applyMinimalYTextUpdate(mockDoc, text, "hello");
    expect(text.toString()).toBe("hello");
  });

  it("handles non-empty to empty", () => {
    const text = createMockText("hello");
    applyMinimalYTextUpdate(mockDoc, text, "");
    expect(text.toString()).toBe("");
  });

  it("applies prefix change", () => {
    const text = createMockText("hello world");
    applyMinimalYTextUpdate(mockDoc, text, "jello world");
    expect(text.toString()).toBe("jello world");
  });

  it("applies suffix change", () => {
    const text = createMockText("hello world");
    applyMinimalYTextUpdate(mockDoc, text, "hello earth");
    expect(text.toString()).toBe("hello earth");
  });

  it("applies middle change", () => {
    const text = createMockText("hello world");
    applyMinimalYTextUpdate(mockDoc, text, "hello brave world");
    expect(text.toString()).toBe("hello brave world");
  });

  it("applies full replacement", () => {
    const text = createMockText("abc");
    applyMinimalYTextUpdate(mockDoc, text, "xyz");
    expect(text.toString()).toBe("xyz");
  });

  it("handles unicode at diff boundary", () => {
    const text = createMockText("hello 🌍 world");
    applyMinimalYTextUpdate(mockDoc, text, "hello 🌎 world");
    expect(text.toString()).toBe("hello 🌎 world");
  });
});

describe("getPathWarning", () => {
  it("returns null for clean paths", () => {
    expect(getPathWarning("folder/subfolder/file.md")).toBeNull();
    expect(getPathWarning("notes/my-note.md")).toBeNull();
  });

  it("warns about Windows reserved names", () => {
    expect(getPathWarning("folder/CON.md")).not.toBeNull();
    expect(getPathWarning("folder/PRN.txt")).not.toBeNull();
    expect(getPathWarning("folder/AUX")).not.toBeNull();
    expect(getPathWarning("NUL")).not.toBeNull();
    expect(getPathWarning("COM1.txt")).not.toBeNull();
    expect(getPathWarning("LPT1.doc")).not.toBeNull();
  });

  it("warns about invalid characters", () => {
    expect(getPathWarning("folder/<file>.md")).not.toBeNull();
    expect(getPathWarning("folder/file?.md")).not.toBeNull();
    expect(getPathWarning('folder/"file".md')).not.toBeNull();
    expect(getPathWarning("folder/file|name.md")).not.toBeNull();
    expect(getPathWarning("folder/file*.md")).not.toBeNull();
  });

  it("warns about trailing dot or space", () => {
    expect(getPathWarning("folder/file.")).not.toBeNull();
    expect(getPathWarning("folder/file ")).not.toBeNull();
  });
});

describe("ensureFolder", () => {
  it("creates nested folders", async () => {
    const created: string[] = [];
    const vault = {
      getAbstractFileByPath: vi.fn(() => null),
      createFolder: vi.fn(async (path: string) => {
        created.push(path);
      }),
    } as any;
    await ensureFolder(vault, "a/b/c");
    expect(created).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("skips already-existing folders", async () => {
    const existing = new Set(["a", "a/b"]);
    const created: string[] = [];
    const TFolder = (await import("obsidian")).TFolder;
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) => {
        if (existing.has(path)) return Object.create(TFolder.prototype);
        return null;
      }),
      createFolder: vi.fn(async (path: string) => {
        created.push(path);
      }),
    } as any;
    await ensureFolder(vault, "a/b/c");
    expect(created).toEqual(["a/b/c"]);
  });
});

describe("parseJwtPayload", () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = btoa(JSON.stringify(payload));
    return `${header}.${body}.fake-signature`;
  }

  it("parses a valid JWT", () => {
    const result = parseJwtPayload(
      makeJwt({
        sub: "123",
        username: "alice",
        displayName: "Alice",
        avatar: "https://img",
      }),
    );
    expect(result.sub).toBe("123");
    expect(result.username).toBe("alice");
    expect(result.displayName).toBe("Alice");
    expect(result.avatar).toBe("https://img");
  });

  it("parses a JWT with only required fields", () => {
    const result = parseJwtPayload(makeJwt({ sub: "456", username: "bob" }));
    expect(result.sub).toBe("456");
    expect(result.username).toBe("bob");
    expect(result.displayName).toBeUndefined();
  });

  it("throws for invalid structure (not 3 parts)", () => {
    expect(() => parseJwtPayload("not.a.valid.jwt.token")).toThrow("Invalid JWT");
    expect(() => parseJwtPayload("only-one-part")).toThrow("Invalid JWT");
  });

  it("throws for missing required fields", () => {
    expect(() => parseJwtPayload(makeJwt({ sub: "123" }))).toThrow("Invalid JWT payload");
    expect(() => parseJwtPayload(makeJwt({ username: "alice" }))).toThrow("Invalid JWT payload");
    expect(() => parseJwtPayload(makeJwt({}))).toThrow("Invalid JWT payload");
  });
});
