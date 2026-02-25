import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type Persistence, createLevelPersistence } from "../persistence.js";

const TEST_DB_PATH = "./data/yjs-docs-test";

describe("persistence", () => {
  it("round-trips Y.Doc state via encodeStateAsUpdate", () => {
    const doc1 = new Y.Doc();
    const text1 = doc1.getText("content");
    text1.insert(0, "persisted content");

    const update = Y.encodeStateAsUpdate(doc1);

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);
    const text2 = doc2.getText("content");

    expect(text2.toString()).toBe("persisted content");

    doc1.destroy();
    doc2.destroy();
  });

  it("preserves multiple edits across encode/decode", () => {
    const doc1 = new Y.Doc();
    const text1 = doc1.getText("content");
    text1.insert(0, "first");
    text1.insert(5, " second");
    text1.delete(0, 5); // delete "first"

    const update = Y.encodeStateAsUpdate(doc1);

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);

    expect(doc2.getText("content").toString()).toBe(" second");

    doc1.destroy();
    doc2.destroy();
  });

  it("merges concurrent edits from two docs", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const sv1 = Y.encodeStateVector(doc1);
    const sv2 = Y.encodeStateVector(doc2);
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, sv1));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, sv2));

    doc1.getText("content").insert(0, "from-1");
    doc2.getText("content").insert(0, "from-2");

    const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);

    expect(doc1.getText("content").toString()).toBe(doc2.getText("content").toString());
    const merged = doc1.getText("content").toString();
    expect(merged).toContain("from-1");
    expect(merged).toContain("from-2");

    doc1.destroy();
    doc2.destroy();
  });

  it("handles empty doc encode/decode", () => {
    const doc1 = new Y.Doc();
    const update = Y.encodeStateAsUpdate(doc1);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);
    expect(doc2.getText("content").toString()).toBe("");
    doc1.destroy();
    doc2.destroy();
  });

  it("LevelDB persistence round-trips Y.Doc state", async () => {
    const dbPath = `${TEST_DB_PATH}-roundtrip`;
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true });

    let persistence: Persistence | null = null;
    try {
      persistence = createLevelPersistence(dbPath);

      // Create and persist a doc with content
      const doc1 = new Y.Doc();
      doc1.getText("content").insert(0, "persisted via LevelDB");
      await persistence.persistDoc("test-doc", doc1);
      doc1.destroy();

      // Load into a fresh doc and verify content
      const doc2 = new Y.Doc();
      await persistence.loadDoc("test-doc", doc2);
      expect(doc2.getText("content").toString()).toBe("persisted via LevelDB");
      doc2.destroy();
    } finally {
      if (persistence) await persistence.close();
      if (existsSync(dbPath)) rmSync(dbPath, { recursive: true });
    }
  });

  it("loadRooms returns empty array when no rooms stored", async () => {
    const dbPath = `${TEST_DB_PATH}-empty-rooms`;
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true });

    let persistence: Persistence | null = null;
    try {
      persistence = createLevelPersistence(dbPath);

      const rooms = await persistence.loadRooms();
      expect(rooms).toEqual([]);
    } finally {
      if (persistence) await persistence.close();
      if (existsSync(dbPath)) rmSync(dbPath, { recursive: true });
    }
  });
});
