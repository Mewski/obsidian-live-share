import type { EditorView } from "@codemirror/view";
import { MarkdownView, Menu, Notice, Plugin, type TAbstractFile, TFile } from "obsidian";

import { ApprovalModal } from "./approval-modal";
import { AuditLogModal } from "./audit-modal";
import { AuthManager } from "./auth";
import { BackgroundSync } from "./background-sync";
import { CanvasSync } from "./canvas-sync";
import { CollabManager } from "./collab";
import { AddCommentModal, CommentListModal, CommentThreadModal } from "./comment-modal";
import { CommentManager } from "./comments";
import { ConnectionStateManager } from "./connection-state";
import { ControlChannel } from "./control-ws";
import { E2ECrypto } from "./crypto";
import { DebugLogger } from "./debug-logger";
import { ExclusionManager } from "./exclusion";
import { ExplorerIndicators } from "./explorer-indicators";
import { FileOpsManager } from "./file-ops";
import { FilePermissionModal, type FilePermissionUser } from "./file-permission-modal";
import { showFocusNotification } from "./focus-notification";
import { HistoryModal } from "./history-modal";
import { ManifestManager } from "./manifest";
import { ConfirmModal, PromptModal, UserPickerModal } from "./modals";
import { PRESENCE_VIEW_TYPE, type PresenceUser, PresenceView } from "./presence-view";
import { SessionManager } from "./session";
import { LiveShareSettingTab } from "./settings";
import { SyncManager } from "./sync";
import {
  type ControlMessage,
  DEFAULT_SETTINGS,
  type FileOp,
  type LiveShareSettings,
  type Permission,
} from "./types";
import {
  VAULT_EVENT_SETTLE_MS,
  ensureFolder,
  isTextFile,
  normalizePath,
  parseJwtPayload,
} from "./utils";
import { VersionHistoryManager } from "./version-history";

function getCmView(view: MarkdownView): EditorView | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: Obsidian does not expose .cm in its public typings
  return (view.editor as any).cm as EditorView | undefined;
}

const CHUNK_TO_CONTROL = {
  "chunk-start": "file-chunk-start",
  "chunk-data": "file-chunk-data",
  "chunk-end": "file-chunk-end",
  "chunk-resume": "file-chunk-resume",
} as const;

const CONTROL_TO_CHUNK = Object.fromEntries(
  Object.entries(CHUNK_TO_CONTROL).map(([k, v]) => [v, k]),
) as Record<
  (typeof CHUNK_TO_CONTROL)[keyof typeof CHUNK_TO_CONTROL],
  keyof typeof CHUNK_TO_CONTROL
