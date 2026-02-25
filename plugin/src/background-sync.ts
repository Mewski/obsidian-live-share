import { Notice } from "obsidian";
import type { TFile, Vault } from "obsidian";
import type * as Y from "yjs";

import type { FileOpsManager } from "./file-ops";
import type { ManifestManager } from "./manifest";
import { type SyncManager, waitForSync } from "./sync";
import type { SessionRole } from "./types";
import {
  VAULT_EVENT_SETTLE_MS,
  applyMinimalYTextUpdate,
  ensureFolder,
  isTextFile,
  normalizeLineEndings,
  normalizePath,
} from "./utils";

const DEBOUNCE_MS = 1000;

export class BackgroundSync {
  private observers = new Map<string, () => void>();
  private subscribing = new Set<string>();
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeFile: string | null = null;
  private recentDiskWrites = new Set<string>();
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
      } catch {}
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

      if (this.observers.has(path)) return;

      if (this.role === "host" && path !== this.activeFile) {
        const file = this.vault.getAbstractFileByPath(path) as TFile | null;
        if (file) {
          const content = normalizeLineEndings(await this.vault.read(file));
          applyMinimalYTextUpdate(docHandle.doc, docHandle.text, content);
        }
      } else if (this.role === "guest" && docHandle.text.length > 0) {
        const file = this.vault.getAbstractFileByPath(path) as TFile | null;
        const remoteContent = docHandle.text.toString();
        const localContent = file ? normalizeLineEndings(await this.vault.read(file)) : "";
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

    if (oldActive && oldActive !== path) {
      const docHandle = this.syncManager.getDoc(oldActive);
      if (docHandle) {
        const content = docHandle.text.toString();
        this.writeToDisk(oldActive, content);
        if (this.role === "host") {
          const file = this.vault.getAbstractFileByPath(oldActive) as TFile | null;
          if (file) this.manifestManager.updateFile(file, content);
        }
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
    this.syncManager.releaseDoc(path);
  }

  async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);

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
      } catch {}
    }
  }

  async handleLocalTextModify(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (this.recentDiskWrites.has(path)) return;
    if (path === this.activeFile) return;

    const docHandle = this.syncManager.getDoc(path);
    if (!docHandle) return;

    const file = this.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return;

    const localContent = normalizeLineEndings(await this.vault.read(file));
    if (localContent === docHandle.text.toString()) return;

    applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);

    if (this.role === "host") {
      await this.manifestManager.updateFile(file, localContent);
    }
  }

  isRecentDiskWrite(rawPath: string): boolean {
    return this.recentDiskWrites.has(normalizePath(rawPath));
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
    this.recentDiskWrites.clear();
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
    this.recentDiskWrites.add(path);
    this.fileOpsManager.mutePathEvents(path);
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
      new Notice(`Live Share: failed to write ${path} to disk`);
    } finally {
      setTimeout(() => {
        this.recentDiskWrites.delete(path);
        this.fileOpsManager.unmutePathEvents(path);
      }, VAULT_EVENT_SETTLE_MS);
    }
  }
}
