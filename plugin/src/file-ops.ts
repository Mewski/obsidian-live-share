import { Notice, TFolder } from "obsidian";
import type { TAbstractFile, TFile, Vault } from "obsidian";
import type { FileOp } from "./types";
import { arrayBufferToBase64, base64ToArrayBuffer, isTextFile, normalizePath } from "./utils";

const CHUNK_SIZE = 512 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

interface ChunkAssembly {
  chunks: string[];
  totalSize: number;
  binary?: boolean;
}

export class FileOpsManager {
  private vault: Vault;
  private sendOp: ((op: FileOp) => void) | null = null;
  private suppressedPaths = new Map<string, number>();
  private pendingChunks = new Map<string, ChunkAssembly>();
  private opQueues = new Map<string, Promise<void>>();

  constructor(vault: Vault) {
    this.vault = vault;
  }

  setSender(fn: (op: FileOp) => void) {
    this.sendOp = fn;
  }

  suppressPath(path: string): void {
    const norm = normalizePath(path);
    this.suppressedPaths.set(norm, (this.suppressedPaths.get(norm) ?? 0) + 1);
  }

  unsuppressPath(path: string): void {
    const norm = normalizePath(path);
    const count = this.suppressedPaths.get(norm) ?? 0;
    if (count <= 1) {
      this.suppressedPaths.delete(norm);
    } else {
      this.suppressedPaths.set(norm, count - 1);
    }
  }

  isPathSuppressed(path: string): boolean {
    return (this.suppressedPaths.get(normalizePath(path)) ?? 0) > 0;
  }

  /** Clear incomplete chunk assemblies (e.g. after disconnect/reconnect). */
  clearPendingChunks(): void {
    this.pendingChunks.clear();
  }

  private isPathSafe(path: string): boolean {
    if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
    const segments = path.split(/[\\/]/);
    return !segments.some((s) => s === ".." || s === ".");
  }

  async applyRemoteOp(op: FileOp) {
    const paths = this.getOpPaths(op);
    // Serialize operations on the same path to prevent interleaving
    const waitFor = paths.map((p) => this.opQueues.get(p)).filter(Boolean) as Promise<void>[];
    if (waitFor.length > 0) await Promise.all(waitFor);

    const promise = this.applyRemoteOpInner(op);
    for (const p of paths) this.opQueues.set(p, promise);
    await promise;
    for (const p of paths) {
      if (this.opQueues.get(p) === promise) this.opQueues.delete(p);
    }
  }

  private getOpPaths(op: FileOp): string[] {
    const paths: string[] = [];
    if ("path" in op) paths.push(normalizePath(op.path));
    if ("oldPath" in op) paths.push(normalizePath(op.oldPath));
    if ("newPath" in op) paths.push(normalizePath(op.newPath));
    return paths;
  }

  private async applyRemoteOpInner(op: FileOp) {
    if ("path" in op) op.path = normalizePath(op.path);
    if ("oldPath" in op) op.oldPath = normalizePath(op.oldPath);
    if ("newPath" in op) op.newPath = normalizePath(op.newPath);

    if ("path" in op && !this.isPathSafe(op.path)) return;
    if ("oldPath" in op && !this.isPathSafe(op.oldPath)) return;
    if ("newPath" in op && !this.isPathSafe(op.newPath)) return;

    const paths = this.getOpPaths(op);
    for (const p of paths) this.suppressPath(p);
    try {
      switch (op.type) {
        case "create": {
          const exists = this.vault.getAbstractFileByPath(op.path);
          if (exists) {
            if (op.binary) {
              const buf = base64ToArrayBuffer(op.content);
              await this.vault.modifyBinary(exists as TFile, buf);
            } else {
              await this.vault.modify(exists as TFile, op.content);
            }
          } else {
            const dir = op.path.substring(0, op.path.lastIndexOf("/"));
            if (dir) await this.ensureFolder(dir);
            if (op.binary) {
              const buf = base64ToArrayBuffer(op.content);
              await this.vault.createBinary(op.path, buf);
            } else {
              await this.vault.create(op.path, op.content);
            }
          }
          break;
        }
        case "modify": {
          const file = this.vault.getAbstractFileByPath(op.path);
          if (file) {
            if (op.binary) {
              const buf = base64ToArrayBuffer(op.content);
              await this.vault.modifyBinary(file as TFile, buf);
            } else {
              await this.vault.modify(file as TFile, op.content);
            }
          }
          break;
        }
        case "delete": {
          const file = this.vault.getAbstractFileByPath(op.path);
          if (file) {
            await this.vault.trash(file, true);
          }
          break;
        }
        case "rename": {
          const file = this.vault.getAbstractFileByPath(op.oldPath);
          const alreadyExists = this.vault.getAbstractFileByPath(op.newPath);
          if (file && !alreadyExists) {
            const dir = op.newPath.substring(0, op.newPath.lastIndexOf("/"));
            if (dir) await this.ensureFolder(dir);
            await this.vault.rename(file, op.newPath);
          } else if (file && alreadyExists) {
            // Target already exists -- remove old file
            await this.vault.trash(file, true);
          }
          break;
        }
        case "chunk-start": {
          if (op.totalSize > MAX_FILE_SIZE) break;
          this.pendingChunks.set(op.path, {
            chunks: [],
            totalSize: op.totalSize,
            binary: op.binary,
          });
          break;
        }
        case "chunk-data": {
          const assembly = this.pendingChunks.get(op.path);
          if (assembly) {
            assembly.chunks[op.index] = op.data;
          }
          break;
        }
        case "chunk-end": {
          const completed = this.pendingChunks.get(op.path);
          this.pendingChunks.delete(op.path);
          if (!completed) break;

          // Verify all chunks arrived -- sparse array entries would be undefined
          const expectedChunks = Math.ceil(completed.totalSize / CHUNK_SIZE);
          let chunksValid = true;
          for (let i = 0; i < expectedChunks; i++) {
            if (completed.chunks[i] === undefined) {
              chunksValid = false;
              break;
            }
          }
          if (!chunksValid) break;

          const joined = completed.chunks.join("");
          const exists = this.vault.getAbstractFileByPath(op.path);
          if (!exists) {
            const dir = op.path.substring(0, op.path.lastIndexOf("/"));
            if (dir) await this.ensureFolder(dir);
          }
          if (completed.binary) {
            const buf = base64ToArrayBuffer(joined);
            if (exists) {
              await this.vault.modifyBinary(exists as TFile, buf);
            } else {
              await this.vault.createBinary(op.path, buf);
            }
          } else {
            if (exists) {
              await this.vault.modify(exists as TFile, joined);
            } else {
              await this.vault.create(op.path, joined);
            }
          }
          break;
        }
      }
    } catch {
      new Notice(`Live Share: failed to apply remote ${op.type}`);
    } finally {
      // Delay unsuppress so that vault events (which fire asynchronously after
      // the vault operation resolves) still see the path as suppressed.
      // Uses reference counting so concurrent ops on the same path stay suppressed.
      setTimeout(() => {
        for (const p of paths) this.unsuppressPath(p);
      }, 50);
    }
  }

