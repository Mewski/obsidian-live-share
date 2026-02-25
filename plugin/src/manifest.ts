/** File inventory sync via shared Y.Map with hash-based change detection. */
import { type TFile, TFolder, type Vault } from "obsidian";
import { Notice } from "obsidian";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { ExclusionManager } from "./exclusion";
import { type SyncManager, waitForSync } from "./sync";
import type { LiveShareSettings } from "./types";
import { isTextFile, normalizePath, toWsUrl } from "./utils";

interface FileEntry {
  hash: string;
  size: number;
  mtime: number;
  binary?: boolean;
}

async function hashContent(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashBinaryContent(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    this.provider = new WebsocketProvider(`${wsUrl}/ws`, roomName, this.doc, {
      params,
    });

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
          hash: await hashBinaryContent(buf),
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

    this.doc.transact(() => {
      for (const key of this.manifest?.keys() ?? []) {
        if (!entries.has(key)) {
          this.manifest?.delete(key);
        }
      }
      for (const [path, entry] of entries) {
        this.manifest?.set(path, entry);
      }
    });
  }

  async syncFromManifest(
    suppress?: (path: string) => void,
    unsuppress?: (path: string) => void,
  ): Promise<number> {
    if (!this.manifest || !this.doc) return 0;

    let synced = 0;
    const entries = Array.from(this.manifest.entries());

    for (const [path, entry] of entries) {
      if (entry.binary) continue;
      if (
        !path ||
        path.startsWith("/") ||
        path.startsWith("\\") ||
        /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
      )
        continue;

      const localFile = this.vault.getAbstractFileByPath(path) as TFile | null;

      let needsSync = false;
      if (!localFile) {
        needsSync = true;
      } else {
        const content = await this.vault.read(localFile);
        if ((await hashContent(content)) !== entry.hash) {
          needsSync = true;
        }
      }

      if (needsSync) {
        const fileDoc = new Y.Doc();
        const roomName = `${this.settings.roomId}:${encodeURIComponent(path)}`;
        const wsUrl = toWsUrl(this.settings.serverUrl);
        const fileParams: Record<string, string> = {
          token: this.settings.token,
        };
        if (this.settings.jwt) fileParams.jwt = this.settings.jwt;
        const fileProvider = new WebsocketProvider(
          `${wsUrl}/ws`,
          roomName,
          fileDoc,
          {
            params: fileParams,
          },
        );

        try {
          await waitForSync(fileProvider);

          const text = fileDoc.getText("content");
          const content = text.toString();

          if (content.length > 0) {
            const dir = path.substring(0, path.lastIndexOf("/"));
            if (dir) await this.ensureFolder(dir);

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
          }
        } catch {
          // sync timed out or vault write failed -- skip this file
        } finally {
          fileProvider.destroy();
          fileDoc.destroy();
        }
      }
    }

    return synced;
  }

  onManifestChange(
    callback: (added: string[], removed: string[]) => void,
  ): void {
    if (!this.manifest) return;

    if (this.observer && this.manifest) {
      this.manifest.unobserve(this.observer);
    }

    this.observer = (event: Y.YMapEvent<FileEntry>) => {
      const added: string[] = [];
      const removed: string[] = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add" || change.action === "update")
          added.push(key);
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
        hash: await hashBinaryContent(content),
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

  renameFile(
    oldPath: string,
    newPath: string,
    syncManager?: SyncManager,
  ): void {
    if (!this.manifest) return;
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);
    const entry = this.manifest.get(normOld);
    if (entry) {
      this.manifest.delete(normOld);
      this.manifest.set(normNew, entry);
    }
    if (syncManager) {
      syncManager.releaseDoc(normOld);
    }
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
    return (
      path.startsWith(folder) ||
      path === normalizePath(this.settings.sharedFolder)
    );
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

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const folder = this.vault.getAbstractFileByPath(current);
      if (!folder) {
        await this.vault.createFolder(current);
      }
    }
  }
}
