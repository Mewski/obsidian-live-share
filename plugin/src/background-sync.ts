import type { TFile, Vault } from "obsidian";
import type * as Y from "yjs";

import type { FileOpsManager } from "./file-ops";
import type { ManifestManager } from "./manifest";
import { type SyncManager, waitForSync } from "./sync";
import type { SessionRole } from "./types";
import { ensureFolder, isTextFile, normalizePath } from "./utils";

const DEBOUNCE_MS = 1000;

export class BackgroundSync {
  private observers = new Map<string, () => void>();
  private subscribing = new Set<string>();
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeFile: string | null = null;
  private writtenByUs = new Set<string>();
  private role: SessionRole = "host";

  constructor(
    private vault: Vault,
    private syncManager: SyncManager,
    private manifestManager: ManifestManager,
    private fileOpsManager: FileOpsManager,
  ) {}

  async startAll(role: SessionRole): Promise<void> {
    this.role = role;
    const entries = this.manifestManager.getEntries();
    for (const [path, entry] of entries) {
      if (!isTextFile(path) || entry.binary) continue;
      try {
        await this.subscribe(path);
      } catch {
        // Individual file failure should not abort remaining files
      }
    }
  }

  async subscribe(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (this.observers.has(path) || this.subscribing.has(path)) return;
    this.subscribing.add(path);

    try {
      const docHandle = this.syncManager.getDoc(path);
      if (!docHandle) return;

      try {
        await waitForSync(docHandle.provider);
      } catch {
        return;
      }

      // Re-check after await — another call may have completed first
      if (this.observers.has(path)) return;

      // Re-check text.length after await to avoid double-seeding
      if (this.role === "host" && docHandle.text.length === 0) {
        const file = this.vault.getAbstractFileByPath(path) as TFile | null;
        if (file) {
          const content = await this.vault.read(file);
          if (docHandle.text.length === 0 && content.length > 0) {
            docHandle.doc.transact(() => {
              docHandle.text.insert(0, content);
            });
          }
        }
      } else if (this.role === "guest" && docHandle.text.length > 0) {
        const file = this.vault.getAbstractFileByPath(path) as TFile | null;
        const remoteContent = docHandle.text.toString();
        const localContent = file ? await this.vault.read(file) : "";
        if (remoteContent !== localContent) {
          await this.writeToDisk(path, remoteContent);
        }
      }

      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.local) return;
        if (path === this.activeFile) return;
        this.scheduleDiskWrite(path, docHandle.text);
      };
      docHandle.text.observe(observer);
      this.observers.set(path, () => docHandle.text.unobserve(observer));
    } finally {
      this.subscribing.delete(path);
    }
  }

  unsubscribe(rawPath: string): void {
    const path = normalizePath(rawPath);
    this.flushWrite(path);
    const unobserve = this.observers.get(path);
    if (unobserve) {
      unobserve();
      this.observers.delete(path);
    }
  }

  setActiveFile(rawPath: string | null): void {
    const path = rawPath ? normalizePath(rawPath) : null;
    const oldActive = this.activeFile;
    this.activeFile = path;

    // Flush old active file to disk so the background observer can take over
    if (oldActive && oldActive !== path) {
      const docHandle = this.syncManager.getDoc(oldActive);
      if (docHandle) {
        this.writeToDisk(oldActive, docHandle.text.toString());
      }
    }
  }

  async onFileAdded(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (!isTextFile(path)) return;
    await this.subscribe(path);
  }

  onFileRemoved(rawPath: string): void {
    const path = normalizePath(rawPath);
    // Cancel any pending write — do NOT flush (the file is being deleted)
    const timer = this.writeTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(path);
    }
    const unobserve = this.observers.get(path);
    if (unobserve) {
      unobserve();
      this.observers.delete(path);
    }
    // Release the orphaned WebSocket provider
    this.syncManager.releaseDoc(path);
  }

  async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);

    // Cancel any pending write for the old path
    const timer = this.writeTimers.get(normOld);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(normOld);
    }
    const unobserve = this.observers.get(normOld);
    if (unobserve) {
      unobserve();
      this.observers.delete(normOld);
    }

    if (this.activeFile === normOld) {
      this.activeFile = normNew;
    }

    if (isTextFile(normNew)) {
      try {
        await this.subscribe(normNew);
      } catch {
        // Non-fatal — file will sync when opened
      }
    }
  }

  async handleLocalTextModify(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (this.writtenByUs.has(path)) return;
    if (path === this.activeFile) return;

    const docHandle = this.syncManager.getDoc(path);
    if (!docHandle) return;

    const file = this.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return;

    const localContent = await this.vault.read(file);
    const remoteContent = docHandle.text.toString();
    if (localContent === remoteContent) return;

    docHandle.doc.transact(() => {
      docHandle.text.delete(0, docHandle.text.length);
      docHandle.text.insert(0, localContent);
    });

    await this.manifestManager.updateFile(file, localContent);
  }

  isWrittenByUs(rawPath: string): boolean {
    return this.writtenByUs.has(normalizePath(rawPath));
  }

  destroy(): void {
    for (const path of this.writeTimers.keys()) {
      this.flushWrite(path);
    }
    for (const [, unobserve] of this.observers) {
      unobserve();
    }
    this.observers.clear();
    this.activeFile = null;
    this.writtenByUs.clear();
  }

  private flushWrite(path: string): void {
    const timer = this.writeTimers.get(path);
    if (!timer) return;
    clearTimeout(timer);
    this.writeTimers.delete(path);
    const docHandle = this.syncManager.getDoc(path);
    if (docHandle) {
      this.writeToDisk(path, docHandle.text.toString());
    }
  }

  private scheduleDiskWrite(path: string, text: Y.Text): void {
    const existing = this.writeTimers.get(path);
    if (existing) clearTimeout(existing);
    this.writeTimers.set(
      path,
      setTimeout(() => {
        this.writeTimers.delete(path);
        this.writeToDisk(path, text.toString());
      }, DEBOUNCE_MS),
    );
  }

  private async writeToDisk(path: string, content: string): Promise<void> {
    this.writtenByUs.add(path);
    this.fileOpsManager.suppressPath(path);
    try {
      const file = this.vault.getAbstractFileByPath(path) as TFile | null;
      if (file) {
        await this.vault.modify(file, content);
      } else {
        const dir = path.substring(0, path.lastIndexOf("/"));
        if (dir) await ensureFolder(this.vault, dir);
        await this.vault.create(path, content);
      }
    } catch {
      // File write failed — will retry on next change
    } finally {
      setTimeout(() => {
        this.writtenByUs.delete(path);
        this.fileOpsManager.unsuppressPath(path);
      }, 100);
    }
  }
}
