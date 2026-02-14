import { type Vault, type TFile, TFolder } from "obsidian";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { LiveShareSettings } from "./types";
import { type SyncManager, waitForSync } from "./sync";
import type { ExclusionManager } from "./exclusion";
import { Notice } from "obsidian";

interface FileEntry {
  hash: string;
  size: number;
  mtime: number;
}

// Simple string hash (djb2)
function hashContent(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
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
    const wsUrl = this.settings.serverUrl.replace(/^http/, "ws");
    const params: Record<string, string> = { token: this.settings.token };
    if (this.settings.jwt) params.jwt = this.settings.jwt;
    this.provider = new WebsocketProvider(wsUrl + "/ws", roomName, this.doc, {
      params,
    });

    this.manifest = this.doc.getMap("files");
    try {
      await waitForSync(this.provider);
    } catch {
      new Notice("Live Share: manifest sync timed out");
    }
  }

  // Host: scan vault and populate manifest with complete data
  async publishManifest(): Promise<void> {
    if (!this.manifest || !this.doc) return;

    const files = this.getSharedFiles();

    // Compute all hashes FIRST to avoid publishing incomplete entries
    const entries = new Map<string, FileEntry>();
    for (const file of files) {
      const content = await this.vault.read(file);
      entries.set(file.path, {
        hash: hashContent(content),
        size: file.stat.size,
        mtime: file.stat.mtime,
      });
    }

    // Single transaction with complete data
    this.doc.transact(() => {
      // Remove entries no longer on disk
      for (const key of this.manifest!.keys()) {
        if (!entries.has(key)) {
          this.manifest!.delete(key);
        }
      }
      // Set all entries with computed hashes
      for (const [path, entry] of entries) {
        this.manifest!.set(path, entry);
      }
    });
  }

  // Guest: sync files from manifest to local vault
  async syncFromManifest(): Promise<number> {
    if (!this.manifest || !this.doc) return 0;

    let synced = 0;
    const entries = Array.from(this.manifest.entries());

    for (const [path, entry] of entries) {
      const localFile = this.vault.getAbstractFileByPath(path) as TFile | null;

      let needsSync = false;
      if (!localFile) {
        needsSync = true;
      } else {
        const content = await this.vault.read(localFile);
        if (hashContent(content) !== entry.hash) {
          needsSync = true;
        }
      }

      if (needsSync) {
        // Open the per-file Y.Doc to get its content
        const fileDoc = new Y.Doc();
        const roomName = `${this.settings.roomId}:${path}`;
        const wsUrl = this.settings.serverUrl.replace(/^http/, "ws");
        const fileParams: Record<string, string> = {
          token: this.settings.token,
        };
        if (this.settings.jwt) fileParams.jwt = this.settings.jwt;
        const fileProvider = new WebsocketProvider(
          wsUrl + "/ws",
          roomName,
          fileDoc,
          {
            params: fileParams,
          },
        );

        try {
          await waitForSync(fileProvider);
        } catch {
          fileProvider.destroy();
          fileDoc.destroy();
          continue;
        }

        const text = fileDoc.getText("content");
        const content = text.toString();

        if (content.length > 0) {
          // Ensure parent folders exist
          const dir = path.substring(0, path.lastIndexOf("/"));
          if (dir) await this.ensureFolder(dir);

          if (localFile) {
            await this.vault.modify(localFile, content);
          } else {
            await this.vault.create(path, content);
          }
          synced++;
        }

        fileProvider.destroy();
        fileDoc.destroy();
      }
    }

    return synced;
  }

  // Watch manifest for changes (guest uses this to discover new files)
  onManifestChange(
    callback: (added: string[], removed: string[]) => void,
  ): void {
    if (!this.manifest) return;

    // Clean up any existing observer to prevent memory leaks
    if (this.observer && this.manifest) {
      this.manifest.unobserve(this.observer);
    }

    this.observer = (event: Y.YMapEvent<FileEntry>) => {
      const added: string[] = [];
      const removed: string[] = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add") added.push(key);
        else if (change.action === "delete") removed.push(key);
      });
      if (added.length > 0 || removed.length > 0) {
        callback(added, removed);
      }
    };
    this.manifest.observe(this.observer);
  }

  // Host: update manifest when a file is created/modified
  updateFile(file: TFile, content: string): void {
    if (!this.manifest || !this.isSharedPath(file.path)) return;
    this.manifest.set(file.path, {
      hash: hashContent(content),
      size: content.length,
      mtime: file.stat.mtime,
    });
  }

  // Host: remove file from manifest
  removeFile(path: string): void {
    if (!this.manifest) return;
    this.manifest.delete(path);
  }

  // Host: rename file in manifest, release stale Yjs doc
  renameFile(
    oldPath: string,
    newPath: string,
    syncManager?: SyncManager,
  ): void {
    if (!this.manifest) return;
    const entry = this.manifest.get(oldPath);
    if (entry) {
      this.manifest.delete(oldPath);
      this.manifest.set(newPath, entry);
    }
    // Release the old Yjs doc so it will be re-created under the new key
    if (syncManager) {
      syncManager.releaseDoc(oldPath);
    }
  }

  isSharedPath(path: string): boolean {
    if (this.exclusionManager && this.exclusionManager.isExcluded(path))
      return false;
    if (!this.settings.sharedFolder) return true;
    const folder = this.settings.sharedFolder.endsWith("/")
      ? this.settings.sharedFolder
      : this.settings.sharedFolder + "/";
    return path.startsWith(folder) || path === this.settings.sharedFolder;
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
    // Create folder recursively
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
