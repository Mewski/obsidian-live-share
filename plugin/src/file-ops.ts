import { Notice } from "obsidian";
import type { TAbstractFile, TFile, Vault } from "obsidian";
import type { FileOp } from "./types";
import { normalizePath } from "./utils";

export class FileOpsManager {
  private vault: Vault;
  private sendOp: ((op: FileOp) => void) | null = null;
  private suppressCount = 0;

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
            await this.vault.create(op.path, op.content);
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
    if ("extension" in file) {
      this.vault
        .read(file as TFile)
        .then((content) => {
          this.sendOp?.({
            type: "create",
            path: normalizePath(file.path),
            content,
          });
        })
        .catch(() => {
          // File may have been deleted before read completed
        });
    }
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
}
