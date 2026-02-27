import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CommentManager } from "../comments";

function createMockSyncManager() {
  const docs = new Map<string, { doc: Y.Doc; text: Y.Text; awareness: unknown }>();
  return {
    getDoc(docId: string) {
      if (!docs.has(docId)) {
        const doc = new Y.Doc();
        docs.set(docId, {
          doc,
          text: doc.getText("content"),
          awareness: { setLocalStateField: vi.fn() },
        });
      }
      return docs.get(docId)!;
    },
    releaseDoc: vi.fn(),
    waitForSync: vi.fn(async () => {}),
    _docs: docs,
  };
}

describe("CommentManager", () => {
  let syncManager: ReturnType<typeof createMockSyncManager>;
  let manager: CommentManager;

  beforeEach(() => {
    syncManager = createMockSyncManager();
    manager = new CommentManager(syncManager as any, "user-1", "Alice");
  });

  it("subscribeFile creates a doc subscription", () => {
    manager.subscribeFile("notes.md");
    expect(syncManager.getDoc("__comments__:notes.md")).toBeDefined();
  });

  it("addComment creates a comment with correct fields", () => {
    manager.subscribeFile("notes.md");
    manager.addComment("notes.md", 5, "Great point!");

    const comments = manager.getComments("notes.md");
    expect(comments).toHaveLength(1);
    expect(comments[0].anchorIndex).toBe(5);
    expect(comments[0].text).toBe("Great point!");
    expect(comments[0].author).toBe("Alice");
    expect(comments[0].authorId).toBe("user-1");
    expect(comments[0].resolved).toBe(false);
    expect(comments[0].replies).toEqual([]);
    expect(comments[0].id).toBeTruthy();
    expect(comments[0].timestamp).toBeGreaterThan(0);
  });

  it("getComments returns all comments for a file", () => {
    manager.subscribeFile("notes.md");
    manager.addComment("notes.md", 1, "First");
    manager.addComment("notes.md", 5, "Second");
    manager.addComment("notes.md", 10, "Third");

    const comments = manager.getComments("notes.md");
    expect(comments).toHaveLength(3);
    expect(comments.map((c) => c.text)).toEqual(["First", "Second", "Third"]);
  });

  it("getComments returns empty array for unsubscribed file", () => {
    const comments = manager.getComments("unknown.md");
    expect(comments).toEqual([]);
  });

  it("resolveComment toggles resolved flag", () => {
    manager.subscribeFile("notes.md");
    manager.addComment("notes.md", 1, "Todo");

    const [comment] = manager.getComments("notes.md");
    expect(comment.resolved).toBe(false);

    manager.resolveComment("notes.md", comment.id);
    expect(manager.getComments("notes.md")[0].resolved).toBe(true);

    manager.resolveComment("notes.md", comment.id);
    expect(manager.getComments("notes.md")[0].resolved).toBe(false);
  });

  it("deleteComment removes a comment", () => {
    manager.subscribeFile("notes.md");
    manager.addComment("notes.md", 1, "Keep");
    manager.addComment("notes.md", 2, "Remove");

    const comments = manager.getComments("notes.md");
    const toDelete = comments.find((c) => c.text === "Remove")!;
    manager.deleteComment("notes.md", toDelete.id);

    const remaining = manager.getComments("notes.md");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("Keep");
  });

  it("addReply adds a reply to a comment", () => {
    manager.subscribeFile("notes.md");
    manager.addComment("notes.md", 1, "Question?");

    const [comment] = manager.getComments("notes.md");
    manager.addReply("notes.md", comment.id, "Answer!");

    const updated = manager.getComments("notes.md");
    expect(updated[0].replies).toHaveLength(1);
    expect(updated[0].replies[0].text).toBe("Answer!");
    expect(updated[0].replies[0].author).toBe("Alice");
    expect(updated[0].replies[0].authorId).toBe("user-1");
  });

  it("onCommentsChange fires when comments are mutated", () => {
    manager.subscribeFile("notes.md");
    const handler = vi.fn();
    manager.onCommentsChange("notes.md", handler);

    manager.addComment("notes.md", 1, "New");
    expect(handler).toHaveBeenCalled();
  });

  it("onCommentsChange returns unsubscribe function", () => {
    manager.subscribeFile("notes.md");
    const handler = vi.fn();
    const unsub = manager.onCommentsChange("notes.md", handler);

    unsub();
    manager.addComment("notes.md", 1, "After unsub");
    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribeFile removes subscriptions and cleans up", () => {
    manager.subscribeFile("notes.md");
    manager.addComment("notes.md", 1, "Test");

    manager.unsubscribeFile("notes.md");
    expect(syncManager.releaseDoc).toHaveBeenCalledWith("__comments__:notes.md");
  });

  it("destroy cleans up all subscriptions", () => {
    manager.subscribeFile("a.md");
    manager.subscribeFile("b.md");

    manager.destroy();
    expect(syncManager.releaseDoc).toHaveBeenCalledWith("__comments__:a.md");
    expect(syncManager.releaseDoc).toHaveBeenCalledWith("__comments__:b.md");
  });

  it("syncs comments between two managers via shared Y.Doc", () => {
    const manager2 = new CommentManager(syncManager as any, "user-2", "Bob");

    manager.subscribeFile("notes.md");
    manager2.subscribeFile("notes.md");

    manager.addComment("notes.md", 1, "From Alice");
    manager2.addComment("notes.md", 2, "From Bob");

    const commentsFromAlice = manager.getComments("notes.md");
    expect(commentsFromAlice).toHaveLength(2);

    const commentsFromBob = manager2.getComments("notes.md");
    expect(commentsFromBob).toHaveLength(2);

    manager2.destroy();
  });
});
