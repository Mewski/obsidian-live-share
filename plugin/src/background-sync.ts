/** Background Y.Text observers for all shared text files with debounced disk writes. */

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
      await this.subscribe(path);
    }
  }

  async subscribe(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (this.observers.has(path)) return;

    const result = this.syncManager.getDoc(path);
    if (!result) return;

    try {
      await waitForSync(result.provider);
    } catch {
      return;
    }

    if (this.role === "host" && result.text.length === 0) {
      const file = this.vault.getAbstractFileByPath(path) as TFile | null;
      if (file) {
        const content = await this.vault.read(file);
        if (content.length > 0) {
          result.doc.transact(() => {
            result.text.insert(0, content);
          });
        }
      }
    } else if (this.role === "guest" && result.text.length > 0) {
      const file = this.vault.getAbstractFileByPath(path) as TFile | null;
      const remoteContent = result.text.toString();
      const localContent = file ? await this.vault.read(file) : "";
      if (remoteContent !== localContent) {
        await this.writeToDisk(path, remoteContent);
      }
    }

    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.local) return;
      if (path === this.activeFile) return;
      this.scheduleDiskWrite(path, result.text);
    };
    result.text.observe(observer);
    this.observers.set(path, () => result.text.unobserve(observer));
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
      const result = this.syncManager.getDoc(oldActive);
      if (result) {
        this.writeToDisk(oldActive, result.text.toString());
      }
    }
  }

  async onFileAdded(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (!isTextFile(path)) return;
    await this.subscribe(path);
  }

  onFileRemoved(rawPath: string): void {
    this.unsubscribe(rawPath);
  }

  async handleLocalTextModify(rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (this.writtenByUs.has(path)) return;
    if (path === this.activeFile) return;

    const result = this.syncManager.getDoc(path);
    if (!result) return;

    const file = this.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return;

    const localContent = await this.vault.read(file);
    const remoteContent = result.text.toString();
    if (localContent === remoteContent) return;

    result.doc.transact(() => {
      result.text.delete(0, result.text.length);
      result.text.insert(0, localContent);
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
    const result = this.syncManager.getDoc(path);
    if (result) {
      this.writeToDisk(path, result.text.toString());
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
