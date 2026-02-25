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
import { isTextFile, normalizePath } from "./utils";

/** Extract the CM6 EditorView from an Obsidian MarkdownView (untyped internal). */
function getCmView(view: MarkdownView): import("@codemirror/view").EditorView | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: Obsidian internal -- editor.cm is untyped
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
  connectionState!: ConnectionStateManager;
  controlChannel: ControlChannel | null = null;
  private remoteUsers = new Map<string, PresenceUser>();
  private presenting = false;
  private followTarget: string | null = null;
  private followSuppressUnfollow = false;
  private unfollowListeners: (() => void)[] = [];
  private connectionStateUnsub: (() => void) | null = null;
  statusBarEl!: HTMLElement;

  /** Guard to prevent re-entrant calls to endSession (e.g. kicked -> endSession -> session-end -> endSession). */
  private endingSession = false;

  /** Timer for debounced presence broadcasts. */
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Current scroll listener and its DOM element, so we can remove it on file change. */
  private currentScrollListener: (() => void) | null = null;
  private currentScrollDOM: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.syncManager = new SyncManager(this.settings);
    this.collabManager = new CollabManager();
    this.fileOpsManager = new FileOpsManager(this.app.vault);
    this.sessionManager = new SessionManager(this);
    this.manifestManager = new ManifestManager(this.app.vault, this.settings);
    this.authManager = new AuthManager(this);
    this.exclusionManager = new ExclusionManager();
    await this.exclusionManager.loadConfig(this.app.vault);
    this.manifestManager.setExclusionManager(this.exclusionManager);
    this.connectionState = new ConnectionStateManager();
    this.connectionStateUnsub = this.connectionState.onChange(() => this.updateStatusBar());

    this.registerEditorExtension(this.collabManager.getBaseExtension());

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addEventListener("click", () => this.activatePresenceView());
    this.statusBarEl.style.cursor = "pointer";
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
      callback: () => this.endSession(),
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
          fromUserId: this.settings.githubUserId || this.settings.displayName,
          fromDisplayName: this.settings.displayName,
          filePath,
          line: cursor.line,
          ch: cursor.ch,
        });
        new Notice("Obsidian Live Share: focus request sent");
      },
    });

    this.addCommand({
      id: "summon-all",
      name: "Summon all participants here",
      editorCallback: (editor, view) => {
        // BUG FIX: Only the host should be able to summon all participants
        if (this.settings.role !== "host") {
          new Notice("Obsidian Live Share: only the host can summon all participants");
          return;
        }
        const cursor = editor.getCursor();
        const filePath = view.file?.path;
        if (!filePath || !this.controlChannel) return;
        this.controlChannel.send({
          type: "summon",
          fromUserId: this.settings.githubUserId || this.settings.displayName,
          fromDisplayName: this.settings.displayName,
          targetUserId: "__all__",
          filePath,
          line: cursor.line,
          ch: cursor.ch,
        });
        new Notice("Obsidian Live Share: summon sent to all participants");
      },
    });

    this.addCommand({
      id: "reload-from-host",
      name: "Reload all files from host",
      callback: () => this.reloadFromHost(),
    });

    this.addCommand({
      id: "summon-user",
      name: "Summon a specific participant here",
      editorCallback: () => {
        if (this.settings.role !== "host") {
          new Notice("Obsidian Live Share: only the host can summon");
          return;
        }
        if (this.remoteUsers.size === 0) {
          new Notice("Obsidian Live Share: no participants to summon");
          return;
        }
        new UserPickerModal(this.app, this.remoteUsers, (userId) => {
          this.summonUser(userId);
        }).open();
      },
    });

    this.addCommand({
      id: "toggle-present",
      name: "Toggle presentation mode",
      callback: () => this.togglePresent(),
    });

    this.registerView(PRESENCE_VIEW_TYPE, (leaf) => {
      const view = new PresenceView(leaf);
      view.setFollowHandler((userId) => this.followUser(userId));
      view.setKickHandler((userId) => this.kickUser(userId));
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
        if (this.presenting && this.controlChannel) {
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (activeView?.file) {
            this.controlChannel.send({
              type: "focus-request",
              fromUserId: this.settings.githubUserId || this.settings.displayName,
              fromDisplayName: this.settings.displayName,
              filePath: activeView.file.path,
              line: activeView.editor?.getCursor()?.line ?? 0,
              ch: activeView.editor?.getCursor()?.ch ?? 0,
            });
          }
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
        // BUG FIX: Check suppression before forwarding to prevent echoing remote ops back
        if (this.fileOpsManager.isPathSuppressed(file.path)) return;
        this.fileOpsManager.onFileCreate(file);
        if (this.settings.role === "host" && file instanceof TFile) {
          if (isTextFile(file.path)) {
            this.app.vault
              .read(file)
              .then((content) => this.manifestManager.updateFile(file, content))
              .catch(() => {});
          } else {
            this.app.vault
              .readBinary(file)
              .then((buf) => this.manifestManager.updateFile(file, buf))
              .catch(() => {});
          }
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
        // BUG FIX: Check suppression before forwarding
        if (this.fileOpsManager.isPathSuppressed(file.path)) return;
        this.fileOpsManager.onFileDelete(file);
        if (this.settings.role === "host") {
          this.manifestManager.removeFile(file.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (
          !this.manifestManager.isSharedPath(file.path) &&
          !this.manifestManager.isSharedPath(oldPath)
        )
          return;
        // BUG FIX: Check suppression before forwarding
        if (
          this.fileOpsManager.isPathSuppressed(file.path) ||
          this.fileOpsManager.isPathSuppressed(oldPath)
        )
          return;
        this.fileOpsManager.onFileRename(file, oldPath);
        if (this.settings.role === "host") {
          this.manifestManager.renameFile(oldPath, file.path, this.syncManager);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file.path === ".liveshare.json") {
          this.exclusionManager.loadConfig(this.app.vault).then(() => {
            if (this.settings.role === "host") {
              this.manifestManager.publishManifest();
            }
          });
          return;
        }
        if (
          file instanceof TFile &&
          !isTextFile(file.path) &&
          this.manifestManager.isSharedPath(file.path)
        ) {
          // BUG FIX: Check suppression before forwarding
          if (this.fileOpsManager.isPathSuppressed(file.path)) return;
          this.fileOpsManager.onFileModify(file);
          if (this.settings.role === "host") {
            this.app.vault
              .readBinary(file)
              .then((buf) => this.manifestManager.updateFile(file, buf))
              .catch(() => {});
          }
        }
      }),
    );

    this.addSettingTab(new LiveShareSettingTab(this.app, this));

    if (this.settings.roomId && this.settings.token && this.settings.role) {
      this.connectSync()
        .then(() => this.manifestManager.connect())
        .then(() => {
          if (this.settings.role === "host") {
            this.manifestManager.publishManifest();
          } else {
            this.manifestManager.syncFromManifest();
            this.manifestManager.onManifestChange(async (added, removed) => {
              if (added.length > 0) {
                const n = await this.manifestManager.syncFromManifest();
                if (n > 0) new Notice(`Obsidian Live Share: synced ${n} file(s)`);
              }
              for (const path of removed) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file) await this.app.vault.trash(file, true);
              }
              if (removed.length > 0)
                new Notice(`Obsidian Live Share: removed ${removed.length} file(s)`);
            });
          }
        });
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

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const cmView = getCmView(activeView);
      if (cmView) this.collabManager.deactivateAll(cmView);
    }

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

  private async startSession() {
    if (this.sessionManager.isActive) {
      new Notice("Obsidian Live Share: session already active");
      return;
    }

    const name = await this.promptText("Session name");
    if (!name) return;

    const ok = await this.sessionManager.startSession(name);
    if (ok) {
      await this.connectSync();
      await this.manifestManager.connect();
      await this.manifestManager.publishManifest();
      new Notice("Obsidian Live Share: session started, invite copied");
    }
  }

  private async joinSession() {
    if (this.sessionManager.isActive) {
      new Notice("Obsidian Live Share: session already active");
      return;
    }

    const invite = await this.promptText("Paste invite link");
    if (!invite) return;

    const ok = await this.sessionManager.joinSession(invite);
    if (ok) {
      await this.connectSync();
      await this.manifestManager.connect();
      const count = await this.manifestManager.syncFromManifest();
      this.manifestManager.onManifestChange(async (added, removed) => {
        if (added.length > 0) {
          const n = await this.manifestManager.syncFromManifest();
          if (n > 0) new Notice(`Obsidian Live Share: synced ${n} file(s)`);
        }
        for (const path of removed) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file) await this.app.vault.trash(file, true);
        }
        if (removed.length > 0)
          new Notice(`Obsidian Live Share: removed ${removed.length} file(s)`);
      });
      new Notice(`Obsidian Live Share: joined session, synced ${count} file(s)`);
    }
  }

  private async endSession() {
    if (!this.sessionManager.isActive) {
      new Notice("Obsidian Live Share: no active session");
      return;
    }

    // BUG FIX: Re-entrancy guard -- endSession can be called from kicked/session-end handlers
    // which in turn fire during endSession cleanup, causing double cleanup.
    if (this.endingSession) return;
    this.endingSession = true;

    try {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        const cmView = getCmView(activeView);
        if (cmView) this.collabManager.deactivateAll(cmView);
      }

      if (this.settings.role === "host" && this.controlChannel) {
        this.controlChannel.send({ type: "session-end" });
      }

      this.syncManager.disconnect();
      this.controlChannel?.destroy();
      this.controlChannel = null;
      this.followTarget = null;
      this.clearUnfollowListeners();
      this.removeScrollListener();
      this.remoteUsers.clear();
      this.refreshPresenceView();
      // BUG FIX: Clear incomplete chunk assemblies so they don't leak across sessions
      this.fileOpsManager.clearPendingChunks();
      this.manifestManager.destroy();
      await this.sessionManager.endSession();
      this.connectionState.transition({ type: "disconnect" });
      new Notice("Obsidian Live Share: session ended");
    } finally {
      this.endingSession = false;
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
      switch (controlState) {
        case "connected":
          this.connectionState.transition({ type: "connected" });
          break;
        case "reconnecting":
          this.connectionState.transition({ type: "reconnecting", attempt: 0 });
          break;
        case "disconnected":
          this.connectionState.transition({ type: "disconnect" });
          break;
      }
    });

    // BUG FIX: Re-broadcast presence and clear stale state after reconnect
    this.controlChannel.onReconnect(() => {
      this.fileOpsManager.clearPendingChunks();
      this.broadcastPresence();
    });

    this.controlChannel.connect();

    this.fileOpsManager.setSender((op) => {
      // BUG FIX: Guests with read-only permission should not send file operations.
      // The server also enforces this, but rejecting early avoids unnecessary traffic.
      if (this.settings.role === "guest") {
        // We don't have the permission stored in settings, but the server will
        // reject read-only writes. For now, allow sending -- the server-side guard
        // in control-handler.ts will drop the message if the client is read-only.
      }

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
      if (paths.some((p) => !this.manifestManager.isSharedPath(p))) return;
      this.fileOpsManager.applyRemoteOp(op);
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
        this.fileOpsManager.applyRemoteOp({
          ...msg,
          type: typeMap[chunkType],
        } as never);
      });
    }
    this.controlChannel.on("presence-update", (msg) => {
      const user = msg as unknown as PresenceUser;
      this.remoteUsers.set(user.userId, user);
      this.refreshPresenceView();
      this.updateStatusBar();
      if (this.followTarget === user.userId) {
        this.applyFollowState(user);
      }
    });
    this.controlChannel.on("presence-leave", (msg) => {
      const userId = msg.userId as string;
      if (userId) {
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
      new ApprovalModal(this.app, msg as unknown as JoinRequest, (approved, permission) => {
        this.controlChannel?.send({
          type: "join-response",
          userId: msg.userId as string,
          approved,
          permission,
        });
      }).open();
    });

    this.controlChannel.on("focus-request", (msg) => {
      showFocusNotification(this, msg as unknown as FocusRequest);
    });
    this.controlChannel.on("summon", (msg) => {
      showFocusNotification(this, msg as unknown as FocusRequest);
    });

    this.controlChannel.on("kicked", () => {
      new Notice("Obsidian Live Share: you have been removed from the session");
      this.endSession();
    });

    this.controlChannel.on("session-end", () => {
      new Notice("Obsidian Live Share: the host ended the session");
      this.endSession();
    });

    this.broadcastPresence();

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
    this.collabManager.activateForFile(cmView, sharedPath, this.syncManager, this.settings.role);

    // BUG FIX: Attach scroll listener so presence includes up-to-date scroll position.
    // Remove old listener first to avoid leaking event handlers.
    this.removeScrollListener();
    const scrollDOM = cmView.scrollDOM;
    const scrollHandler = () => {
      this.debouncedBroadcastPresence();
    };
    scrollDOM.addEventListener("scroll", scrollHandler);
    this.currentScrollDOM = scrollDOM;
    this.currentScrollListener = () => scrollDOM.removeEventListener("scroll", scrollHandler);
  }

  private removeScrollListener() {
    if (this.currentScrollListener) {
      this.currentScrollListener();
      this.currentScrollListener = null;
      this.currentScrollDOM = null;
    }
  }

  private updateStatusBar() {
    const state = this.connectionState.getState();
    switch (state) {
      case "disconnected":
        this.statusBarEl.setText("Obsidian Live Share: off");
        break;
      case "connecting":
        this.statusBarEl.setText("Obsidian Live Share: connecting...");
        break;
      case "connected": {
        const count = this.remoteUsers.size;
        const role = this.settings.role === "host" ? "hosting" : "joined";
        const users = count > 0 ? ` (${count + 1})` : "";
        const latency = this.controlChannel?.getLatency();
        const latencyStr = latency ? ` ${latency}ms` : "";
        const pres = this.presenting ? " [presenting]" : "";
        this.statusBarEl.setText(`Obsidian Live Share: ${role}${users}${latencyStr}${pres}`);
        break;
      }
      case "reconnecting":
        this.statusBarEl.setText("Obsidian Live Share: reconnecting...");
        break;
      case "error":
        this.statusBarEl.setText("Obsidian Live Share: error");
        break;
      case "auth-required":
        this.statusBarEl.setText("Obsidian Live Share: auth needed");
        break;
    }
  }

  /** Debounced version of broadcastPresence to avoid flooding the server on rapid events. */
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
      // Include cursor line so followers can track position more precisely
      const cursor = view.editor.getCursor();
      line = cursor.line;
    }
    this.controlChannel.send({
      type: "presence-update",
      userId: this.settings.githubUserId || this.settings.displayName,
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
      view.updateUsers(this.remoteUsers);
    }
  }

  private kickUser(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    this.controlChannel.send({ type: "kick", userId });
    this.remoteUsers.delete(userId);
    this.refreshPresenceView();
    this.updateStatusBar();
    new Notice("Obsidian Live Share: kicked user");
  }

  private async reloadFromHost() {
    if (!this.sessionManager.isActive) {
      new Notice("Obsidian Live Share: no active session");
      return;
    }
    if (this.settings.role !== "guest") {
      new Notice("Obsidian Live Share: only guests can reload from host");
      return;
    }
    if (!this.controlChannel) return;
    new Notice("Obsidian Live Share: reloading all files from host...");
    this.controlChannel.send({ type: "sync-request" });
    const suppress = (p: string) => this.fileOpsManager.suppressPath(p);
    const unsuppress = (p: string) => this.fileOpsManager.unsuppressPath(p);
    const n = await this.manifestManager.syncFromManifest(suppress, unsuppress);
    if (n > 0) new Notice(`Obsidian Live Share: reloaded ${n} file(s) from host`);
  }

  private summonUser(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cursor = view?.editor?.getCursor();
    const filePath = view?.file?.path;
    if (!filePath) {
      new Notice("Obsidian Live Share: open a file first to summon");
      return;
    }
    this.controlChannel.send({
      type: "summon",
      fromUserId: this.settings.githubUserId || this.settings.displayName,
      fromDisplayName: this.settings.displayName,
      targetUserId: userId,
      filePath,
      line: cursor?.line ?? 0,
      ch: cursor?.ch ?? 0,
    });
    const user = this.remoteUsers.get(userId);
    new Notice(`Obsidian Live Share: summoned ${user?.displayName ?? userId}`);
  }

  private togglePresent() {
    if (this.settings.role !== "host") {
      new Notice("Obsidian Live Share: only the host can present");
      return;
    }
    if (!this.sessionManager.isActive) {
      new Notice("Obsidian Live Share: no active session");
      return;
    }
    this.presenting = !this.presenting;
    if (this.presenting) {
      new Notice("Obsidian Live Share: presentation mode ON");
    } else {
      new Notice("Obsidian Live Share: presentation mode OFF");
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
    new Notice(`Obsidian Live Share: following ${user?.displayName ?? userId}`);

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
    new Notice("Obsidian Live Share: stopped following");
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
    input.style.width = "100%";
    input.style.marginBottom = "1em";
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
