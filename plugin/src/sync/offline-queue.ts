import type { FileOp } from "../types";
import { normalizePath } from "../utils";

function getOpPath(op: FileOp): string | null {
  if ("path" in op) return normalizePath(op.path);
  if ("oldPath" in op) return normalizePath(op.oldPath);
  return null;
}

export class OfflineQueue {
  private queue: FileOp[] = [];

  enqueue(op: FileOp): void {
    const path = getOpPath(op);

    if (path && op.type === "delete") {
      this.queue = this.queue.filter((prev) => getOpPath(prev) !== path);
    } else if (path && (op.type === "modify" || op.type === "create")) {
      const idx = this.queue.findIndex(
        (prev) => getOpPath(prev) === path && (prev.type === "modify" || prev.type === "create"),
      );
      if (idx >= 0) {
        this.queue.splice(idx, 1);
      }
    } else if (op.type === "rename" && "oldPath" in op && "newPath" in op) {
      const oldPath = normalizePath(op.oldPath);
      const newPath = normalizePath(op.newPath);
      this.queue = this.queue.map((prev) => {
        if ("path" in prev && normalizePath(prev.path) === oldPath) {
          return { ...prev, path: newPath };
        }
        return prev;
      });
    }

    this.queue.push(op);
  }

  drain(): FileOp[] {
    const ops = this.queue;
    this.queue = [];
    return ops;
  }

  get size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  clear(): void {
    this.queue = [];
  }
}
