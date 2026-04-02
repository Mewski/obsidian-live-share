import { MarkdownView, Notice, type TAbstractFile, TFile } from "obsidian";

import type LiveSharePlugin from "../main";
import { isTextFile } from "../utils";

export function registerVaultEvents(plugin: LiveSharePlugin): void {
  let pendingRename: Promise<void> | null = null;
  const renamedPaths = new Set<string>();

  plugin.registerEvent(
    plugin.app.workspace.on("active-leaf-change", () => {
      const run = () => {
        plugin.onActiveFileChange();
        plugin.presenceManager?.debouncedBroadcastPresence();
      };
      if (pendingRename) {
        void pendingRename.then(run);
      } else {
        run();
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("create", (file: TAbstractFile) => {
      const originalPath = file.path;
      if (!plugin.manifestManager.isSharedPath(originalPath)) return;
      if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
      if (renamedPaths.has(originalPath)) return;
      void plugin.fileOpsManager.onFileCreate(file);
      if (plugin.settings.role === "host") {
        if (file instanceof TFile) {
          void (async () => {
            try {
              const content = isTextFile(originalPath)
                ? await plugin.app.vault.read(file)
                : await plugin.app.vault.readBinary(file);
              if (renamedPaths.has(originalPath)) return;
              if (isTextFile(originalPath)) {
                await plugin.backgroundSync.onFileAdded(originalPath);
              }
              if (renamedPaths.has(originalPath)) return;
              await plugin.manifestManager.updateFile(file, content);
            } catch {
              if (!renamedPaths.has(originalPath)) {
                new Notice(`Live Share: failed to update manifest for ${originalPath}`);
              }
            }
          })();
        } else {
          plugin.manifestManager.addFolder(originalPath);
        }
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("delete", (file: TAbstractFile) => {
      const run = () => {
        if (!plugin.manifestManager.isSharedPath(file.path)) return;
        if (plugin.fileOpsManager.isPathMuted(file.path)) return;
        plugin.fileOpsManager.onFileDelete(file);
        if (plugin.settings.role === "host") {
          plugin.backgroundSync.onFileRemoved(file.path);
          plugin.manifestManager.removeFile(file.path);
        }
      };
      if (pendingRename) {
        void pendingRename.then(run);
      } else {
        run();
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
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

      renamedPaths.add(oldPath);

      const prev = pendingRename ?? Promise.resolve();
      const task = prev.then(async () => {
        plugin.fileOpsManager.onFileRename(file, oldPath);
        plugin.backgroundSync.cancelSubscribe(oldPath);
        await plugin.backgroundSync.onFileRenamed(oldPath, file.path);
        if (plugin.settings.role === "host") {
          plugin.manifestManager.renameFile(oldPath, file.path, plugin.syncManager);
        }
        const activeFile = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (activeFile && (activeFile.path === file.path || activeFile.path === oldPath)) {
          plugin.onActiveFileChange();
        }
      });
      pendingRename = task.finally(() => {
        if (pendingRename === task) pendingRename = null;
        renamedPaths.delete(oldPath);
      });
    }),
  );

  plugin.registerEvent(
    plugin.app.vault.on("modify", (file: TAbstractFile) => {
      if (!(file instanceof TFile) || !plugin.manifestManager.isSharedPath(file.path)) return;
      if (plugin.fileOpsManager.isPathMuted(file.path)) return;

      if (isTextFile(file.path)) {
        if (plugin.backgroundSync.isRecentDiskWrite(file.path)) return;
        if (
          file.path.endsWith(".canvas") &&
          plugin.canvasSync?.isSubscribed(file.path) &&
          !plugin.canvasSync.isRecentDiskWrite(file.path)
        ) {
          void plugin.canvasSync.handleLocalModify(file.path);
        }
        if (plugin.settings.role === "host") {
          void plugin.backgroundSync.handleLocalTextModify(file.path);
        }
        return;
      }
      void plugin.fileOpsManager.onFileModify(file);
      if (plugin.settings.role === "host") {
        void (async () => {
          try {
            const buf = await plugin.app.vault.readBinary(file);
            await plugin.manifestManager.updateFile(file, buf);
          } catch {
            new Notice(`Live Share: failed to update manifest for ${file.path}`);
          }
        })();
      }
    }),
  );
}
