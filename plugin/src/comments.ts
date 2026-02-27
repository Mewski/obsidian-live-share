import * as Y from "yjs";

import type { SyncManager } from "./sync";

export interface Comment {
  id: string;
  anchorIndex: number;
  text: string;
  author: string;
  authorId: string;
  timestamp: number;
  resolved: boolean;
  replies: Reply[];
}

export interface Reply {
  id: string;
  text: string;
  author: string;
  authorId: string;
  timestamp: number;
}

const COMMENT_DOC_PREFIX = "__comments__:";

function commentDocId(filePath: string): string {
  return `${COMMENT_DOC_PREFIX}${filePath}`;
}

export class CommentManager {
  private syncManager: SyncManager;
  private userId: string;
  private displayName: string;
  private subscribedFiles = new Set<string>();
  private changeHandlers = new Map<string, () => void>();

  constructor(syncManager: SyncManager, userId: string, displayName: string) {
    this.syncManager = syncManager;
    this.userId = userId;
    this.displayName = displayName;
  }

  subscribeFile(filePath: string): void {
    if (this.subscribedFiles.has(filePath)) return;
    this.subscribedFiles.add(filePath);
    this.syncManager.getDoc(commentDocId(filePath));
  }

  unsubscribeFile(filePath: string): void {
    if (!this.subscribedFiles.has(filePath)) return;
    this.subscribedFiles.delete(filePath);
    const handler = this.changeHandlers.get(filePath);
    if (handler) {
      const docHandle = this.syncManager.getDoc(commentDocId(filePath));
      if (docHandle) {
        const arr = docHandle.doc.getArray<Y.Map<unknown>>("comments");
        arr.unobserve(handler);
      }
      this.changeHandlers.delete(filePath);
    }
    this.syncManager.releaseDoc(commentDocId(filePath));
  }

  onCommentsChange(filePath: string, handler: () => void): () => void {
    const docHandle = this.syncManager.getDoc(commentDocId(filePath));
    if (!docHandle) return () => {};
    const arr = docHandle.doc.getArray<Y.Map<unknown>>("comments");
    arr.observe(handler);
    this.changeHandlers.set(filePath, handler);
    return () => {
      arr.unobserve(handler);
      this.changeHandlers.delete(filePath);
    };
  }

  private getCommentsArray(filePath: string): Y.Array<Y.Map<unknown>> | null {
    const docHandle = this.syncManager.getDoc(commentDocId(filePath));
    if (!docHandle) return null;
    return docHandle.doc.getArray<Y.Map<unknown>>("comments");
  }

  addComment(filePath: string, anchorIndex: number, text: string): void {
    const arr = this.getCommentsArray(filePath);
    if (!arr) return;
    const comment = new Y.Map<unknown>();
    comment.set("id", crypto.randomUUID());
    comment.set("anchorIndex", anchorIndex);
    comment.set("text", text);
    comment.set("author", this.displayName);
    comment.set("authorId", this.userId);
    comment.set("timestamp", Date.now());
    comment.set("resolved", false);
    comment.set("replies", new Y.Array<Y.Map<unknown>>());
    arr.push([comment]);
  }

  resolveComment(filePath: string, commentId: string): void {
    const arr = this.getCommentsArray(filePath);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i);
      if (item.get("id") === commentId) {
        item.set("resolved", !item.get("resolved"));
        break;
      }
    }
  }

  deleteComment(filePath: string, commentId: string): void {
    const arr = this.getCommentsArray(filePath);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i);
      if (item.get("id") === commentId) {
        arr.delete(i, 1);
        break;
      }
    }
  }

  addReply(filePath: string, commentId: string, text: string): void {
    const arr = this.getCommentsArray(filePath);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i);
      if (item.get("id") === commentId) {
        const replies = item.get("replies") as Y.Array<Y.Map<unknown>>;
        const reply = new Y.Map<unknown>();
        reply.set("id", crypto.randomUUID());
        reply.set("text", text);
        reply.set("author", this.displayName);
        reply.set("authorId", this.userId);
        reply.set("timestamp", Date.now());
        replies.push([reply]);
        break;
      }
    }
  }

  getComments(filePath: string): Comment[] {
    const arr = this.getCommentsArray(filePath);
    if (!arr) return [];
    const result: Comment[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i);
      const replies: Reply[] = [];
      const repliesArr = item.get("replies") as Y.Array<Y.Map<unknown>> | undefined;
      if (repliesArr) {
        for (let j = 0; j < repliesArr.length; j++) {
          const r = repliesArr.get(j);
          replies.push({
            id: r.get("id") as string,
            text: r.get("text") as string,
            author: r.get("author") as string,
            authorId: r.get("authorId") as string,
            timestamp: r.get("timestamp") as number,
          });
        }
      }
      result.push({
        id: item.get("id") as string,
        anchorIndex: item.get("anchorIndex") as number,
        text: item.get("text") as string,
        author: item.get("author") as string,
        authorId: item.get("authorId") as string,
        timestamp: item.get("timestamp") as number,
        resolved: (item.get("resolved") as boolean) ?? false,
        replies,
      });
    }
    return result;
  }

  destroy(): void {
    for (const filePath of [...this.subscribedFiles]) {
      this.unsubscribeFile(filePath);
    }
  }
}
