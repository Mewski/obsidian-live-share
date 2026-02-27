import { describe, expect, it } from "vitest";
import { OfflineQueue } from "../offline-queue";

describe("OfflineQueue", () => {
  it("enqueues and drains operations in order", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "create", path: "a.md", content: "hello" });
    queue.enqueue({ type: "create", path: "b.md", content: "world" });

    const ops = queue.drain();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ type: "create", path: "a.md", content: "hello" });
    expect(ops[1]).toEqual({ type: "create", path: "b.md", content: "world" });
  });

  it("drain clears the queue", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "create", path: "a.md", content: "hello" });
    queue.drain();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.size).toBe(0);
  });

  it("latest modify for same path replaces earlier one", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "modify", path: "a.md", content: "v1" });
    queue.enqueue({ type: "modify", path: "a.md", content: "v2" });

    const ops = queue.drain();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ type: "modify", path: "a.md", content: "v2" });
  });

  it("latest create for same path replaces earlier create", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "create", path: "a.md", content: "v1" });
    queue.enqueue({ type: "create", path: "a.md", content: "v2" });

    const ops = queue.drain();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ type: "create", path: "a.md", content: "v2" });
  });

  it("delete cancels prior create and modify for same path", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "create", path: "a.md", content: "hello" });
    queue.enqueue({ type: "modify", path: "a.md", content: "updated" });
    queue.enqueue({ type: "delete", path: "a.md" });

    const ops = queue.drain();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ type: "delete", path: "a.md" });
  });

  it("different paths are independent", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "create", path: "a.md", content: "a" });
    queue.enqueue({ type: "create", path: "b.md", content: "b" });
    queue.enqueue({ type: "modify", path: "a.md", content: "a-updated" });

    const ops = queue.drain();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ type: "create", path: "b.md", content: "b" });
    expect(ops[1]).toEqual({ type: "modify", path: "a.md", content: "a-updated" });
  });

  it("clear discards all operations", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "create", path: "a.md", content: "hello" });
    queue.enqueue({ type: "create", path: "b.md", content: "world" });
    queue.clear();

    expect(queue.isEmpty()).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("size reflects number of queued operations", () => {
    const queue = new OfflineQueue();
    expect(queue.size).toBe(0);
    queue.enqueue({ type: "create", path: "a.md", content: "a" });
    expect(queue.size).toBe(1);
    queue.enqueue({ type: "create", path: "b.md", content: "b" });
    expect(queue.size).toBe(2);
  });

  it("isEmpty returns true when empty", () => {
    const queue = new OfflineQueue();
    expect(queue.isEmpty()).toBe(true);
    queue.enqueue({ type: "create", path: "a.md", content: "a" });
    expect(queue.isEmpty()).toBe(false);
  });

  it("handles rename operations", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "rename", oldPath: "a.md", newPath: "b.md" });

    const ops = queue.drain();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ type: "rename", oldPath: "a.md", newPath: "b.md" });
  });

  it("handles folder-create operations", () => {
    const queue = new OfflineQueue();
    queue.enqueue({ type: "folder-create", path: "subdir" });

    const ops = queue.drain();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ type: "folder-create", path: "subdir" });
  });
});
