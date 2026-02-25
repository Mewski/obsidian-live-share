import {
  FuzzySuggestModal,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  type TAbstractFile,
  TFile,
} from "obsidian";

import { ApprovalModal, type JoinRequest } from "./approval-modal";
import { AuthManager } from "./auth";
import { BackgroundSync } from "./background-sync";
import { CollabManager } from "./collab";
import { ConnectionStateManager } from "./connection-state";
import { ControlChannel } from "./control-ws";
import { E2ECrypto } from "./crypto";
import { ExclusionManager } from "./exclusion";
import { FileOpsManager } from "./file-ops";
import { type FocusRequest, showFocusNotification } from "./focus-notification";
import { ManifestManager } from "./manifest";
import { PRESENCE_VIEW_TYPE, type PresenceUser, PresenceView } from "./presence-view";
import { SessionManager } from "./session";
import { LiveShareSettingTab } from "./settings";
import { SyncManager } from "./sync";
import { DEFAULT_SETTINGS, type LiveShareSettings } from "./types";
import { ensureFolder, isTextFile, normalizePath } from "./utils";

function getCmView(view: MarkdownView): import("@codemirror/view").EditorView | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: Obsidian does not expose .cm in its public typings
  return (view.editor as any).cm as import("@codemirror/view").EditorView | undefined;
}

export default class LiveSharePlugin extends Plugin {
  settings!: LiveShareSettings;
  syncManager!: SyncManager;
  collabManager!: CollabManager;
  fileOpsManager!: FileOpsManager;
  sessionManager!: SessionManager;
  manifestManager!: ManifestManager;
  authManager!: AuthManager;
  exclusionManager!: ExclusionManager;
  backgroundSync!: BackgroundSync;
  connectionState!: ConnectionStateManager;
  controlChannel: ControlChannel | null = null;
  private remoteUsers = new Map<string, PresenceUser>();
  private isPresenting = false;
  private followTarget: string | null = null;
  private followSuppressUnfollow = false;
  private unfollowListeners: (() => void)[] = [];
  private connectionStateUnsub: (() => void) | null = null;
  statusBarEl!: HTMLElement;

  private isEndingSession = false;

  private requestBinaryFile = (path: string) => {
    this.controlChannel?.send({ type: "sync-request", path });
  };

  private suppressPath = (path: string) => this.fileOpsManager.suppressPath(path);
  private unsuppressPath = (path: string) => this.fileOpsManager.unsuppressPath(path);

  private registerManifestChangeHandler() {
    this.manifestManager.onManifestChange(async (added, removed) => {
      const renamedOld = new Set<string>();
      const renamedNew = new Set<string>();
      if (added.length > 0 && removed.length > 0) {
        for (const oldPath of removed) {
          for (const newPath of added) {
            if (renamedNew.has(newPath)) continue;
            const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
            const newFile = this.app.vault.getAbstractFileByPath(newPath);
            if (oldFile && !newFile) {
              renamedOld.add(oldPath);
              renamedNew.add(newPath);
              this.fileOpsManager.suppressPath(oldPath);
              this.fileOpsManager.suppressPath(newPath);
              try {
                const dir = newPath.substring(0, newPath.lastIndexOf("/"));
                if (dir) await ensureFolder(this.app.vault, dir);
                await this.app.vault.rename(oldFile, newPath);
              } finally {
                setTimeout(() => {
                  this.fileOpsManager.unsuppressPath(oldPath);
                  this.fileOpsManager.unsuppressPath(newPath);
                }, 100);
              }
              if (isTextFile(oldPath)) {
                this.backgroundSync.onFileRemoved(oldPath);
              }
              if (isTextFile(newPath)) {
                await this.backgroundSync.onFileAdded(newPath);
              }
              break;
            }
            if (!oldFile && newFile) {
              renamedOld.add(oldPath);
              renamedNew.add(newPath);
              if (isTextFile(oldPath)) {
                this.backgroundSync.onFileRemoved(oldPath);
              }
              if (isTextFile(newPath)) {
                await this.backgroundSync.onFileAdded(newPath);
              }
              break;
            }
          }
        }
      }

      const actuallyAdded = added.filter((p) => !renamedNew.has(p));
      const actuallyRemoved = removed.filter((p) => !renamedOld.has(p));

      if (actuallyAdded.length > 0) {
        const syncedCount = await this.manifestManager.syncFromManifest(
          this.suppressPath,
          this.unsuppressPath,
          this.requestBinaryFile,
          { skipText: true },
        );
        if (syncedCount > 0) new Notice(`Live Share: synced ${syncedCount} file(s)`);
        for (const path of actuallyAdded) {
          if (isTextFile(path)) {
            await this.backgroundSync.onFileAdded(path);
          }
        }
      }
      for (const path of actuallyRemoved) {
        this.backgroundSync.onFileRemoved(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) await this.app.vault.trash(file, true);
      }
      if (actuallyRemoved.length > 0)
        new Notice(`Live Share: removed ${actuallyRemoved.length} file(s)`);
    });
  }

  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceInterval: ReturnType<typeof setInterval> | null = null;

