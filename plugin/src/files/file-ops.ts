import { type FileManager, Notice, type TAbstractFile, TFile, type Vault } from "obsidian";
import { OfflineQueue } from "../sync/offline-queue";
import type { FileOp } from "../types";
import {
  VAULT_EVENT_SETTLE_MS,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  ensureFolder,
  isTextFile,
  normalizeLineEndings,
  normalizePath,
  toCanonicalPath,
  toLocalPath,
} from "../utils";

const CHUNK_SIZE = 512 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const RENAME_RETRY_DELAY_MS = 300;
const STALE_TRANSFER_MS = 5 * 60 * 1000;

interface ChunkAssembly {
  chunks: string[];
  totalSize: number;
  binary?: boolean;
  transferId?: string;
  lastActivity: number;
}

interface OutgoingTransfer {
  path: string;
  content: string;
  binary: boolean;
  totalChunks: number;
  lastActivity: number;
}

export class FileOpsManager {
  private vault: Vault;
  private fileManager: FileManager;
  private sendOp: ((op: FileOp) => void) | null = null;
  private mutedPaths = new Map<string, number>();
  private pendingChunks = new Map<string, ChunkAssembly>();
  private outgoingTransfers = new Map<string, OutgoingTransfer>();
  private opQueues = new Map<string, Promise<void>>();
  private sendQueues = new Map<string, Promise<void>>();
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private offlineQueue = new OfflineQueue();
  private isOnline = true;

