import { type TFile, TFolder, type Vault } from "obsidian";
import { Notice } from "obsidian";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import type { ExclusionManager } from "./exclusion";
import { type SyncManager, waitForSync } from "./sync";
import type { LiveShareSettings } from "./types";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  ensureFolder,
  isTextFile,
  normalizePath,
  toWsUrl,
} from "./utils";

export interface FileEntry {
  hash: string;
  size: number;
  mtime: number;
  binary?: boolean;
  directory?: boolean;
}

async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hashContent(content: string): Promise<string> {
  return hashBuffer(new TextEncoder().encode(content).buffer as ArrayBuffer);
}

export class ManifestManager {
  private doc: Y.Doc | null = null;
  private provider: WebsocketProvider | null = null;
  private manifest: Y.Map<FileEntry> | null = null;
  private observer: ((events: Y.YMapEvent<FileEntry>) => void) | null = null;

  private exclusionManager: ExclusionManager | null = null;

  constructor(
    private vault: Vault,
    private settings: LiveShareSettings,
  ) {}

  setExclusionManager(manager: ExclusionManager) {
    this.exclusionManager = manager;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  async connect(): Promise<void> {
    if (!this.settings.roomId) return;

    this.doc = new Y.Doc();
    const roomName = `${this.settings.roomId}:__manifest__`;
    const wsUrl = toWsUrl(this.settings.serverUrl);
    const params: Record<string, string> = { token: this.settings.token };
    if (this.settings.jwt) params.jwt = this.settings.jwt;
    const userId = this.settings.githubUserId || this.settings.clientId;
    if (userId) params.userId = userId;
    this.provider = new WebsocketProvider(`${wsUrl}/ws`, roomName, this.doc, {
      params,
    });

    const onDisconnect = (event: { status: string }) => {
      if (event.status === "disconnected") {
        this.provider?.off("status", onDisconnect);
        this.provider?.destroy();
      }
    };
    this.provider.on("status", onDisconnect);

    this.manifest = this.doc.getMap("files");
    try {
      await waitForSync(this.provider);
    } catch {
      new Notice("Live Share: manifest sync timed out");
    }
  }

  async publishManifest(): Promise<void> {
    if (!this.manifest || !this.doc) return;

    const files = this.getSharedFiles();

    const entries = new Map<string, FileEntry>();
    for (const file of files) {
      const binary = !isTextFile(file.path);
      if (binary) {
        const buf = await this.vault.readBinary(file);
        entries.set(normalizePath(file.path), {
          hash: await hashBuffer(buf),
          size: file.stat.size,
          mtime: file.stat.mtime,
          binary: true,
        });
      } else {
        const content = await this.vault.read(file);
        entries.set(normalizePath(file.path), {
          hash: await hashContent(content),
          size: file.stat.size,
          mtime: file.stat.mtime,
        });
      }
    }

    // Include empty directories so they sync to guests
    for (const item of this.vault.getAllLoadedFiles()) {
      if (!(item instanceof TFolder)) continue;
      if (!item.path || item.path === "/") continue;
      if (!this.isSharedPath(item.path)) continue;
      if (item.children.length > 0) continue;
      entries.set(normalizePath(item.path), {
        hash: "",
        size: 0,
        mtime: 0,
        directory: true,
      });
    }

    this.doc.transact(() => {
      for (const filePath of this.manifest?.keys() ?? []) {
        if (!entries.has(filePath)) {
          this.manifest?.delete(filePath);
        }
      }
      for (const [filePath, fileEntry] of entries) {
        this.manifest?.set(filePath, fileEntry);
      }
    });
  }

  async syncFromManifest(
    suppress?: (path: string) => void,
    unsuppress?: (path: string) => void,
    requestBinary?: (path: string) => void,
    options?: { skipText?: boolean },
  ): Promise<number> {
    if (!this.manifest || !this.doc) return 0;

    let synced = 0;
    const entries = Array.from(this.manifest.entries());

    for (const [path, entry] of entries) {
      if (!path || path.startsWith("/") || path.startsWith("\\")) continue;
      const segments = path.split(/[\\/]/);
      if (segments.some((s) => s === ".." || s === ".")) continue;

      if (entry.directory) {
        const existing = this.vault.getAbstractFileByPath(path);
        if (!existing) {
          await ensureFolder(this.vault, path);
          synced++;
        }
        continue;
      }

      // When backgroundSync handles text files, skip them here to avoid
      // redundant temporary WebSocket connections.
      if (options?.skipText && !entry.binary && isTextFile(path)) continue;

      const localFile = this.vault.getAbstractFileByPath(path) as TFile | null;

      let needsSync = false;
      if (!localFile) {
        needsSync = true;
      } else if (entry.binary) {
        const buf = await this.vault.readBinary(localFile);
        if ((await hashBuffer(buf)) !== entry.hash) {
          needsSync = true;
        }
      } else {
        const content = await this.vault.read(localFile);
        if ((await hashContent(content)) !== entry.hash) {
          needsSync = true;
        }
      }

      if (!needsSync) continue;

      if (entry.binary) {
        requestBinary?.(path);
        synced++;
        continue;
      }

      const tempDoc = new Y.Doc();
      const roomName = `${this.settings.roomId}:${encodeURIComponent(path)}`;
      const wsUrl = toWsUrl(this.settings.serverUrl);
      const tempParams: Record<string, string> = {
        token: this.settings.token,
      };
      if (this.settings.jwt) tempParams.jwt = this.settings.jwt;
      const userId = this.settings.githubUserId || this.settings.clientId;
      if (userId) tempParams.userId = userId;
      const tempProvider = new WebsocketProvider(`${wsUrl}/ws`, roomName, tempDoc, {
        params: tempParams,
      });

      try {
        await waitForSync(tempProvider);

        const text = tempDoc.getText("content");
        const content = text.toString();

        const dir = path.substring(0, path.lastIndexOf("/"));
        if (dir) await ensureFolder(this.vault, dir);

        suppress?.(path);
        try {
          if (localFile) {
            await this.vault.modify(localFile, content);
          } else {
            await this.vault.create(path, content);
          }
        } finally {
          if (unsuppress) {
            setTimeout(() => unsuppress(path), 50);
          }
        }
        synced++;
      } catch {
      } finally {
        tempProvider.destroy();
        tempDoc.destroy();
      }
    }

    return synced;
  }

  onManifestChange(callback: (added: string[], removed: string[]) => void): void {
    if (!this.manifest) return;

    if (this.observer && this.manifest) {
      this.manifest.unobserve(this.observer);
    }

    this.observer = (event: Y.YMapEvent<FileEntry>) => {
      const added: string[] = [];
      const removed: string[] = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add" || change.action === "update") added.push(key);
        else if (change.action === "delete") removed.push(key);
      });
      if (added.length > 0 || removed.length > 0) {
        callback(added, removed);
      }
    };
    this.manifest.observe(this.observer);
  }

  async updateFile(file: TFile, content: string | ArrayBuffer): Promise<void> {
    if (!this.manifest || !this.isSharedPath(file.path)) return;
    if (content instanceof ArrayBuffer) {
      this.manifest.set(normalizePath(file.path), {
        hash: await hashBuffer(content),
        size: content.byteLength,
        mtime: file.stat.mtime,
        binary: true,
      });
    } else {
      this.manifest.set(normalizePath(file.path), {
        hash: await hashContent(content),
        size: content.length,
        mtime: file.stat.mtime,
      });
    }
  }

  removeFile(path: string): void {
    if (!this.manifest) return;
    this.manifest.delete(normalizePath(path));
  }

  addFolder(rawPath: string): void {
    if (!this.manifest || !this.isSharedPath(rawPath)) return;
    const path = normalizePath(rawPath);
    if (this.manifest.has(path)) return;
    this.manifest.set(path, { hash: "", size: 0, mtime: 0, directory: true });
  }

  renameFile(oldPath: string, newPath: string, syncManager?: SyncManager): void {
    if (!this.manifest) return;
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);
    const fileEntry = this.manifest.get(normOld);
    if (fileEntry) {
      this.manifest.delete(normOld);
      this.manifest.set(normNew, fileEntry);
    }
    if (syncManager) {
      syncManager.releaseDoc(normOld);
    }
  }

  getEntries(): Map<string, FileEntry> {
    if (!this.manifest) return new Map();
    return new Map(this.manifest.entries());
  }

  isSharedPath(rawPath: string): boolean {
    const path = normalizePath(rawPath);
    if (this.exclusionManager?.isExcluded(path)) return false;
    if (!this.settings.sharedFolder) return true;
    const folder = normalizePath(
      this.settings.sharedFolder.endsWith("/")
        ? this.settings.sharedFolder
        : `${this.settings.sharedFolder}/`,
    );
    return path.startsWith(folder) || path === normalizePath(this.settings.sharedFolder);
  }

  destroy(): void {
    if (this.observer && this.manifest) {
      this.manifest.unobserve(this.observer);
      this.observer = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    if (this.doc) {
      this.doc.destroy();
      this.doc = null;
    }
    this.manifest = null;
  }

  private getSharedFiles(): TFile[] {
    return this.vault.getFiles().filter((f) => this.isSharedPath(f.path));
  }
}