  private currentScrollListener: (() => void) | null = null;

  private get userId(): string {
    return this.settings.githubUserId || this.settings.clientId;
  }

  async onload() {
    await this.loadSettings();

    if (!this.settings.clientId) {
      this.settings.clientId = crypto.randomUUID();
      await this.saveData(this.settings);
    }

    this.syncManager = new SyncManager(this.settings);
    this.collabManager = new CollabManager();
    this.fileOpsManager = new FileOpsManager(this.app.vault);
    this.sessionManager = new SessionManager(this);
    this.manifestManager = new ManifestManager(this.app.vault, this.settings);
    this.authManager = new AuthManager(this);
    this.exclusionManager = new ExclusionManager();
    await this.exclusionManager.loadConfig(this.app.vault);
    this.manifestManager.setExclusionManager(this.exclusionManager);
    this.backgroundSync = new BackgroundSync(
      this.app.vault,
      this.syncManager,
      this.manifestManager,
      this.fileOpsManager,
    );
    this.connectionState = new ConnectionStateManager();
    this.connectionStateUnsub = this.connectionState.onChange(() => this.updateStatusBar());

    this.registerEditorExtension(this.collabManager.getBaseExtension());

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addEventListener("click", () => this.activatePresenceView());
    this.statusBarEl.addClass("live-share-status-bar");
    this.updateStatusBar();

    this.addCommand({
      id: "start-session",
      name: "Start session",
      callback: () => this.startSession(),
    });

    this.addCommand({
      id: "join-session",
      name: "Join session",
      callback: () => this.joinSession(),
    });

    this.addCommand({
      id: "end-session",
      name: "End session",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        if (checking) return true;
        (async () => {
          const confirmed = await this.confirm(
            "Are you sure you want to end the session? All participants will be disconnected.",
          );
          if (confirmed) this.endSession();
        })();
      },
    });

    this.addCommand({
      id: "leave-session",
      name: "Leave session",
      checkCallback: (checking) => {
        if (this.settings.role !== "guest" || !this.sessionManager.isActive) return false;
        if (checking) return true;
        (async () => {
          const confirmed = await this.confirm("Are you sure you want to leave the session?");
          if (confirmed) this.endSession();
        })();
      },
    });

    this.addCommand({
      id: "copy-invite",
      name: "Copy invite link",
      callback: () => this.sessionManager.copyInvite(),
    });

    this.addCommand({
      id: "show-collaborators",
      name: "Show collaborators panel",
      callback: () => this.activatePresenceView(),
    });

    this.addCommand({
      id: "log-in",
      name: "Log in with GitHub",
      callback: () => this.authManager.authenticate(),
    });

    this.addCommand({
      id: "log-out",
      name: "Log out",
      callback: () => this.authManager.logout(),
    });

    this.addCommand({
      id: "focus-here",
      name: "Focus participants here",
      editorCallback: (editor, view) => {
        const cursor = editor.getCursor();
        const filePath = view.file?.path;
        if (!filePath || !this.controlChannel) return;
        this.controlChannel.send({
          type: "focus-request",
          fromUserId: this.userId,
          fromDisplayName: this.settings.displayName,
          filePath,
          line: cursor.line,
          ch: cursor.ch,
        });
        new Notice("Live Share: focus request sent");
      },
    });

