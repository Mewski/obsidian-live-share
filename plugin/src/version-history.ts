import * as Y from "yjs";

import type { SyncManager } from "./sync";
import { arrayBufferToBase64, base64ToArrayBuffer, normalizePath } from "./utils";

export interface SnapshotEntry {
  timestamp: number;
  label?: string;
  data: string;
  userId: string;
  displayName: string;
}

export interface SnapshotStore {
  snapshots: Record<string, SnapshotEntry[]>;
}

const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS_PER_FILE = 50;

export class VersionHistoryManager {
  private store: SnapshotStore = { snapshots: {} };
  private dirtyFiles = new Set<string>();
  private autoSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  private docObservers = new Map<string, () => void>();

  constructor(
    private syncManager: SyncManager,
    private userId: string,
    private displayName: string,
  ) {}

  loadStore(data: SnapshotStore | null): void {
    if (data?.snapshots) {
      this.store = data;
    }
  }

  getStore(): SnapshotStore {
    return this.store;
  }

  startAutoCapture(): void {
    if (this.autoSnapshotTimer) return;
    this.autoSnapshotTimer = setInterval(() => {
      this.captureAutomaticSnapshots();
    }, AUTO_SNAPSHOT_INTERVAL_MS);
  }

  stopAutoCapture(): void {
    if (this.autoSnapshotTimer) {
      clearInterval(this.autoSnapshotTimer);
      this.autoSnapshotTimer = null;
    }
    for (const unobserve of this.docObservers.values()) {
      unobserve();
    }
    this.docObservers.clear();
    this.dirtyFiles.clear();
  }

  trackFile(filePath: string): void {
    const path = normalizePath(filePath);
    if (this.docObservers.has(path)) return;

    const docHandle = this.syncManager.getDoc(path);
    if (!docHandle) return;

    const observer = () => {
      this.dirtyFiles.add(path);
    };
    docHandle.doc.on("update", observer);
    this.docObservers.set(path, () => docHandle.doc.off("update", observer));
  }

  untrackFile(filePath: string): void {
    const path = normalizePath(filePath);
    const unobserve = this.docObservers.get(path);
    if (unobserve) {
      unobserve();
      this.docObservers.delete(path);
    }
    this.dirtyFiles.delete(path);
  }

  captureSnapshot(filePath: string, label?: string): void {
    const path = normalizePath(filePath);
    const docHandle = this.syncManager.getDoc(path);
    if (!docHandle) {
      throw new Error(`No document found for ${path}`);
    }

    const snapshot = Y.snapshot(docHandle.doc);
    const encoded = Y.encodeSnapshotV2(snapshot);
    const base64 = arrayBufferToBase64(
      encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer,
    );

    const entry: SnapshotEntry = {
      timestamp: Date.now(),
      label,
      data: base64,
      userId: this.userId,
      displayName: this.displayName,
    };

    if (!this.store.snapshots[path]) {
      this.store.snapshots[path] = [];
    }

    this.store.snapshots[path].push(entry);

    if (this.store.snapshots[path].length > MAX_SNAPSHOTS_PER_FILE) {
      this.store.snapshots[path] = this.store.snapshots[path].slice(-MAX_SNAPSHOTS_PER_FILE);
    }

    this.dirtyFiles.delete(path);
  }

  getSnapshots(filePath: string): SnapshotEntry[] {
    const path = normalizePath(filePath);
    return this.store.snapshots[path] ?? [];
  }

  restoreSnapshot(filePath: string, snapshotIndex: number): string {
    const path = normalizePath(filePath);
    const snapshots = this.store.snapshots[path];

    if (!snapshots || snapshotIndex < 0 || snapshotIndex >= snapshots.length) {
      throw new Error("Invalid snapshot index");
    }

    const docHandle = this.syncManager.getDoc(path);
    if (!docHandle) {
      throw new Error(`No document found for ${path}`);
    }

    const entry = snapshots[snapshotIndex];
    const encoded = new Uint8Array(base64ToArrayBuffer(entry.data));
    const snapshot = Y.decodeSnapshotV2(encoded);
    const snapshotDoc = Y.createDocFromSnapshot(docHandle.doc, snapshot);
    const content = snapshotDoc.getText("content").toString();
    snapshotDoc.destroy();

    return content;
  }

  applySnapshot(filePath: string, snapshotIndex: number): void {
    const path = normalizePath(filePath);
    const content = this.restoreSnapshot(path, snapshotIndex);

    const docHandle = this.syncManager.getDoc(path);
    if (!docHandle) {
      throw new Error(`No document found for ${path}`);
    }

    docHandle.doc.transact(() => {
      docHandle.text.delete(0, docHandle.text.length);
      docHandle.text.insert(0, content);
    });
  }

  clearSnapshots(filePath?: string): void {
    if (filePath) {
      delete this.store.snapshots[normalizePath(filePath)];
    } else {
      this.store.snapshots = {};
    }
  }

  private captureAutomaticSnapshots(): void {
    const paths = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    for (const path of paths) {
      try {
        this.captureSnapshot(path);
      } catch {}
    }
  }
}