  async onFileCreate(file: TAbstractFile) {
    const path = normalizePath(file.path);
    if (this.isPathSuppressed(path) || !this.sendOp) return;
    if (!("extension" in file)) return;
    const binary = !isTextFile(file.path);
    try {
      if (binary) {
        const buf = await this.vault.readBinary(file as TFile);
        if (this.isPathSuppressed(path)) return;
        if (buf.byteLength > MAX_FILE_SIZE) return;
        this.sendFileContent(path, arrayBufferToBase64(buf), true);
      } else {
        const content = await this.vault.read(file as TFile);
        if (this.isPathSuppressed(path)) return;
        this.sendFileContent(path, content, false);
      }
    } catch {
      // file may have been deleted before we could read it
    }
  }

  async onFileModify(file: TAbstractFile) {
    const path = normalizePath(file.path);
    if (this.isPathSuppressed(path) || !this.sendOp) return;
    if (!("extension" in file)) return;
    const binary = !isTextFile(file.path);
    if (!binary) return; // Text files sync via Yjs
    try {
      const buf = await this.vault.readBinary(file as TFile);
      if (this.isPathSuppressed(path)) return;
      if (buf.byteLength > MAX_FILE_SIZE) return;
      const content = arrayBufferToBase64(buf);
      if (content.length > CHUNK_SIZE) {
        this.sendChunked(path, content, true);
      } else {
        this.sendOp?.({ type: "modify", path, content, binary: true });
      }
    } catch {
      // file may have been deleted before we could read it
    }
  }

  onFileDelete(file: TAbstractFile) {
    const path = normalizePath(file.path);
    if (this.isPathSuppressed(path) || !this.sendOp) return;
    this.sendOp({ type: "delete", path });
  }

  onFileRename(file: TAbstractFile, oldPath: string) {
    const newPath = normalizePath(file.path);
    const oldNorm = normalizePath(oldPath);
    if (this.isPathSuppressed(newPath) || this.isPathSuppressed(oldNorm) || !this.sendOp) return;
    this.sendOp({ type: "rename", oldPath: oldNorm, newPath });
  }

  private sendFileContent(path: string, content: string, binary: boolean) {
    if (content.length > CHUNK_SIZE) {
      this.sendChunked(path, content, binary);
    } else {
      this.sendOp?.({
        type: "create",
        path,
        content,
        binary: binary || undefined,
      });
    }
  }

  private sendChunked(path: string, content: string, binary: boolean) {
    if (!this.sendOp) return;
    const totalChunks = Math.ceil(content.length / CHUNK_SIZE);
    this.sendOp({
      type: "chunk-start",
      path,
      totalSize: content.length,
      binary: binary || undefined,
    });
    for (let i = 0; i < totalChunks; i++) {
      const data = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.sendOp({ type: "chunk-data", path, index: i, data });
    }
    this.sendOp({ type: "chunk-end", path });
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