    this.addCommand({
      id: "summon-all",
      name: "Summon all participants here",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView?.file) return false;
        if (checking) return true;
        const cursor = activeView.editor.getCursor();
        this.controlChannel?.send({
          type: "summon",
          fromUserId: this.userId,
          fromDisplayName: this.settings.displayName,
          targetUserId: "__all__",
          filePath: activeView.file.path,
          line: cursor.line,
          ch: cursor.ch,
        });
        new Notice("Live Share: summon sent to all participants");
      },
    });

    this.addCommand({
      id: "reload-from-host",
      name: "Reload all files from host",
      checkCallback: (checking) => {
        if (this.settings.role !== "guest" || !this.sessionManager.isActive) return false;
        if (checking) return true;
        this.reloadFromHost();
      },
    });

    this.addCommand({
      id: "summon-user",
      name: "Summon a specific participant here",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        if (this.remoteUsers.size === 0) return false;
        if (checking) return true;
        new UserPickerModal(this.app, this.remoteUsers, (userId) => {
          this.summonUser(userId);
        }).open();
      },
    });

    this.addCommand({
      id: "toggle-present",
      name: "Toggle presentation mode",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        if (checking) return true;
        this.togglePresent();
      },
    });

    this.registerView(PRESENCE_VIEW_TYPE, (leaf) => {
      const view = new PresenceView(leaf);
      view.setFollowHandler((userId) => this.followUser(userId));
      view.setKickHandler((userId) => this.kickUser(userId));
      view.setSummonHandler((userId) => this.summonUser(userId));
      view.setPermissionHandler((userId) => this.setUserPermission(userId));
      view.setIsHost(this.settings.role === "host");
      return view;
    });

    this.addRibbonIcon("users", "Collaborators", () => {
      this.activatePresenceView();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.onActiveFileChange();
        this.debouncedBroadcastPresence();
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", async (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
        if (this.fileOpsManager.isPathSuppressed(file.path)) return;
        this.fileOpsManager.onFileCreate(file);
        if (this.settings.role === "host") {
          if (file instanceof TFile) {
            try {
              const content = isTextFile(file.path)
                ? await this.app.vault.read(file)
                : await this.app.vault.readBinary(file);
              if (isTextFile(file.path)) {
                await this.backgroundSync.onFileAdded(file.path);
              }
              await this.manifestManager.updateFile(file, content);
            } catch {
              new Notice(`Live Share: failed to update manifest for ${file.path}`);
            }
          } else {
            this.manifestManager.addFolder(file.path);
          }
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
        if (this.fileOpsManager.isPathSuppressed(file.path)) return;
        this.fileOpsManager.onFileDelete(file);
        if (this.settings.role === "host") {
          this.backgroundSync.onFileRemoved(file.path);
          this.manifestManager.removeFile(file.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", async (file: TAbstractFile, oldPath: string) => {
        if (
          !this.manifestManager.isSharedPath(file.path) &&
          !this.manifestManager.isSharedPath(oldPath)
        )
          return;
        if (
          this.fileOpsManager.isPathSuppressed(file.path) ||
          this.fileOpsManager.isPathSuppressed(oldPath)
        )
          return;
        this.fileOpsManager.onFileRename(file, oldPath);
        await this.backgroundSync.onFileRenamed(oldPath, file.path);
        if (this.settings.role === "host") {
          this.manifestManager.renameFile(oldPath, file.path, this.syncManager);
        }
        this.onActiveFileChange();
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file: TAbstractFile) => {
        if (file.path === ".liveshare.json") {
          await this.exclusionManager.loadConfig(this.app.vault);
          if (this.settings.role === "host") {
            await this.manifestManager.publishManifest({ purge: true });
          }
          return;
        }
        if (!(file instanceof TFile) || !this.manifestManager.isSharedPath(file.path)) return;
        if (this.fileOpsManager.isPathSuppressed(file.path)) return;

        if (isTextFile(file.path)) {
          if (this.backgroundSync.isWrittenByUs(file.path)) return;
          if (this.settings.role === "host") {
            await this.backgroundSync.handleLocalTextModify(file.path);
          }
          return;
        }
        this.fileOpsManager.onFileModify(file);
        if (this.settings.role === "host") {
          try {
            const buf = await this.app.vault.readBinary(file);
            await this.manifestManager.updateFile(file, buf);
          } catch {
            new Notice(`Live Share: failed to update manifest for ${file.path}`);
          }
        }
      }),
    );

    this.addSettingTab(new LiveShareSettingTab(this.app, this));

    if (this.settings.roomId && this.settings.token && this.settings.role) {
      try {
        await this.connectSync();
        await this.manifestManager.connect();
        if (this.settings.role === "host") {
          await this.manifestManager.publishManifest();
          await this.backgroundSync.startAll("host");
        } else {
          await this.cleanupStaleFiles();
          await this.manifestManager.syncFromManifest(
            this.suppressPath,
            this.unsuppressPath,
            this.requestBinaryFile,
          );
          await this.backgroundSync.startAll("guest");
          this.registerManifestChangeHandler();
        }
      } catch {
        await this.abortSession("Live Share: failed to resume previous session");
      }
    }
  }

  onunload() {
    this.controlChannel?.destroy();
    this.controlChannel = null;
    this.clearUnfollowListeners();
    this.removeScrollListener();
    this.connectionStateUnsub?.();
    this.connectionStateUnsub = null;
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const cmView = getCmView(activeView);
      if (cmView) this.collabManager.deactivateAll(cmView);
    }

    this.fileOpsManager.clearPendingChunks();
    this.backgroundSync.destroy();
    this.manifestManager.destroy();
    this.syncManager.destroy();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncManager.updateSettings(this.settings);
    this.manifestManager.updateSettings(this.settings);
  }

  private async cleanupStaleFiles() {
    const manifest = this.manifestManager.getEntries();
    if (manifest.size === 0) return;
    const manifestPaths = new Set(manifest.keys());
    const localFiles = this.app.vault
      .getFiles()
      .filter((f) => this.manifestManager.isSharedPath(f.path));
    for (const file of localFiles) {
      if (!manifestPaths.has(normalizePath(file.path))) {
        this.fileOpsManager.suppressPath(file.path);
        try {
          await this.app.vault.trash(file, true);
        } finally {
          setTimeout(() => this.fileOpsManager.unsuppressPath(file.path), 100);
        }
      }
    }
  }

  private async abortSession(message: string) {
    if (this.isEndingSession) return;
    this.isEndingSession = true;
    try {
      new Notice(message);
      this.backgroundSync.destroy();
      this.syncManager.disconnect();
      this.controlChannel?.destroy();
      this.controlChannel = null;
      this.isPresenting = false;
      this.followTarget = null;
      this.clearUnfollowListeners();
      this.removeScrollListener();
      if (this.presenceTimer) {
        clearTimeout(this.presenceTimer);
        this.presenceTimer = null;
      }
      if (this.presenceInterval) {
        clearInterval(this.presenceInterval);
        this.presenceInterval = null;
      }
      this.remoteUsers.clear();
      this.refreshPresenceView();
      this.fileOpsManager.clearPendingChunks();
      this.manifestManager.destroy();
      this.connectionState.transition({ type: "disconnect" });
    } finally {
      await this.sessionManager.endSession();
      this.isEndingSession = false;
    }
  }

  private async startSession() {
    if (this.sessionManager.isActive) {
      new Notice("Live Share: session already active");
      return;
    }

    const ok = await this.sessionManager.startSession();
    if (ok) {
      try {
        await this.connectSync();
        await this.manifestManager.connect();
        await this.manifestManager.publishManifest({ purge: true });
        await this.backgroundSync.startAll("host");
        new Notice("Live Share: session started, invite copied to clipboard");
      } catch {
        await this.abortSession("Live Share: failed to start session");
      }
    }
  }

  private async joinSession() {
    if (this.sessionManager.isActive) {
      new Notice("Live Share: session already active");
      return;
    }

    const invite = await this.promptText("Paste invite link");
    if (!invite) return;

    const ok = await this.sessionManager.joinSession(invite);
    if (ok) {
      try {
        await this.connectSync();
        await this.manifestManager.connect();
        await this.cleanupStaleFiles();
        const syncedCount = await this.manifestManager.syncFromManifest(
          this.suppressPath,
          this.unsuppressPath,
          this.requestBinaryFile,
        );
        await this.backgroundSync.startAll("guest");
        this.registerManifestChangeHandler();
        new Notice(`Live Share: joined session, synced ${syncedCount} file(s)`);
      } catch {
        await this.abortSession("Live Share: failed to join session");
      }
    }
  }

  private async endSession() {
    if (!this.sessionManager.isActive) {
      new Notice("Live Share: no active session");
      return;
    }

    if (this.isEndingSession) return;
    this.isEndingSession = true;

    try {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        const cmView = getCmView(activeView);
        if (cmView) this.collabManager.deactivateAll(cmView);
      }

      if (this.settings.role === "host" && this.controlChannel) {
        this.controlChannel.send({ type: "session-end" });
      }

      this.backgroundSync.destroy();
      this.syncManager.disconnect();
      this.controlChannel?.destroy();
      this.controlChannel = null;
      this.isPresenting = false;
      this.followTarget = null;
      this.clearUnfollowListeners();
      this.removeScrollListener();
      if (this.presenceTimer) {
        clearTimeout(this.presenceTimer);
        this.presenceTimer = null;
      }
      if (this.presenceInterval) {
        clearInterval(this.presenceInterval);
        this.presenceInterval = null;
      }
      this.remoteUsers.clear();
      this.refreshPresenceView();
      this.fileOpsManager.clearPendingChunks();
      this.manifestManager.destroy();
      this.connectionState.transition({ type: "disconnect" });
      new Notice(
        this.settings.role === "host" ? "Live Share: session ended" : "Live Share: left session",
      );
    } finally {
      await this.sessionManager.endSession();
      this.isEndingSession = false;
    }
  }

  private async connectSync() {
    this.connectionState.transition({ type: "connect" });
    this.syncManager.connect();

    if (this.controlChannel) {
      this.controlChannel.destroy();
      this.controlChannel = null;
    }

    let e2e: E2ECrypto | undefined;
    if (this.settings.encryptionPassphrase) {
      e2e = new E2ECrypto(this.settings.encryptionPassphrase);
      await e2e.init();
    }

    this.controlChannel = new ControlChannel(this.settings, e2e);
    this.controlChannel.onStateChange((controlState) => {
      if (controlState === "connected") {
        this.connectionState.transition({ type: "connected" });
      } else {
        this.connectionState.transition({ type: "disconnect" });
        if (this.sessionManager.isActive && !this.isEndingSession) {
          new Notice("Live Share: connection lost, session ended");
          this.endSession();
        }
      }
    });

    this.controlChannel.connect();

    this.fileOpsManager.setSender((op) => {
      if (op.type === "chunk-start" || op.type === "chunk-data" || op.type === "chunk-end") {
        const typeMap = {
          "chunk-start": "file-chunk-start",
          "chunk-data": "file-chunk-data",
          "chunk-end": "file-chunk-end",
        } as const;
        this.controlChannel?.send({ ...op, type: typeMap[op.type] } as never);
      } else {
        this.controlChannel?.send({ type: "file-op", op });
      }
    });
    this.controlChannel.on("file-op", (msg) => {
      const op = msg.op as import("./types").FileOp;
      const paths = [
        "path" in op ? op.path : null,
        "oldPath" in op ? op.oldPath : null,
        "newPath" in op ? op.newPath : null,
      ].filter(Boolean) as string[];
      if (paths.length === 0) return;
      const isRename = op.type === "rename";
      if (isRename) {
        if (!paths.some((path) => this.manifestManager.isSharedPath(path))) return;
      } else {
        if (paths.some((path) => !this.manifestManager.isSharedPath(path))) return;
      }
      this.fileOpsManager
        .applyRemoteOp(op)
        .then(async () => {
          if (this.settings.role !== "host") return;
          if (op.type === "create" && "path" in op) {
            const file = this.app.vault.getAbstractFileByPath(op.path);
            if (file instanceof TFile) {
              const content = isTextFile(file.path)
                ? await this.app.vault.read(file)
                : await this.app.vault.readBinary(file);
              await this.manifestManager.updateFile(file, content);
              if (isTextFile(file.path)) {
                await this.backgroundSync.onFileAdded(file.path);
              }
            }
          } else if (op.type === "delete" && "path" in op) {
            this.manifestManager.removeFile(op.path);
            this.backgroundSync.onFileRemoved(op.path);
          } else if (op.type === "rename" && "oldPath" in op && "newPath" in op) {
            const renameOp = op as { oldPath: string; newPath: string };
            if (isTextFile(renameOp.newPath)) {
              await this.backgroundSync.onFileRenamed(renameOp.oldPath, renameOp.newPath);
            }
            this.manifestManager.renameFile(renameOp.oldPath, renameOp.newPath, this.syncManager);
          }
        })
        .catch(() => {});
    });
    for (const chunkType of ["file-chunk-start", "file-chunk-data", "file-chunk-end"] as const) {
      this.controlChannel.on(chunkType, (msg) => {
        const path = msg.path as string;
        if (!path || !this.manifestManager.isSharedPath(path)) return;
        const typeMap = {
          "file-chunk-start": "chunk-start",
          "file-chunk-data": "chunk-data",
          "file-chunk-end": "chunk-end",
        } as const;
        this.fileOpsManager
          .applyRemoteOp({
            ...msg,
            type: typeMap[chunkType],
          } as never)
          .catch(() => {});
      });
    }
    this.controlChannel.on("presence-update", (msg) => {
      const user = msg as unknown as PresenceUser;
      const isNew = !this.remoteUsers.has(user.userId);
      this.remoteUsers.set(user.userId, user);
      this.refreshPresenceView();
      this.updateStatusBar();
      if (isNew) {
        this.broadcastPresence();
      }
      if (this.followTarget === user.userId) {
        this.applyFollowState(user);
      }
    });
    this.controlChannel.on("presence-leave", (msg) => {
      const userId = msg.userId as string;
      if (userId) {
        const leavingUser = this.remoteUsers.get(userId);
        this.remoteUsers.delete(userId);
        this.refreshPresenceView();
        this.updateStatusBar();
        if (this.followTarget === userId) {
          this.followTarget = null;
          this.clearUnfollowListeners();
        }
        if (leavingUser?.isHost && this.settings.role === "guest") {
          new Notice("Live Share: host disconnected, your changes may not be saved");
        }
      }
    });

    this.controlChannel.on("join-request", (msg) => {
      if (this.settings.role !== "host") return;
      new ApprovalModal(this.app, msg as unknown as JoinRequest, (approved, permission) => {
        this.controlChannel?.send({
          type: "join-response",
          userId: msg.userId as string,
          approved,
          permission,
        });
        if (approved) {
          const existing = this.remoteUsers.get(msg.userId as string);
          if (existing) existing.permission = permission;
        }
      }).open();
    });

    this.controlChannel.on("join-response", async (msg) => {
      if (this.settings.role !== "guest") return;
      if (msg.approved === false) {
        new Notice("Live Share: join request denied by host");
        this.endSession();
        return;
      }
      const permission = msg.permission as string | undefined;
      if (permission === "read-only" || permission === "read-write") {
        this.settings.permission = permission;
        await this.saveSettings();
      }
      this.broadcastPresence();
    });

    this.controlChannel.on("permission-update", async (msg) => {
      const permission = msg.permission as string | undefined;
      if (permission !== "read-only" && permission !== "read-write") return;
      this.settings.permission = permission;
      await this.saveSettings();

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const cmView = activeView ? getCmView(activeView) : undefined;
      if (cmView) this.collabManager.deactivateAll(cmView);

      const activeFilePath = activeView?.file?.path ?? null;
      const activeSharedPath =
        activeFilePath &&
        this.manifestManager.isSharedPath(activeFilePath) &&
        isTextFile(activeFilePath)
          ? activeFilePath
          : null;

      this.backgroundSync.destroy();
      this.syncManager.disconnect();
      this.manifestManager.destroy();
      this.syncManager.updateSettings(this.settings);
      this.manifestManager.updateSettings(this.settings);
      try {
        this.syncManager.connect();
        await this.manifestManager.connect();
        this.backgroundSync.setActiveFile(activeSharedPath);
        await this.backgroundSync.startAll(this.settings.role ?? "guest");
        this.registerManifestChangeHandler();
        this.onActiveFileChange();
        new Notice(`Live Share: your permission was changed to ${permission}`);
      } catch {
        new Notice("Live Share: permission changed but sync restart failed");
      }
    });

    this.controlChannel.on("focus-request", (msg) => {
      showFocusNotification(this, msg as unknown as FocusRequest);
    });
    this.controlChannel.on("summon", async (msg) => {
      const req = msg as unknown as FocusRequest;
      const file = this.app.vault.getAbstractFileByPath(req.filePath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
          view.editor.setCursor({ line: req.line, ch: req.ch });
          view.editor.scrollIntoView(
            { from: { line: req.line, ch: 0 }, to: { line: req.line, ch: 0 } },
            true,
          );
        }
      }
      new Notice(
        `Live Share: ${req.fromDisplayName} summoned you to ${req.filePath}:${req.line + 1}`,
      );
    });

    this.controlChannel.on("present-start", (msg) => {
      if (this.settings.role === "host") return;
      const hostUserId = msg.userId as string;
      if (!hostUserId) return;
      this.clearUnfollowListeners();
      this.followTarget = hostUserId;
      const user = this.remoteUsers.get(hostUserId);
      if (user) this.applyFollowState(user);
      new Notice("Live Share: host started presenting, now following");
    });

    this.controlChannel.on("present-stop", (msg) => {
      if (this.settings.role === "host") return;
      const hostUserId = msg.userId as string;
      if (hostUserId && this.followTarget === hostUserId) {
        this.followTarget = null;
        this.clearUnfollowListeners();
        new Notice("Live Share: host stopped presenting");
      }
    });

    this.controlChannel.on("sync-request", async (msg) => {
      if (this.settings.role !== "host") return;
      const path = msg.path as string | undefined;
      if (path && this.manifestManager.isSharedPath(path)) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          this.fileOpsManager.onFileCreate(file);
        }
      }
    });

    this.controlChannel.on("kicked", () => {
      new Notice("Live Share: you have been removed from the session");
      this.endSession();
    });

    this.controlChannel.on("session-end", () => {
      new Notice("Live Share: the host ended the session");
      this.endSession();
    });

    if (this.settings.role === "guest") {
      this.controlChannel.send({
        type: "join-request",
        userId: this.userId,
        displayName: this.settings.displayName,
        avatarUrl: this.settings.avatarUrl,
      });
    }

    this.broadcastPresence();
    if (this.presenceInterval) clearInterval(this.presenceInterval);
    this.presenceInterval = setInterval(() => this.broadcastPresence(), 10_000);

    this.onActiveFileChange();
  }

  private onActiveFileChange() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const file = view.file;
    const cmView = getCmView(view);
    if (!cmView) return;

    const filePath = file?.path ?? null;
    const sharedPath =
      filePath && this.manifestManager.isSharedPath(filePath) && isTextFile(filePath)
        ? filePath
        : null;
    this.backgroundSync.setActiveFile(sharedPath);
    this.collabManager.activateForFile(
      cmView,
      sharedPath,
      this.syncManager,
      this.settings.role,
      this.settings.permission,
    );

    this.removeScrollListener();
    const scrollDOM = cmView.scrollDOM;
    const scrollHandler = () => {
      this.debouncedBroadcastPresence();
    };
    scrollDOM.addEventListener("scroll", scrollHandler);
    this.currentScrollListener = () => scrollDOM.removeEventListener("scroll", scrollHandler);
  }

  private removeScrollListener() {
    if (this.currentScrollListener) {
      this.currentScrollListener();
      this.currentScrollListener = null;
    }
  }

  private updateStatusBar() {
    const state = this.connectionState.getState();
    switch (state) {
      case "disconnected":
        this.statusBarEl.setText("Live Share: off");
        break;
      case "connecting":
        this.statusBarEl.setText("Live Share: connecting...");
        break;
      case "connected": {
        const count = this.remoteUsers.size;
        const role = this.settings.role === "host" ? "hosting" : "joined";
        const users = count > 0 ? ` (${count + 1})` : "";
        const latency = this.controlChannel?.getLatency();
        const latencyStr = latency ? ` ${latency}ms` : "";
        const presentingLabel = this.isPresenting ? " [presenting]" : "";
        this.statusBarEl.setText(`Live Share: ${role}${users}${latencyStr}${presentingLabel}`);
        break;
      }
      case "error":
        this.statusBarEl.setText("Live Share: error");
        break;
      case "auth-required":
        this.statusBarEl.setText("Live Share: auth needed");
        break;
    }
  }

  private debouncedBroadcastPresence() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.broadcastPresence();
    }, 200);
  }

  private broadcastPresence() {
    if (!this.controlChannel) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const currentFile = normalizePath(view?.file?.path ?? "");
    let scrollTop = 0;
    let line = 0;
    if (view) {
      const cmView = getCmView(view);
      if (cmView) scrollTop = cmView.scrollDOM.scrollTop;
      const cursor = view.editor.getCursor();
      line = cursor.line;
    }
    this.controlChannel.send({
      type: "presence-update",
      userId: this.userId,
      displayName: this.settings.displayName,
      cursorColor: this.settings.cursorColor,
      currentFile,
      scrollTop,
      line,
      isHost: this.settings.role === "host",
    });
  }

  private async activatePresenceView() {
    const existing = this.app.workspace.getLeavesOfType(PRESENCE_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: PRESENCE_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private refreshPresenceView() {
    const leaves = this.app.workspace.getLeavesOfType(PRESENCE_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as PresenceView;
      view.updateState(this.remoteUsers, this.settings.role === "host", this.followTarget);
    }
  }

  private async kickUser(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    const user = this.remoteUsers.get(userId);
    const name = user?.displayName ?? userId;
    const confirmed = await this.confirm(`Kick ${name} from the session?`);
    if (!confirmed) return;
    this.controlChannel.send({ type: "kick", userId });
    this.remoteUsers.delete(userId);
    this.refreshPresenceView();
    this.updateStatusBar();
    new Notice(`Live Share: kicked ${name}`);
  }

  private setUserPermission(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    const user = this.remoteUsers.get(userId);
    if (!user) return;
    const currentPermission = user.permission ?? "read-write";
    const newPermission = currentPermission === "read-write" ? "read-only" : "read-write";
    this.controlChannel.send({
      type: "set-permission",
      userId,
      permission: newPermission,
    });
    user.permission = newPermission;
    this.refreshPresenceView();
    new Notice(`Live Share: set ${user.displayName} to ${newPermission}`);
  }

  private async reloadFromHost() {
    if (!this.controlChannel) return;
    new Notice("Live Share: reloading all files from host...");
    const syncedCount = await this.manifestManager.syncFromManifest(
      this.suppressPath,
      this.unsuppressPath,
      this.requestBinaryFile,
    );
    if (syncedCount > 0) new Notice(`Live Share: reloaded ${syncedCount} file(s) from host`);
  }

  private summonUser(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cursor = view?.editor?.getCursor();
    const filePath = view?.file?.path;
    if (!filePath) {
      new Notice("Live Share: open a file first to summon");
      return;
    }
    this.controlChannel.send({
      type: "summon",
      fromUserId: this.userId,
      fromDisplayName: this.settings.displayName,
      targetUserId: userId,
      filePath,
      line: cursor?.line ?? 0,
      ch: cursor?.ch ?? 0,
    });
    const user = this.remoteUsers.get(userId);
    new Notice(`Live Share: summoned ${user?.displayName ?? userId}`);
  }

  private togglePresent() {
    this.isPresenting = !this.isPresenting;
    if (this.isPresenting) {
      this.controlChannel?.send({
        type: "present-start",
        userId: this.userId,
      });
      new Notice("Live Share: presentation mode ON");
    } else {
      this.controlChannel?.send({
        type: "present-stop",
        userId: this.userId,
      });
      new Notice("Live Share: presentation mode OFF");
    }
    this.updateStatusBar();
  }

  followUser(userId: string) {
    if (this.followTarget === userId) {
      this.unfollowUser();
      return;
    }
    this.followTarget = userId;
    const user = this.remoteUsers.get(userId);
    new Notice(`Live Share: following ${user?.displayName ?? userId}`);

    this.clearUnfollowListeners();
    const handler = () => {
      if (!this.followSuppressUnfollow) this.unfollowUser();
    };
    const events = ["keydown", "mousedown", "wheel"] as const;
    for (const evt of events) {
      document.addEventListener(evt, handler);
      this.unfollowListeners.push(() => document.removeEventListener(evt, handler));
    }

    if (user) this.applyFollowState(user);
  }

  private unfollowUser() {
    if (!this.followTarget) return;
    this.followTarget = null;
    this.clearUnfollowListeners();
    new Notice("Live Share: stopped following");
  }

  private clearUnfollowListeners() {
    for (const cleanup of this.unfollowListeners) cleanup();
    this.unfollowListeners = [];
  }

  private async applyFollowState(user: PresenceUser) {
    if (!user.currentFile) return;

    this.followSuppressUnfollow = true;

    const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (currentView?.file?.path !== user.currentFile) {
      const file = this.app.vault.getAbstractFileByPath(user.currentFile);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    }

    if (user.scrollTop !== undefined) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        const cmView = getCmView(view);
        if (cmView) {
          cmView.scrollDOM.scrollTop = user.scrollTop;
        }
      }
    }

    this.followSuppressUnfollow = false;
  }

  promptText(placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new PromptModal(this.app, placeholder, resolve);
      modal.open();
    });
  }

  private confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, message, resolve);
      modal.open();
    });
  }
}