>;

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
  logger!: DebugLogger;
  versionHistory!: VersionHistoryManager;
  commentManager: CommentManager | null = null;
  canvasSync: CanvasSync | null = null;
  explorerIndicators: ExplorerIndicators | null = null;
  controlChannel: ControlChannel | null = null;
  private remoteUsers = new Map<string, PresenceUser>();
  private filePermissions = new Map<string, Permission>();
  private isPresenting = false;
  private followTarget: string | null = null;
  private followSuppressUnfollow = false;
  private unfollowListeners: (() => void)[] = [];
  private connectionStateUnsub: (() => void) | null = null;
  statusBarEl!: HTMLElement;
  private isEndingSession = false;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceInterval: ReturnType<typeof setInterval> | null = null;
  private currentScrollListener: (() => void) | null = null;
  private isApplyingFollow = false;

  private requestBinaryFile = (path: string) => {
    this.controlChannel?.send({ type: "sync-request", path });
  };

  private mutePathEvents = (path: string) => this.fileOpsManager.mutePathEvents(path);
  private unmutePathEvents = (path: string) => this.fileOpsManager.unmutePathEvents(path);

  private registerManifestChangeHandler() {
    this.manifestManager.setManifestChangeHandler(async (added, removed) => {
      const renamedOldPaths = new Set<string>();
      const renamedNewPaths = new Set<string>();
      if (added.length > 0 && removed.length > 0) {
        for (const oldPath of removed) {
          for (const newPath of added) {
            if (renamedNewPaths.has(newPath)) continue;
            const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
            const newFile = this.app.vault.getAbstractFileByPath(newPath);
            if (oldFile && !newFile) {
              renamedOldPaths.add(oldPath);
              renamedNewPaths.add(newPath);
              this.fileOpsManager.mutePathEvents(oldPath);
              this.fileOpsManager.mutePathEvents(newPath);
              try {
                const dir = newPath.substring(0, newPath.lastIndexOf("/"));
                if (dir) await ensureFolder(this.app.vault, dir);
                await this.app.vault.rename(oldFile, newPath);
              } finally {
                setTimeout(() => {
                  this.fileOpsManager.unmutePathEvents(oldPath);
                  this.fileOpsManager.unmutePathEvents(newPath);
                }, VAULT_EVENT_SETTLE_MS);
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
              renamedOldPaths.add(oldPath);
              renamedNewPaths.add(newPath);
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

      const actuallyAdded = added.filter((path) => !renamedNewPaths.has(path));
      const actuallyRemoved = removed.filter((path) => !renamedOldPaths.has(path));

      if (actuallyAdded.length > 0) {
        const syncedCount = await this.manifestManager.syncFromManifest(
          this.mutePathEvents,
          this.unmutePathEvents,
          this.requestBinaryFile,
          { skipText: true },
        );
        if (syncedCount > 0) this.notify(`Live Share: synced ${syncedCount} file(s)`);
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
        this.notify(`Live Share: removed ${actuallyRemoved.length} file(s)`);
    });
  }

  private get userId(): string {
    return this.settings.githubUserId || this.settings.clientId;
  }

  async onload() {
    await this.loadSettings();

    if (!this.settings.clientId) {
      this.settings.clientId = crypto.randomUUID();
      await this.saveData(this.settings);
    }

    if (this.settings.excludePatterns.length === 0) {
      try {
        const configFile = this.app.vault.getAbstractFileByPath(".liveshare.json");
        if (configFile && configFile instanceof TFile) {
          const content = await this.app.vault.read(configFile);
          const config = JSON.parse(content);
          if (Array.isArray(config.exclude) && config.exclude.length > 0) {
            this.settings.excludePatterns = config.exclude;
            await this.saveData(this.settings);
          }
        }
      } catch {
        // ignore malformed .liveshare.json during migration
      }
    }

    this.syncManager = new SyncManager(this.settings);
    this.collabManager = new CollabManager();
    this.fileOpsManager = new FileOpsManager(this.app.vault);
    this.sessionManager = new SessionManager(this);
    this.manifestManager = new ManifestManager(this.app.vault, this.settings);
    this.authManager = new AuthManager(this);
    this.exclusionManager = new ExclusionManager();
    this.exclusionManager.setPatterns(this.settings.excludePatterns);
    this.manifestManager.setExclusionManager(this.exclusionManager);
    this.backgroundSync = new BackgroundSync(
      this.app.vault,
      this.syncManager,
      this.manifestManager,
      this.fileOpsManager,
    );
    this.connectionState = new ConnectionStateManager();
    this.logger = new DebugLogger(
      this.app.vault,
      this.settings.debugLogPath,
      this.settings.debugLogging,
    );
    this.versionHistory = new VersionHistoryManager(
      this.syncManager,
      this.userId,
      this.settings.displayName,
    );
    this.loadVersionHistory();
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
        })().catch(() => {});
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
        })().catch(() => {});
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
        this.notify("Live Share: focus request sent");
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
        this.notify("Live Share: summon sent to all participants");
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

    this.addCommand({
      id: "transfer-host",
      name: "Transfer host role",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        if (this.remoteUsers.size === 0) return false;
        if (checking) return true;
        new UserPickerModal(this.app, this.remoteUsers, (userId) => {
          this.controlChannel?.send({
            type: "host-transfer-offer",
            userId,
          });
          const user = this.remoteUsers.get(userId);
          this.notify(`Live Share: offered host role to ${user?.displayName ?? userId}`);
        }).open();
      },
    });

    this.addCommand({
      id: "show-version-history",
      name: "Show version history",
      editorCallback: (_editor, view) => {
        if (!view.file) return;
        const filePath = view.file.path;
        const snapshots = this.versionHistory.getSnapshots(filePath);
        new HistoryModal(
          this.app,
          filePath,
          snapshots,
          (index) => this.versionHistory.restoreSnapshot(filePath, index),
          (index) => {
            this.versionHistory.applySnapshot(filePath, index);
            this.saveVersionHistory();
          },
        ).open();
      },
    });

    this.addCommand({
      id: "create-snapshot",
      name: "Create snapshot",
      editorCallback: async (_editor, view) => {
        if (!view.file) return;
        const label = await this.promptText("Snapshot label (optional)");
        try {
          this.versionHistory.captureSnapshot(view.file.path, label || undefined);
          await this.saveVersionHistory();
          this.notify("Live Share: snapshot created");
        } catch {
          new Notice("Live Share: failed to create snapshot");
        }
      },
    });

    this.addCommand({
      id: "show-audit-log",
      name: "Show audit log",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        if (checking) return true;
        this.fetchAuditLog();
      },
    });

    this.addCommand({
      id: "set-file-permissions",
      name: "Set file permissions",
      checkCallback: (checking) => {
        if (this.settings.role !== "host" || !this.sessionManager.isActive) return false;
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView?.file) return false;
        if (this.remoteUsers.size === 0) return false;
        if (checking) return true;
        const filePath = activeView.file.path;
        const users: FilePermissionUser[] = [];
        for (const [userId, user] of this.remoteUsers) {
          users.push({
            userId,
            displayName: user.displayName,
            permission: user.permission ?? "read-write",
          });
        }
        new FilePermissionModal(this.app, filePath, users, (userId, fp, permission) => {
          this.controlChannel?.send({
            type: "set-file-permission",
            userId,
            filePath: fp,
            permission,
          });
        }).open();
      },
    });

    this.addCommand({
      id: "add-comment",
      name: "Add comment at cursor",
      editorCallback: (editor, view) => {
        if (!this.commentManager || !view.file) return;
        const filePath = view.file.path;
        const cursor = editor.getCursor();
        new AddCommentModal(this.app, (text) => {
          this.commentManager?.addComment(filePath, cursor.line, text);
          this.notify("Live Share: comment added");
        }).open();
      },
    });

    this.addCommand({
      id: "show-comments",
      name: "Show comments for this file",
      editorCallback: (_editor, view) => {
        if (!this.commentManager || !view.file) return;
        new CommentListModal(this.app, view.file.path, this.commentManager, (line) => {
          const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (mdView) {
            mdView.editor.setCursor({ line, ch: 0 });
            mdView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
          }
        }).open();
      },
    });

    this.registerView(PRESENCE_VIEW_TYPE, (leaf) => {
      const view = new PresenceView(leaf);
      view.setFollowHandler((userId) => this.followUser(userId));
      view.setKickHandler((userId) => this.kickUser(userId));
      view.setSummonHandler((userId) => this.summonUser(userId));
      view.setPermissionHandler((userId) => this.setUserPermission(userId));
      return view;
    });

    const ribbonEl = this.addRibbonIcon("users", "Collaborators", () => {
      this.activatePresenceView();
    });
    const ribbonCtxHandler = (evt: MouseEvent) => {
      evt.preventDefault();
      this.showRibbonMenu(evt);
    };
    ribbonEl.addEventListener("contextmenu", ribbonCtxHandler);
    this.register(() => ribbonEl.removeEventListener("contextmenu", ribbonCtxHandler));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.onActiveFileChange();
        this.debouncedBroadcastPresence();
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", async (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
        if (this.fileOpsManager.isPathMuted(file.path)) return;
        this.fileOpsManager.onFileCreate(file);
        if (this.settings.role === "host") {
          if (file instanceof TFile) {
            try {
              const content = isTextFile(file.path)
                ? await this.app.vault.read(file)
                : await this.app.vault.readBinary(file);
              if (isTextFile(file.path)) {
                await this.backgroundSync.onFileAdded(file.path);
                this.versionHistory.trackFile(file.path);
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
        if (this.fileOpsManager.isPathMuted(file.path)) return;
        this.fileOpsManager.onFileDelete(file);
        if (this.settings.role === "host") {
          this.backgroundSync.onFileRemoved(file.path);
          this.versionHistory.untrackFile(file.path);
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
        if (this.fileOpsManager.isPathMuted(file.path) || this.fileOpsManager.isPathMuted(oldPath))
          return;
        this.fileOpsManager.onFileRename(file, oldPath);
        await this.backgroundSync.onFileRenamed(oldPath, file.path);
        this.versionHistory.untrackFile(oldPath);
        if (isTextFile(file.path)) {
          this.versionHistory.trackFile(file.path);
        }
        if (this.settings.role === "host") {
          this.manifestManager.renameFile(oldPath, file.path, this.syncManager);
        }
        const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (activeFile && (activeFile.path === file.path || activeFile.path === oldPath)) {
          this.onActiveFileChange();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file: TAbstractFile) => {
        if (!(file instanceof TFile) || !this.manifestManager.isSharedPath(file.path)) return;
        if (this.fileOpsManager.isPathMuted(file.path)) return;

        if (isTextFile(file.path)) {
          if (this.backgroundSync.isRecentDiskWrite(file.path)) return;
          if (
            file.path.endsWith(".canvas") &&
            this.canvasSync?.isSubscribed(file.path) &&
            !this.canvasSync.isRecentDiskWrite(file.path)
          ) {
            await this.canvasSync.handleLocalModify(file.path);
          }
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

    this.registerObsidianProtocolHandler("live-share-auth", async (params) => {
      const token = params.token;
      if (!token) return;
      if (this.authManager.completeAuth(token)) return;
      try {
        const payload = parseJwtPayload(token);
        this.settings.jwt = token;
        this.settings.githubUserId = payload.sub;
        this.settings.displayName =
          (payload.displayName || payload.username || "").trim() || "Anonymous";
        this.settings.avatarUrl = payload.avatar || "";
        await this.saveSettings();
        new Notice(`Live Share: authenticated as ${this.settings.displayName}`);
      } catch {
        new Notice("Live Share: invalid auth token");
      }
    });

    this.registerObsidianProtocolHandler("live-share", (params) => {
      if (params.invite) this.joinWithInvite(params.invite);
    });

    if (
      this.settings.roomId &&
      this.settings.token &&
      this.settings.role &&
      this.settings.autoReconnect
    ) {
      this.app.workspace.onLayoutReady(() => {
        this.resumeSession().catch((err) => {
          this.logger.error("session", "auto-reconnect failed", err);
        });
      });
    }
  }

  onunload() {
    this.logger.destroy();
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

    this.fileOpsManager.destroy();
    this.backgroundSync.destroy();
    this.manifestManager.destroy();
    this.syncManager.destroy();
  }

  private async resumeSession() {
    this.logger.log("session", `resuming as ${this.settings.role}`);
    try {
      await this.connectSync();
      await this.manifestManager.connect(this.syncManager);
      if (this.settings.role === "host") {
        await this.manifestManager.publishManifest({ purge: true });
        await this.backgroundSync.startAll("host");
        this.registerManifestChangeHandler();
      } else {
        await this.cleanupStaleFiles();
        await this.manifestManager.syncFromManifest(
          this.mutePathEvents,
          this.unmutePathEvents,
          this.requestBinaryFile,
        );
        await this.backgroundSync.startAll("guest");
        this.registerManifestChangeHandler();
      }
      this.onActiveFileChange();
    } catch {
      this.logger.error("session", "failed to resume session");
      await this.abortSession("Live Share: failed to resume previous session");
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncManager.updateSettings(this.settings);
    this.manifestManager.updateSettings(this.settings);
    this.logger.updateSettings(this.settings.debugLogging, this.settings.debugLogPath);
    this.exclusionManager.setPatterns(this.settings.excludePatterns);
  }

  notify(msg: string): void {
    if (this.settings.notificationsEnabled) {
      new Notice(msg);
    }
  }

  private followUser(userId: string) {
    if (this.followTarget === userId) {
      this.unfollowUser();
      return;
    }
    this.followTarget = userId;
    const user = this.remoteUsers.get(userId);
    this.notify(`Live Share: following ${user?.displayName ?? userId}`);

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

  public promptText(placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new PromptModal(this.app, placeholder, resolve);
      modal.open();
    });
  }

  private async cleanupStaleFiles() {
    const manifest = this.manifestManager.getEntries();
    if (manifest.size === 0) return;
    const manifestPaths = new Set(manifest.keys());
    const localFiles = this.app.vault
      .getFiles()
      .filter((file) => this.manifestManager.isSharedPath(file.path));
    for (const file of localFiles) {
      if (!manifestPaths.has(normalizePath(file.path))) {
        this.fileOpsManager.mutePathEvents(file.path);
        try {
          await this.app.vault.trash(file, true);
        } finally {
          setTimeout(() => this.fileOpsManager.unmutePathEvents(file.path), VAULT_EVENT_SETTLE_MS);
        }
      }
    }
  }

  private cleanupSession() {
    this.versionHistory.stopAutoCapture();
    this.saveVersionHistory();
    this.commentManager?.destroy();
    this.commentManager = null;
    this.explorerIndicators?.destroy();
    this.explorerIndicators = null;
    this.canvasSync?.destroy();
    this.canvasSync = null;
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
    this.filePermissions.clear();
    this.refreshPresenceView();
    this.fileOpsManager.clearPendingChunks();
    this.manifestManager.destroy();
    this.connectionState.transition({ type: "disconnect" });
  }

  private async abortSession(message: string) {
    if (this.isEndingSession) return;
    this.isEndingSession = true;
    try {
      new Notice(message);
      this.cleanupSession();
    } finally {
      await this.sessionManager.endSession();
      this.isEndingSession = false;
    }
  }

  public async startSession() {
    if (this.sessionManager.isActive) {
      new Notice("Live Share: session already active");
      return;
    }

    const ok = await this.sessionManager.startSession();
    if (ok) {
      try {
        await this.connectSync();
        await this.manifestManager.connect(this.syncManager);
        await this.manifestManager.publishManifest({ purge: true });
        await this.backgroundSync.startAll("host");
        this.registerManifestChangeHandler();
        this.onActiveFileChange();
        this.logger.log("session", `started, room=${this.settings.roomId}`);
        this.notify("Live Share: session started, invite copied to clipboard");
      } catch {
        this.logger.error("session", "failed to start session");
        await this.abortSession("Live Share: failed to start session");
      }
    }
  }

  public async joinSession() {
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
        await this.manifestManager.connect(this.syncManager);
        await this.cleanupStaleFiles();
        const syncedCount = await this.manifestManager.syncFromManifest(
          this.mutePathEvents,
          this.unmutePathEvents,
          this.requestBinaryFile,
        );
        await this.backgroundSync.startAll("guest");
        this.registerManifestChangeHandler();
        this.onActiveFileChange();
        this.logger.log("session", `joined, room=${this.settings.roomId}`);
        this.notify(`Live Share: joined session, synced ${syncedCount} file(s)`);
      } catch {
        this.logger.error("session", "failed to join session");
        await this.abortSession("Live Share: failed to join session");
      }
    }
  }

  private async joinWithInvite(inviteString: string) {
    if (this.sessionManager.isActive) {
      new Notice("Live Share: session already active");
      return;
    }

    const ok = await this.sessionManager.joinSession(inviteString);
    if (ok) {
      try {
        await this.connectSync();
        await this.manifestManager.connect(this.syncManager);
        await this.cleanupStaleFiles();
        const syncedCount = await this.manifestManager.syncFromManifest(
          this.mutePathEvents,
          this.unmutePathEvents,
          this.requestBinaryFile,
        );
        await this.backgroundSync.startAll("guest");
        this.registerManifestChangeHandler();
        this.onActiveFileChange();
        this.logger.log("session", `joined via link, room=${this.settings.roomId}`);
        this.notify(`Live Share: joined session, synced ${syncedCount} file(s)`);
      } catch {
        this.logger.error("session", "failed to join via link");
        await this.abortSession("Live Share: failed to join session");
      }
    }
  }

  public async endSession() {
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

      this.cleanupSession();
      this.notify(
        this.settings.role === "host" ? "Live Share: session ended" : "Live Share: left session",
      );
    } finally {
      await this.sessionManager.endSession();
      this.isEndingSession = false;
    }
  }

  private async connectSync() {
    this.settings.permission = "read-write";
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

    this.syncManager.setE2E(e2e ?? null);
    this.controlChannel = new ControlChannel(this.settings, e2e);
    this.controlChannel.onError((context, err) => {
      this.logger.error("control-ws", `${context} error`, err);
    });
    this.controlChannel.onStateChange((controlState) => {
      this.logger.log("connection", `control channel ${controlState}`);
      if (controlState === "connected") {
        this.connectionState.transition({ type: "connected" });
        this.fileOpsManager.setOnline(true);
        if (this.settings.role === "guest") {
          this.controlChannel?.send({
            type: "join-request",
            userId: this.userId,
            displayName: this.settings.displayName,
            avatarUrl: this.settings.avatarUrl,
          });
        }
        this.broadcastPresence();
        if (this.backgroundSync.isRunning()) {
          this.onActiveFileChange();
        }
      } else if (controlState === "reconnecting") {
        this.connectionState.transition({ type: "reconnecting" });
        this.fileOpsManager.setOnline(false);
      } else {
        this.fileOpsManager.setOnline(false);
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
        this.controlChannel?.send({
          ...op,
          type: CHUNK_TO_CONTROL[op.type],
        } as ControlMessage);
      } else {
        this.controlChannel?.send({ type: "file-op", op });
      }
    });
    this.controlChannel.on("file-op", (msg) => {
      const op = msg.op;
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
          } else if (op.type === "modify" && "path" in op && !isTextFile(op.path)) {
            const file = this.app.vault.getAbstractFileByPath(op.path);
            if (file instanceof TFile) {
              const content = await this.app.vault.readBinary(file);
              await this.manifestManager.updateFile(file, content);
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
        .catch((err) => {
          this.logger.error("file-op", "failed to apply remote file-op", err);
        });
    });
    for (const chunkType of [
      "file-chunk-start",
      "file-chunk-data",
      "file-chunk-end",
      "file-chunk-resume",
    ] as const) {
      this.controlChannel.on(chunkType, (msg) => {
        if (!msg.path || !this.manifestManager.isSharedPath(msg.path)) return;
        this.fileOpsManager
          .applyRemoteOp({
            ...msg,
            type: CONTROL_TO_CHUNK[chunkType],
          } as FileOp)
          .catch((err) => {
            this.logger.error("file-op", `failed to apply remote ${chunkType}`, err);
          });
      });
    }
    this.controlChannel.on("presence-update", (msg) => {
      const user: PresenceUser = msg;
      const isNew = !this.remoteUsers.has(user.userId);
      const existing = this.remoteUsers.get(user.userId);
      if (existing?.permission && !user.permission) {
        user.permission = existing.permission;
      }
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
      if (msg.userId) {
        const userId = msg.userId;
        const leavingUser = this.remoteUsers.get(userId);
        this.remoteUsers.delete(userId);
        this.refreshPresenceView();
        this.updateStatusBar();
        if (this.followTarget === userId) {
          this.followTarget = null;
          this.clearUnfollowListeners();
        }
      }
    });

    this.controlChannel.on("join-request", (msg) => {
      if (this.settings.role !== "host") return;
      new ApprovalModal(
        this.app,
        msg,
        (approved, permission) => {
          this.controlChannel?.send({
            type: "join-response",
            userId: msg.userId,
            approved,
            permission,
          });
          if (approved) {
            const existing = this.remoteUsers.get(msg.userId);
            if (existing) existing.permission = permission;
          }
        },
        this.settings.approvalTimeoutSeconds,
      ).open();
    });

    this.controlChannel.on("join-response", async (msg) => {
      if (this.settings.role !== "guest") return;
      if (msg.approved === false) {
        new Notice("Live Share: join request denied by host");
        this.endSession();
        return;
      }
      if (msg.permission) {
        this.settings.permission = msg.permission;
      }
      this.broadcastPresence();
    });

    this.controlChannel.on("permission-update", async (msg) => {
      this.settings.permission = msg.permission;
      this.onActiveFileChange();
      this.notify(`Live Share: your permission was changed to ${msg.permission}`);
    });

    this.controlChannel.on("focus-request", (msg) => {
      showFocusNotification(this, msg);
    });
    this.controlChannel.on("summon", async (msg) => {
      const file = this.app.vault.getAbstractFileByPath(msg.filePath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
          view.editor.setCursor({ line: msg.line, ch: msg.ch });
          view.editor.scrollIntoView(
            { from: { line: msg.line, ch: 0 }, to: { line: msg.line, ch: 0 } },
            true,
          );
        }
      }
      new Notice(
        `Live Share: ${msg.fromDisplayName} summoned you to ${msg.filePath}:${msg.line + 1}`,
      );
    });

    this.controlChannel.on("present-start", (msg) => {
      if (this.settings.role === "host") return;
      if (!msg.userId) return;
      const hostUserId = msg.userId;
      this.clearUnfollowListeners();
      this.followTarget = hostUserId;
      const user = this.remoteUsers.get(hostUserId);
      if (user) this.applyFollowState(user);
      this.notify("Live Share: host started presenting, now following");
    });

    this.controlChannel.on("present-stop", (msg) => {
      if (this.settings.role === "host") return;
      if (msg.userId && this.followTarget === msg.userId) {
        this.followTarget = null;
        this.clearUnfollowListeners();
        this.notify("Live Share: host stopped presenting");
      }
    });

    this.controlChannel.on("sync-request", async (msg) => {
      if (this.settings.role !== "host") return;
      if (msg.path && this.manifestManager.isSharedPath(msg.path)) {
        const file = this.app.vault.getAbstractFileByPath(msg.path);
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

    this.controlChannel.on("host-transfer-offer", (msg) => {
      new ConfirmModal(
        this.app,
        `${msg.displayName ?? msg.userId} wants to make you the host. Accept?`,
        (accepted) => {
          if (accepted) {
            this.controlChannel?.send({
              type: "host-transfer-accept",
              userId: msg.userId,
            });
          } else {
            this.controlChannel?.send({
              type: "host-transfer-decline",
              userId: msg.userId,
            });
          }
        },
      ).open();
    });

    this.controlChannel.on("host-transfer-complete", async () => {
      this.settings.role = "host";
      this.settings.permission = "read-write";
      await this.saveSettings();
      await this.manifestManager.publishManifest({ purge: false });
      this.broadcastPresence();
      this.updateStatusBar();
      this.refreshPresenceView();
      new Notice("Live Share: you are now the host");
      this.logger.log("session", "became host via transfer");
    });

    this.controlChannel.on("host-transfer-decline", (msg) => {
      this.notify(`Live Share: ${msg.displayName ?? msg.userId} declined host transfer`);
    });

    this.controlChannel.on("host-disconnected", () => {
      new Notice("Live Share: the host has disconnected");
      this.logger.log("session", "host disconnected");
    });

    this.controlChannel.on("host-changed", (msg) => {
      for (const [userId, user] of this.remoteUsers) {
        user.isHost = userId === msg.userId;
      }
      this.refreshPresenceView();
      this.notify(`Live Share: ${msg.displayName} is now the host`);
      this.logger.log("session", `host changed to ${msg.userId}`);
    });

    this.controlChannel.on("file-permission-update", (msg) => {
      this.filePermissions.set(msg.filePath, msg.permission);
      this.explorerIndicators?.update(this.filePermissions);
      this.onActiveFileChange();
      this.notify(`Live Share: ${msg.filePath} set to ${msg.permission}`);
    });

    this.versionHistory.startAutoCapture();
    this.explorerIndicators = new ExplorerIndicators();
    this.commentManager = new CommentManager(
      this.syncManager,
      this.userId,
      this.settings.displayName,
    );
    this.canvasSync = new CanvasSync(this.app.vault, this.syncManager, this.fileOpsManager);
    const entries = this.manifestManager.getEntries();
    const role = this.settings.role === "host" ? "host" : "guest";
    for (const [path] of entries) {
      if (isTextFile(path)) {
        this.versionHistory.trackFile(path);
        this.commentManager.subscribeFile(path);
        if (path.endsWith(".canvas")) {
          this.canvasSync.subscribe(path, role);
        }
      }
    }

    this.broadcastPresence();
    if (this.presenceInterval) clearInterval(this.presenceInterval);
    this.presenceInterval = setInterval(() => this.broadcastPresence(), 3_000);
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
    const effectivePermission = sharedPath
      ? (this.filePermissions.get(sharedPath) ?? this.settings.permission)
      : this.settings.permission;
    this.collabManager.activateForFile(
      cmView,
      sharedPath,
      this.syncManager,
      this.settings.role,
      effectivePermission,
      {
        name: this.settings.displayName,
        color: this.settings.cursorColor,
        colorLight: `${this.settings.cursorColor}33`,
      },
      this.commentManager,
      (line: number) => {
        if (!this.commentManager || !sharedPath) return;
        const comments = this.commentManager
          .getComments(sharedPath)
          .filter((c) => !c.resolved && c.anchorIndex === line);
        if (comments.length > 0) {
          new CommentThreadModal(this.app, sharedPath, comments[0], this.commentManager).open();
        } else {
          new AddCommentModal(this.app, (text) => {
            this.commentManager?.addComment(sharedPath, line, text);
            this.notify("Live Share: comment added");
          }).open();
        }
      },
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
      case "reconnecting":
        this.statusBarEl.setText("Live Share: reconnecting...");
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

  private showRibbonMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const active = this.sessionManager.isActive;

    if (!active) {
      menu.addItem((item) =>
        item
          .setTitle("Start session")
          .setIcon("play")
          .onClick(() => this.startSession()),
      );
      menu.addItem((item) =>
        item
          .setTitle("Join session")
          .setIcon("log-in")
          .onClick(() => this.joinSession()),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle("Copy invite link")
          .setIcon("copy")
          .onClick(() => this.sessionManager.copyInvite()),
      );
      menu.addItem((item) =>
        item
          .setTitle("Show collaborators")
          .setIcon("users")
          .onClick(() => this.activatePresenceView()),
      );
      menu.addSeparator();
      if (this.settings.role === "host") {
        menu.addItem((item) =>
          item
            .setTitle("End session")
            .setIcon("square")
            .setWarning(true)
            .onClick(async () => {
              const confirmed = await this.confirm(
                "Are you sure you want to end the session? All participants will be disconnected.",
              );
              if (confirmed) this.endSession();
            }),
        );
      } else {
        menu.addItem((item) =>
          item
            .setTitle("Leave session")
            .setIcon("log-out")
            .setWarning(true)
            .onClick(async () => {
              const confirmed = await this.confirm("Are you sure you want to leave the session?");
              if (confirmed) this.endSession();
            }),
        );
      }
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Settings")
        .setIcon("settings")
        .onClick(() => {
          // biome-ignore lint/suspicious/noExplicitAny: Obsidian does not expose setting in public typings
          const app = this.app as any;
          app.setting.open();
          app.setting.openTabById(this.manifest.id);
        }),
    );

    menu.showAtMouseEvent(evt);
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
    this.notify(`Live Share: kicked ${name}`);
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
    this.notify(`Live Share: set ${user.displayName} to ${newPermission}`);
  }

  private async fetchAuditLog() {
    if (!this.settings.serverUrl || !this.settings.roomId || !this.settings.token) return;
    try {
      const url = `${this.settings.serverUrl}/rooms/${this.settings.roomId}/logs?token=${encodeURIComponent(this.settings.token)}&limit=100`;
      const res = await fetch(url);
      if (!res.ok) {
        new Notice("Live Share: failed to fetch audit log");
        return;
      }
      const entries = await res.json();
      new AuditLogModal(this.app, entries).open();
    } catch {
      new Notice("Live Share: failed to fetch audit log");
    }
  }

  private async reloadFromHost() {
    if (!this.controlChannel) return;
    this.notify("Live Share: reloading all files from host...");
    const syncedCount = await this.manifestManager.syncFromManifest(
      this.mutePathEvents,
      this.unmutePathEvents,
      this.requestBinaryFile,
    );
    if (syncedCount > 0) this.notify(`Live Share: reloaded ${syncedCount} file(s) from host`);
  }

  private summonUser(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      for (const leaf of leaves) {
        if (leaf.view instanceof MarkdownView) {
          view = leaf.view;
          break;
        }
      }
    }
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
    this.notify(`Live Share: summoned ${user?.displayName ?? userId}`);
  }

  private togglePresent() {
    this.isPresenting = !this.isPresenting;
    if (this.isPresenting) {
      this.controlChannel?.send({
        type: "present-start",
        userId: this.userId,
      });
      this.notify("Live Share: presentation mode ON");
    } else {
      this.controlChannel?.send({
        type: "present-stop",
        userId: this.userId,
      });
      this.notify("Live Share: presentation mode OFF");
    }
    this.updateStatusBar();
  }

  private unfollowUser() {
    if (!this.followTarget) return;
    this.followTarget = null;
    this.clearUnfollowListeners();
    this.notify("Live Share: stopped following");
  }

  private clearUnfollowListeners() {
    for (const cleanup of this.unfollowListeners) cleanup();
    this.unfollowListeners = [];
  }

  private async applyFollowState(user: PresenceUser) {
    if (!user.currentFile || this.isApplyingFollow) return;

    this.isApplyingFollow = true;
    this.followSuppressUnfollow = true;

    try {
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (currentView?.file?.path !== user.currentFile) {
        const file = this.app.vault.getAbstractFileByPath(user.currentFile);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf().openFile(file);
          this.onActiveFileChange();
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
    } finally {
      this.followSuppressUnfollow = false;
      this.isApplyingFollow = false;
    }
  }

  private confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, message, resolve);
      modal.open();
    });
  }

  private get snapshotPath(): string {
    return `${this.manifest.dir}/snapshots.json`;
  }

  private loadVersionHistory(): void {
    this.app.vault.adapter
      .read(this.snapshotPath)
      .then((raw) => {
        try {
          this.versionHistory.loadStore(JSON.parse(raw));
        } catch {}
      })
      .catch(() => {});
  }

  private saveVersionHistory(): void {
    const store = this.versionHistory.getStore();
    this.app.vault.adapter.write(this.snapshotPath, JSON.stringify(store)).catch(() => {});
  }
}