  constructor(vault: Vault, fileManager: FileManager) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.staleTimer = setInterval(() => this.purgeStaleTransfers(), 60_000);
  }

  destroy(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.outgoingTransfers.clear();
    this.pendingChunks.clear();
    this.offlineQueue.clear();
    this.mutedPaths.clear();
    this.opQueues.clear();
    this.sendQueues.clear();
  }

  setOnline(online: boolean): void {
    const wasOffline = !this.isOnline;
    this.isOnline = online;
    if (online && wasOffline && this.sendOp) {
      const ops = this.offlineQueue.drain();
      for (const op of ops) {
        this.sendOp(op);
      }
    }
  }

  private purgeStaleTransfers(): void {
    const now = Date.now();
    for (const [key, assembly] of this.pendingChunks) {
      if (now - assembly.lastActivity > STALE_TRANSFER_MS) {
        this.pendingChunks.delete(key);
      }
    }
    for (const [id, transfer] of this.outgoingTransfers) {
      if (now - transfer.lastActivity > STALE_TRANSFER_MS) {
        this.outgoingTransfers.delete(id);
      }
    }
  }

  setSender(sender: (op: FileOp) => void) {
    this.sendOp = sender;
  }

  private emitOp(op: FileOp): void {
    if (!this.sendOp) return;
    if (!this.isOnline) {
      this.offlineQueue.enqueue(op);
      return;
    }
    this.sendOp(op);
  }

  mutePathEvents(path: string): void {
    const norm = normalizePath(path);
    this.mutedPaths.set(norm, (this.mutedPaths.get(norm) ?? 0) + 1);
  }

  unmutePathEvents(path: string): void {
    const norm = normalizePath(path);
    const count = this.mutedPaths.get(norm) ?? 0;
    if (count <= 1) {
      this.mutedPaths.delete(norm);
    } else {
      this.mutedPaths.set(norm, count - 1);
    }
  }

  isPathMuted(path: string): boolean {
    return (this.mutedPaths.get(normalizePath(path)) ?? 0) > 0;
  }

  clearPendingChunks(): void {
    this.pendingChunks.clear();
    this.outgoingTransfers.clear();
    this.offlineQueue.clear();
  }

  async applyRemoteOp(op: FileOp) {
    const paths = this.getOpPaths(op);

    // Chain onto existing queue for all affected paths atomically
    const currentQueues = paths.map((path) => this.opQueues.get(path) ?? Promise.resolve());
    const gate = Promise.all(currentQueues);

    const promise = gate.then(() => this.applyRemoteOpInner(op));

    // Set the new promise for all paths BEFORE awaiting
    for (const path of paths) this.opQueues.set(path, promise);

    try {
      await promise;
    } finally {
      for (const path of paths) {
        if (this.opQueues.get(path) === promise) this.opQueues.delete(path);
      }
    }
  }

  private isPathSafe(path: string): boolean {
    if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
    const segments = path.split(/[\\/]/);
    return !segments.some((segment) => segment === ".." || segment === ".");
  }

  private getOpPaths(op: FileOp): string[] {
    const paths: string[] = [];
    if ("path" in op) paths.push(normalizePath(op.path));
    if ("oldPath" in op) paths.push(normalizePath(op.oldPath));
    if ("newPath" in op) paths.push(normalizePath(op.newPath));
    return paths;
  }

  private async applyRemoteOpInner(rawOp: FileOp) {
    const op = { ...rawOp } as FileOp;
    if ("path" in op) op.path = toLocalPath(normalizePath(op.path));
    if ("oldPath" in op) op.oldPath = toLocalPath(normalizePath(op.oldPath));
    if ("newPath" in op) op.newPath = toLocalPath(normalizePath(op.newPath));

    if ("path" in op && !this.isPathSafe(op.path)) return;
    if ("oldPath" in op && !this.isPathSafe(op.oldPath)) return;
    if ("newPath" in op && !this.isPathSafe(op.newPath)) return;

    const paths = this.getOpPaths(op);
    for (const path of paths) this.mutePathEvents(path);
    try {
      switch (op.type) {
        case "create": {
          const exists = this.vault.getAbstractFileByPath(op.path);
          if (exists && exists instanceof TFile) {
            if (op.binary) {
              const binaryData = base64ToArrayBuffer(op.content);
              await this.vault.modifyBinary(exists, binaryData);
            } else {
              await this.vault.modify(exists, op.content);
            }
          } else if (!exists) {
            const parentDir = op.path.substring(0, op.path.lastIndexOf("/"));
            if (parentDir) await ensureFolder(this.vault, parentDir);
            if (op.binary) {
              const binaryData = base64ToArrayBuffer(op.content);
              await this.vault.createBinary(op.path, binaryData);
            } else {
              await this.vault.create(op.path, op.content);
            }
          }
          break;
        }
        case "modify": {
          const file = this.vault.getAbstractFileByPath(op.path);
          if (file instanceof TFile) {
            if (op.binary) {
              const binaryData = base64ToArrayBuffer(op.content);
              await this.vault.modifyBinary(file, binaryData);
            } else {
              await this.vault.modify(file, op.content);
            }
          }
          break;
        }
        case "delete": {
          const file = this.vault.getAbstractFileByPath(op.path);
          if (file) {
            try {
              await this.fileManager.trashFile(file);
            } catch {
              // File may have already been deleted
            }
          }
          this.pendingChunks.delete(op.path);
          break;
        }
        case "rename": {
          let file = this.vault.getAbstractFileByPath(op.oldPath);
          if (!file) {
            await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
            file = this.vault.getAbstractFileByPath(op.oldPath);
          }
          const alreadyExists = this.vault.getAbstractFileByPath(op.newPath);
          if (alreadyExists && !file) {
            break;
          }
          if (file && !alreadyExists) {
            const parentDir = op.newPath.substring(0, op.newPath.lastIndexOf("/"));
            if (parentDir) await ensureFolder(this.vault, parentDir);
            try {
              await this.vault.rename(file, op.newPath);
            } catch (renameErr) {
              if (!this.vault.getAbstractFileByPath(op.newPath)) throw renameErr;
            }
          } else if (file && alreadyExists) {
            await this.fileManager.trashFile(file);
          }
          break;
        }
        case "chunk-start": {
          if (op.totalSize <= 0 || op.totalSize > MAX_FILE_SIZE) {
            if (op.totalSize > MAX_FILE_SIZE) {
              new Notice(`Live Share: incoming ${op.path} exceeds 50 MB limit, skipping`);
            }
            break;
          }
          const chunkKey = op.transferId ?? op.path;
          this.pendingChunks.delete(chunkKey);
          this.pendingChunks.set(chunkKey, {
            chunks: [],
            totalSize: op.totalSize,
            binary: op.binary,
            transferId: op.transferId,
            lastActivity: Date.now(),
          });
          break;
        }
        case "chunk-data": {
          const dataKey = op.transferId ?? op.path;
          const assembly = this.pendingChunks.get(dataKey);
          if (assembly) {
            const expectedChunks = Math.ceil(assembly.totalSize / CHUNK_SIZE);
            if (op.index < 0 || op.index >= expectedChunks) break;
            assembly.chunks[op.index] = op.data;
            assembly.lastActivity = Date.now();
          }
          break;
        }
        case "chunk-end": {
          const endKey = op.transferId ?? op.path;
          const assembly = this.pendingChunks.get(endKey);
          if (!assembly) break;

          const expectedChunks = Math.ceil(assembly.totalSize / CHUNK_SIZE);
          const missingSeqs: number[] = [];
          for (let i = 0; i < expectedChunks; i++) {
            if (assembly.chunks[i] === undefined) missingSeqs.push(i);
          }
          if (missingSeqs.length > 0) {
            if (assembly.transferId) {
              const receivedSeqs: number[] = [];
              for (let i = 0; i < expectedChunks; i++) {
                if (assembly.chunks[i] !== undefined) receivedSeqs.push(i);
              }
              this.sendOp?.({
                type: "chunk-resume",
                path: op.path,
                transferId: assembly.transferId,
                receivedSeqs,
              });
              break;
            }
            this.pendingChunks.delete(endKey);
            new Notice(`Live Share: incomplete transfer for ${op.path}, some chunks were lost`);
            break;
          }

          this.pendingChunks.delete(endKey);
          const joined = assembly.chunks.join("");
          const exists = this.vault.getAbstractFileByPath(op.path);
          if (!exists) {
            const parentDir = op.path.substring(0, op.path.lastIndexOf("/"));
            if (parentDir) await ensureFolder(this.vault, parentDir);
          }
          if (assembly.binary) {
            const binaryData = base64ToArrayBuffer(joined);
            await this.vault.adapter.writeBinary(op.path, binaryData);
          } else {
            await this.vault.adapter.write(op.path, joined);
          }
          break;
        }
        case "chunk-resume": {
          const transfer = this.outgoingTransfers.get(op.transferId);
          if (!transfer) break;
          transfer.lastActivity = Date.now();
          const receivedSet = new Set(op.receivedSeqs);
          for (let i = 0; i < transfer.totalChunks; i++) {
            if (!receivedSet.has(i)) {
              const chunk = transfer.content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
              this.sendOp?.({
                type: "chunk-data",
                path: transfer.path,
                index: i,
                data: chunk,
                transferId: op.transferId,
              });
            }
          }
          this.sendOp?.({
            type: "chunk-end",
            path: transfer.path,
            transferId: op.transferId,
          });
          break;
        }
        case "folder-create": {
          await ensureFolder(this.vault, op.path);
          break;
        }
      }
    } catch {
      const opPath = "path" in op ? op.path : "unknown";
      new Notice(`Live Share: failed to apply ${op.type} for ${opPath}`);
    } finally {
      setTimeout(() => {
        for (const path of paths) this.unmutePathEvents(path);
      }, VAULT_EVENT_SETTLE_MS);
    }
  }

  async onFileCreate(file: TAbstractFile) {
    const localPath = normalizePath(file.path);
    if (this.isPathMuted(localPath) || !this.sendOp) return;
    const wirePath = toCanonicalPath(localPath);
    if (!(file instanceof TFile)) {
      this.emitOp({ type: "folder-create", path: wirePath });
      return;
    }
    const prev = this.sendQueues.get(localPath) ?? Promise.resolve();
    const binary = !isTextFile(file.path);
    const tfile = file;
    const task = prev.then(async () => {
      if (!this.sendOp) return;
      try {
        if (binary) {
          const binaryContent = await this.vault.readBinary(tfile);
          if (this.isPathMuted(localPath)) return;
          if (binaryContent.byteLength > MAX_FILE_SIZE) {
            new Notice(`Live Share: ${localPath} exceeds 50 MB limit, skipping`);
            return;
          }
          this.sendFileContent(wirePath, arrayBufferToBase64(binaryContent), true);
        } else {
          const content = normalizeLineEndings(await this.vault.read(tfile));
          if (this.isPathMuted(localPath)) return;
          this.sendFileContent(wirePath, content, false);
        }
      } catch {
        // File may have been deleted/renamed before we could read it
        new Notice(`Live Share: failed to sync ${localPath}`);
      }
    });
    this.sendQueues.set(localPath, task);
    await task;
    if (this.sendQueues.get(localPath) === task) this.sendQueues.delete(localPath);
  }

  async onFileModify(file: TAbstractFile) {
    const localPath = normalizePath(file.path);
    if (this.isPathMuted(localPath) || !this.sendOp) return;
    if (!(file instanceof TFile)) return;
    const binary = !isTextFile(file.path);
    if (!binary) return;
    const wirePath = toCanonicalPath(localPath);
    const tfile = file;
    const prev = this.sendQueues.get(localPath) ?? Promise.resolve();
    const task = prev.then(async () => {
      if (!this.sendOp) return;
      try {
        const binaryContent = await this.vault.readBinary(tfile);
        if (this.isPathMuted(localPath)) return;
        if (binaryContent.byteLength > MAX_FILE_SIZE) {
          new Notice(`Live Share: ${localPath} exceeds 50 MB limit, skipping`);
          return;
        }
        const content = arrayBufferToBase64(binaryContent);
        if (content.length > CHUNK_SIZE) {
          this.sendChunked(wirePath, content, true);
        } else {
          this.emitOp({
            type: "modify",
            path: wirePath,
            content,
            binary: true,
          });
        }
      } catch {
        new Notice(`Live Share: failed to sync ${localPath}`);
      }
    });
    this.sendQueues.set(localPath, task);
    await task;
    if (this.sendQueues.get(localPath) === task) this.sendQueues.delete(localPath);
  }

  onFileDelete(file: TAbstractFile) {
    const localPath = normalizePath(file.path);
    if (this.isPathMuted(localPath) || !this.sendOp) return;
    const wirePath = toCanonicalPath(localPath);
    const prev = this.sendQueues.get(localPath) ?? Promise.resolve();
    const task = prev.then(() => {
      this.emitOp({ type: "delete", path: wirePath });
    });
    this.sendQueues.set(localPath, task);
  }

  onFileRename(file: TAbstractFile, oldPath: string) {
    const localNew = normalizePath(file.path);
    const localOld = normalizePath(oldPath);
    if (this.isPathMuted(localNew) || this.isPathMuted(localOld) || !this.sendOp) return;
    const prev = this.sendQueues.get(localOld) ?? Promise.resolve();
    const task = prev.then(() => {
      this.emitOp({
        type: "rename",
        oldPath: toCanonicalPath(localOld),
        newPath: toCanonicalPath(localNew),
      });
    });
    this.sendQueues.set(localOld, task);
    this.sendQueues.set(localNew, task);
  }

  private sendFileContent(path: string, content: string, binary: boolean) {
    if (content.length > CHUNK_SIZE) {
      this.sendChunked(path, content, binary);
    } else {
      this.emitOp(
        binary
          ? { type: "create", path, content, binary: true }
          : { type: "create", path, content },
      );
    }
  }

  private sendChunked(path: string, content: string, binary: boolean) {
    if (!this.sendOp) return;
    const transferId = crypto.randomUUID();
    const totalChunks = Math.ceil(content.length / CHUNK_SIZE);
    this.outgoingTransfers.set(transferId, {
      path,
      content,
      binary,
      totalChunks,
      lastActivity: Date.now(),
    });
    this.emitOp(
      binary
        ? {
            type: "chunk-start",
            path,
            totalSize: content.length,
            binary: true,
            transferId,
          }
        : { type: "chunk-start", path, totalSize: content.length, transferId },
    );
    for (let i = 0; i < totalChunks; i++) {
      const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.emitOp({
        type: "chunk-data",
        path,
        index: i,
        data: chunk,
        transferId,
      });
    }
    this.emitOp({ type: "chunk-end", path, transferId });
  }
}
