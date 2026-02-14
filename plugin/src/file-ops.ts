import type { Vault, TFile, TAbstractFile } from "obsidian";
import type { FileOp } from "./types";

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

  // Validate that a path is safe (no traversal, no absolute paths)
  private isPathSafe(path: string): boolean {
    if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
    const segments = path.split(/[\\/]/);
    return !segments.some((s) => s === ".." || s === ".");
  }

  // Called when a remote file op is received -- apply locally without re-broadcasting
  async applyRemoteOp(op: FileOp) {
    // Validate all paths in the operation
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
            await this.vault.delete(file);
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
    } finally {
      this.suppressCount--;
    }
  }

  // Vault event handlers -- broadcast local changes
  onFileCreate(file: TAbstractFile) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    if ("extension" in file) {
      // It's a TFile
      this.vault.read(file as TFile).then((content) => {
        this.sendOp!({ type: "create", path: file.path, content });
      });
    }
  }

  onFileDelete(file: TAbstractFile) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    this.sendOp({ type: "delete", path: file.path });
  }

  onFileRename(file: TAbstractFile, oldPath: string) {
    if (this.suppressCount > 0 || !this.sendOp) return;
    this.sendOp({ type: "rename", oldPath, newPath: file.path });
  }
}