class PromptModal extends Modal {
  private result: string | null = null;
  private placeholder: string;
  private resolve: (value: string | null) => void;

  constructor(
    app: import("obsidian").App,
    placeholder: string,
    resolve: (value: string | null) => void,
  ) {
    super(app);
    this.setTitle("Live Share");
    this.placeholder = placeholder;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: this.placeholder,
      cls: "live-share-prompt-input",
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.result = input.value;
        this.close();
      }
    });
    const btn = contentEl.createEl("button", { text: "OK" });
    btn.addEventListener("click", () => {
      this.result = input.value;
      this.close();
    });
    input.focus();
  }

  onClose() {
    this.resolve(this.result || null);
    this.contentEl.empty();
  }
}

class UserPickerModal extends FuzzySuggestModal<string> {
  private users: Map<string, { displayName: string }>;
  private onChoose: (userId: string) => void;

  constructor(
    app: import("obsidian").App,
    users: Map<string, { displayName: string }>,
    onChoose: (userId: string) => void,
  ) {
    super(app);
    this.users = users;
    this.onChoose = onChoose;
  }

  getItems(): string[] {
    return Array.from(this.users.keys());
  }

  getItemText(userId: string): string {
    return this.users.get(userId)?.displayName ?? userId;
  }

  onChooseItem(userId: string): void {
    this.onChoose(userId);
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private resolve: (value: boolean) => void;
  private hasDecided = false;

  constructor(app: import("obsidian").App, message: string, resolve: (value: boolean) => void) {
    super(app);
    this.setTitle("Live Share");
    this.message = message;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const buttons = contentEl.createDiv({ cls: "live-share-confirm-buttons" });
    const confirm = buttons.createEl("button", {
      text: "Confirm",
      cls: "mod-warning",
    });
    confirm.addEventListener("click", () => {
      this.hasDecided = true;
      this.resolve(true);
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.hasDecided = true;
      this.resolve(false);
      this.close();
    });
  }

  onClose() {
    if (!this.hasDecided) this.resolve(false);
    this.contentEl.empty();
  }
}
