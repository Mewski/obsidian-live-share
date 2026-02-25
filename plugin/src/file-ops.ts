import { Notice } from "obsidian";
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
  private suppressCount = 0;
  private pendingChunks = new Map<string, ChunkAssembly>();

  constructor(vault: Vault) {
    this.vault = vault;
  }

  setSender(fn: (op: FileOp) => void) {
    this.sendOp = fn;
  }

  private isPathSafe(path: string): boolean {
    if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
    const segments = path.split(/[\\/]/);
    return !segments.some((s) => s === ".." || s === ".");
  }

  async applyRemoteOp(op: FileOp) {
    if ("path" in op) op.path = normalizePath(op.path);
    if ("oldPath" in op) op.oldPath = normalizePath(op.oldPath);
    if ("newPath" in op) op.newPath = normalizePath(op.newPath);

    if ("path" in op && !this.isPathSafe(op.path)) return;
    if ("oldPath" in op && !this.isPathSafe(op.oldPath)) return;
    if ("newPath" in op && !this.isPathSafe(op.newPath)) return;

    this.suppressCount++;
    try {
      switch (op.type) {
        case "create": {
          const exists = this.vault.getAbstractFileByPath(op.path);
          if (!exists) {
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
          if (file) {
            await this.vault.rename(file, op.newPath);
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

          const joined = completed.chunks.join("");
          const exists = this.vault.getAbstractFileByPath(op.path);
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
    } catch (err) {
      console.error("Live Share: failed to apply remote file op:", err);
      new Notice(`Live Share: failed to apply remote ${op.type}`);
    } finally {
      this.suppressCount--;
    }
  }

  onFileCreate(file: TAbstractFile) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    if (!("extension" in file)) return;
    const binary = !isTextFile(file.path);
    if (binary) {
      this.vault
        .readBinary(file as TFile)
        .then((buf) => {
          if (buf.byteLength > MAX_FILE_SIZE) return;
          this.sendFileContent(normalizePath(file.path), arrayBufferToBase64(buf), true);
        })
        .catch(() => {});
    } else {
      this.vault
        .read(file as TFile)
        .then((content) => {
          this.sendFileContent(normalizePath(file.path), content, false);
        })
        .catch(() => {});
    }
  }

  onFileModify(file: TAbstractFile) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    if (!("extension" in file)) return;
    const binary = !isTextFile(file.path);
    if (!binary) return; // Text files sync via Yjs
    this.vault
      .readBinary(file as TFile)
      .then((buf) => {
        if (buf.byteLength > MAX_FILE_SIZE) return;
        const content = arrayBufferToBase64(buf);
        const path = normalizePath(file.path);
        if (content.length > CHUNK_SIZE) {
          this.sendChunked(path, content, true);
        } else {
          this.sendOp?.({ type: "modify", path, content, binary: true });
        }
      })
      .catch(() => {});
  }

  onFileDelete(file: TAbstractFile) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    this.sendOp({ type: "delete", path: normalizePath(file.path) });
  }

  onFileRename(file: TAbstractFile, oldPath: string) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    this.sendOp({
      type: "rename",
      oldPath: normalizePath(oldPath),
      newPath: normalizePath(file.path),
    });
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
}
