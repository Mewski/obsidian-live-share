import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import type { FileCreateOp, FileDeleteOp, FileOp, FileRenameOp, LiveShareSettings } from "../types";

describe("types", () => {
  it("DEFAULT_SETTINGS has expected shape", () => {
    expect(DEFAULT_SETTINGS.serverUrl).toBe("http://localhost:4321");
    expect(DEFAULT_SETTINGS.roomId).toBe("");
    expect(DEFAULT_SETTINGS.token).toBe("");
    expect(DEFAULT_SETTINGS.displayName).toBe("Anonymous");
    expect(DEFAULT_SETTINGS.cursorColor).toMatch(/^#/);
  });

  it("FileOp union types are assignable", () => {
    const create: FileOp = { type: "create", path: "a.md", content: "" };
    const del: FileOp = { type: "delete", path: "b.md" };
    const rename: FileOp = { type: "rename", oldPath: "c.md", newPath: "d.md" };
    expect(create.type).toBe("create");
    expect(del.type).toBe("delete");
    expect(rename.type).toBe("rename");
  });
});
