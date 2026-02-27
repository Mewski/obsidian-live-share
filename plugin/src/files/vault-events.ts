import { MarkdownView, Notice, type TAbstractFile, TFile } from "obsidian";

import type LiveSharePlugin from "../main";
import { isTextFile } from "../utils";

export function registerVaultEvents(plugin: LiveSharePlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on("active-leaf-change", () => {
      plugin.onActiveFileChange();
      plugin.presenceManager?.debouncedBroadcastPresence();
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("create", async (file: TAbstractFile) => {
      if (!plugin.manifestManager.isSharedPath(file.path)) return;
      if (plugin.fileOpsManager.isPathMuted(file.path)) return;
      plugin.fileOpsManager.onFileCreate(file);
      if (plugin.settings.role === "host") {
        if (file instanceof TFile) {
          try {
            const content = isTextFile(file.path)
              ? await plugin.app.vault.read(file)
              : await plugin.app.vault.readBinary(file);
            if (isTextFile(file.path)) {
              await plugin.backgroundSync.onFileAdded(file.path);
              plugin.versionHistory.trackFile(file.path);
            }
            await plugin.manifestManager.updateFile(file, content);
          } catch {
            new Notice(`Live Share: failed to update manifest for ${file.path}`);
          }
        } else {
          plugin.manifestManager.addFolder(file.path);
        }
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("delete", (file: TAbstractFile) => {
      if (!plugin.manifestManager.isSharedPath(file.path)) return;
      if (plugin.fileOpsManager.isPathMuted(file.path)) return;
      plugin.fileOpsManager.onFileDelete(file);
      if (plugin.settings.role === "host") {
        plugin.backgroundSync.onFileRemoved(file.path);
        plugin.versionHistory.untrackFile(file.path);
        plugin.manifestManager.removeFile(file.path);
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("rename", async (file: TAbstractFile, oldPath: string) => {
      if (
        !plugin.manifestManager.isSharedPath(file.path) &&
        !plugin.manifestManager.isSharedPath(oldPath)
      )
        return;
      if (
        plugin.fileOpsManager.isPathMuted(file.path) ||
        plugin.fileOpsManager.isPathMuted(oldPath)
      )
        return;
      plugin.fileOpsManager.onFileRename(file, oldPath);
      await plugin.backgroundSync.onFileRenamed(oldPath, file.path);
      plugin.versionHistory.untrackFile(oldPath);
      if (isTextFile(file.path)) {
        plugin.versionHistory.trackFile(file.path);
      }
      if (plugin.settings.role === "host") {
        plugin.manifestManager.renameFile(oldPath, file.path, plugin.syncManager);
      }
      const activeFile = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (activeFile && (activeFile.path === file.path || activeFile.path === oldPath)) {
        plugin.onActiveFileChange();
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("modify", async (file: TAbstractFile) => {
      if (!(file instanceof TFile) || !plugin.manifestManager.isSharedPath(file.path)) return;
      if (plugin.fileOpsManager.isPathMuted(file.path)) return;

      if (isTextFile(file.path)) {
        if (plugin.backgroundSync.isRecentDiskWrite(file.path)) return;
        if (
          file.path.endsWith(".canvas") &&
          plugin.canvasSync?.isSubscribed(file.path) &&
          !plugin.canvasSync.isRecentDiskWrite(file.path)
        ) {
          await plugin.canvasSync.handleLocalModify(file.path);
        }
        if (plugin.settings.role === "host") {
          await plugin.backgroundSync.handleLocalTextModify(file.path);
        }
        return;
      }
      plugin.fileOpsManager.onFileModify(file);
      if (plugin.settings.role === "host") {
        try {
          const buf = await plugin.app.vault.readBinary(file);
          await plugin.manifestManager.updateFile(file, buf);
        } catch {
          new Notice(`Live Share: failed to update manifest for ${file.path}`);
        }
      }
    }),
  );
}
