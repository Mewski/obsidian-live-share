import type { EditorView } from "@codemirror/view";
import { MarkdownView, Menu, Notice, Plugin, TFile, requestUrl } from "obsidian";

import { minimatch } from "minimatch";
import { DebugLogger } from "./debug-logger";
import { CollabManager } from "./editor/collab";
import { BackgroundSync } from "./files/background-sync";
import { CanvasSync } from "./files/canvas-sync";

import { ExclusionManager } from "./files/exclusion";
import { FileOpsManager } from "./files/file-ops";
import { ManifestManager } from "./files/manifest";
import { registerVaultEvents } from "./files/vault-events";
import { AuthManager } from "./session/auth";
import { registerCommands } from "./session/commands";
import { PresenceManager } from "./session/presence-manager";
import { PRESENCE_VIEW_TYPE, type PresenceUser, PresenceView } from "./session/presence-view";
import { SessionManager } from "./session/session";
import { ConnectionStateManager } from "./sync/connection-state";
import { registerControlHandlers } from "./sync/control-handlers";
import { ControlChannel } from "./sync/control-ws";
import { E2ECrypto } from "./sync/crypto";
import { SyncManager } from "./sync/sync";
import { DEFAULT_SETTINGS, type LiveShareSettings } from "./types";

import { AuditLogModal } from "./ui/audit-modal";

import { ExplorerIndicators } from "./ui/explorer-indicators";
import { ConfirmModal, PromptModal } from "./ui/modals";
import { LiveShareSettingTab } from "./ui/settings";
import {
  VAULT_EVENT_SETTLE_MS,
  ensureFolder,
  isTextFile,
  normalizePath,
  parseJwtPayload,
  toCanonicalPath,
  toLocalPath,
} from "./utils";

function getCmView(view: MarkdownView): EditorView | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: Obsidian does not expose .cm in its public typings
  return (view.editor as any).cm as EditorView | undefined;
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
  logger!: DebugLogger;

  canvasSync: CanvasSync | null = null;
  explorerIndicators: ExplorerIndicators | null = null;
  controlChannel: ControlChannel | null = null;
  remoteUsers = new Map<string, PresenceUser>();
  remoteReadOnlyPatterns: string[] = [];
  presenceManager: PresenceManager | null = null;
  private connectionStateUnsub: (() => void) | null = null;
  statusBarEl!: HTMLElement;
  private isEndingSession = false;
  private currentScrollListener: (() => void) | null = null;

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
            const localOld = toLocalPath(oldPath);
            const localNew = toLocalPath(newPath);
            const oldFile = this.app.vault.getAbstractFileByPath(localOld);
            const newFile = this.app.vault.getAbstractFileByPath(localNew);
            if (oldFile && !newFile) {
              renamedOldPaths.add(oldPath);
              renamedNewPaths.add(newPath);
              this.fileOpsManager.mutePathEvents(localOld);
              this.fileOpsManager.mutePathEvents(localNew);
              try {
                const parentDir = localNew.substring(0, localNew.lastIndexOf("/"));
                if (parentDir) await ensureFolder(this.app.vault, parentDir);
                await this.app.vault.rename(oldFile, localNew);
              } finally {
                setTimeout(() => {
                  this.fileOpsManager.unmutePathEvents(localOld);
                  this.fileOpsManager.unmutePathEvents(localNew);
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
        if (syncedCount > 0) this.notify(`Live share: synced ${syncedCount} file(s)`);
        for (const path of actuallyAdded) {
          if (isTextFile(path)) {
            await this.backgroundSync.onFileAdded(path);
          }
        }
      }
      for (const path of actuallyRemoved) {
        this.backgroundSync.onFileRemoved(path);
        const file = this.app.vault.getAbstractFileByPath(toLocalPath(path));
        if (file) await this.app.vault.trash(file, true);
      }
      if (actuallyRemoved.length > 0)
        this.notify(`Live share: removed ${actuallyRemoved.length} file(s)`);
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
        // Config file may not exist or be invalid JSON
      }
    }

    this.syncManager = new SyncManager(this.settings);
    this.collabManager = new CollabManager();
    this.fileOpsManager = new FileOpsManager(this.app.vault);
    this.sessionManager = new SessionManager(this);
    this.manifestManager = new ManifestManager(this.app.vault, this.settings);
    this.authManager = new AuthManager(this);
    this.exclusionManager = new ExclusionManager();
    this.exclusionManager.setConfigDir(this.app.vault.configDir);
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
    this.connectionStateUnsub = this.connectionState.onChange(() => this.updateStatusBar());

    this.registerEditorExtension(this.collabManager.getBaseExtension());

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addEventListener("click", () => void this.activatePresenceView());
    this.statusBarEl.addClass("live-share-status-bar");
    this.updateStatusBar();

    registerCommands(this);

    this.registerView(PRESENCE_VIEW_TYPE, (leaf) => {
      const view = new PresenceView(leaf);
      view.setFollowHandler((userId) => this.presenceManager?.followUser(userId));
      view.setKickHandler((userId) => void this.kickUser(userId));
      view.setSummonHandler((userId) => this.summonUser(userId));
      view.setPermissionHandler((userId) => this.setUserPermission(userId));
      return view;
    });

    const ribbonEl = this.addRibbonIcon("users", "Collaborators", () => {
      void this.activatePresenceView();
    });
    const ribbonCtxHandler = (event: MouseEvent) => {
      event.preventDefault();
      this.showRibbonMenu(event);
    };
    ribbonEl.addEventListener("contextmenu", ribbonCtxHandler);
    this.register(() => ribbonEl.removeEventListener("contextmenu", ribbonCtxHandler));

    registerVaultEvents(this);
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
        new Notice(`Live share: authenticated as ${this.settings.displayName}`);
      } catch {
        new Notice("Live share: invalid auth token");
      }
    });

    this.registerObsidianProtocolHandler("live-share", (params) => {
      if (params.invite) void this.joinWithInvite(params.invite);
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
    this.explorerIndicators?.destroy();
    this.explorerIndicators = null;
    this.canvasSync?.destroy();
    this.canvasSync = null;
    this.presenceManager?.destroy();
    this.presenceManager = null;
    this.removeScrollListener();
    this.connectionStateUnsub?.();
    this.connectionStateUnsub = null;

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
      await this.abortSession("Live share: failed to resume previous session");
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
      if (!manifestPaths.has(toCanonicalPath(normalizePath(file.path)))) {
        this.fileOpsManager.mutePathEvents(file.path);
        try {
          await this.app.vault.trash(file, true);
        } finally {
          setTimeout(() => this.fileOpsManager.unmutePathEvents(file.path), VAULT_EVENT_SETTLE_MS);
        }
      }
    }
  }

  cleanupSession() {
    this.explorerIndicators?.destroy();
    this.explorerIndicators = null;
    this.canvasSync?.destroy();
    this.canvasSync = null;
    this.backgroundSync.destroy();
    this.syncManager.disconnect();
    this.controlChannel?.destroy();
    this.controlChannel = null;
    this.presenceManager?.destroy();
    this.presenceManager = null;
    this.removeScrollListener();
    this.remoteUsers.clear();
    this.remoteReadOnlyPatterns = [];
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
      new Notice("Live share: session already active");
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
        this.notify("Live share: session started, invite copied to clipboard");
      } catch {
        this.logger.error("session", "failed to start session");
        await this.abortSession("Live share: failed to start session");
      }
    }
  }

  public async joinSession() {
    if (this.sessionManager.isActive) {
      new Notice("Live share: session already active");
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
        this.notify(`Live share: joined session, synced ${syncedCount} file(s)`);
      } catch {
        this.logger.error("session", "failed to join session");
        await this.abortSession("Live share: failed to join session");
      }
    }
  }

  private async joinWithInvite(inviteString: string) {
    if (this.sessionManager.isActive) {
      new Notice("Live share: session already active");
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
        this.notify(`Live share: joined session, synced ${syncedCount} file(s)`);
      } catch {
        this.logger.error("session", "failed to join via link");
        await this.abortSession("Live share: failed to join session");
      }
    }
  }

  public async endSession() {
    if (!this.sessionManager.isActive) {
      new Notice("Live share: no active session");
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
        this.settings.role === "host" ? "Live share: session ended" : "Live share: left session",
      );
    } finally {
      await this.sessionManager.endSession();
      this.isEndingSession = false;
    }
  }

  private async connectSync() {
    if (this.settings.role === "host") {
      this.settings.permission = "read-write";
    }
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
        if (this.settings.role === "host") {
          this.fileOpsManager.setOnline(true);
        }
        if (this.settings.role === "guest") {
          this.controlChannel?.send({
            type: "join-request",
            userId: this.userId,
            displayName: this.settings.displayName,
            avatarUrl: this.settings.avatarUrl,
          });
        }
        this.presenceManager?.broadcastPresence();
        if (this.backgroundSync.isRunning()) {
          this.onActiveFileChange();
        }
      } else if (controlState === "reconnecting") {
        this.connectionState.transition({ type: "reconnecting" });
        this.fileOpsManager.setOnline(false);
      } else if (controlState === "auth-required") {
        this.fileOpsManager.setOnline(false);
        this.connectionState.transition({ type: "auth-expired" });
        new Notice("Live share: authentication required - sign in via settings");
        void this.endSession();
      } else {
        this.fileOpsManager.setOnline(false);
        this.connectionState.transition({ type: "disconnect" });
        if (this.sessionManager.isActive && !this.isEndingSession) {
          new Notice("Live share: connection lost, session ended");
          void this.endSession();
        }
      }
    });

    registerControlHandlers(this);
    this.controlChannel.connect();

    this.explorerIndicators = new ExplorerIndicators();
    this.canvasSync = new CanvasSync(this.app.vault, this.syncManager, this.fileOpsManager);
    const entries = this.manifestManager.getEntries();
    const role = this.settings.role === "host" ? "host" : "guest";
    for (const [path] of entries) {
      if (isTextFile(path) && path.endsWith(".canvas")) {
        this.canvasSync.subscribe(path, role);
      }
    }

    this.presenceManager = new PresenceManager({
      getUserId: () => this.userId,
      getDisplayName: () => this.settings.displayName,
      getAvatarUrl: () => this.settings.avatarUrl,
      getCursorColor: () => this.settings.cursorColor,
      getRole: () => this.settings.role ?? "guest",
      getCurrentFile: () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        return activeView?.file?.path ?? "";
      },
      getScrollTop: () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) return 0;
        const cmView = getCmView(activeView);
        return cmView ? cmView.scrollDOM.scrollTop : 0;
      },
      getCursorLine: () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        return activeView ? activeView.editor.getCursor().line : 0;
      },
      getControlChannel: () => this.controlChannel,
      getRemoteUsers: () => this.remoteUsers,
      notify: (msg) => this.notify(msg),
      openFileAndScroll: async (filePath, scrollTop) => {
        const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (currentView?.file?.path !== toLocalPath(filePath)) {
          const file = this.app.vault.getAbstractFileByPath(toLocalPath(filePath));
          if (file instanceof TFile) {
            await this.app.workspace.getLeaf().openFile(file);
            this.onActiveFileChange();
          }
        }
        if (scrollTop !== undefined) {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view) {
            const cmView = getCmView(view);
            if (cmView) cmView.scrollDOM.scrollTop = scrollTop;
          }
        }
      },
      refreshPresenceView: () => this.refreshPresenceView(),
      updateStatusBar: () => this.updateStatusBar(),
      onActiveFileChange: () => this.onActiveFileChange(),
    });
    this.presenceManager.startBroadcasting();
  }

  onActiveFileChange() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const file = view.file;
    const cmView = getCmView(view);
    if (!cmView) return;

    const filePath = file?.path ?? null;
    const sharedPath =
      filePath && this.manifestManager.isSharedPath(filePath) && isTextFile(filePath)
        ? toCanonicalPath(normalizePath(filePath))
        : null;
    this.backgroundSync.setActiveFile(sharedPath);
    let effectivePermission = this.settings.permission;
    if (
      sharedPath &&
      this.settings.role === "guest" &&
      this.remoteReadOnlyPatterns.some((p) => minimatch(sharedPath, p))
    ) {
      effectivePermission = "read-only";
    }
    void this.collabManager.activateForFile(
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
    );

    this.removeScrollListener();
    const scrollDOM = cmView.scrollDOM;
    const scrollHandler = () => {
      this.presenceManager?.debouncedBroadcastPresence();
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

  updateStatusBar() {
    const state = this.connectionState.getState();
    switch (state) {
      case "disconnected":
        this.statusBarEl.setText("Live share: off");
        break;
      case "connecting":
        this.statusBarEl.setText("Live share: connecting...");
        break;
      case "reconnecting":
        this.statusBarEl.setText("Live share: reconnecting...");
        break;
      case "connected": {
        const count = this.remoteUsers.size;
        const role = this.settings.role === "host" ? "hosting" : "joined";
        const users = count > 0 ? ` (${count + 1})` : "";
        const latency = this.controlChannel?.getLatency();
        const latencyStr = latency ? ` ${latency}ms` : "";
        const presentingLabel = this.presenceManager?.getIsPresenting() ? " [presenting]" : "";
        this.statusBarEl.setText(`Live share: ${role}${users}${latencyStr}${presentingLabel}`);
        break;
      }
      case "error":
        this.statusBarEl.setText("Live share: error");
        break;
      case "auth-required":
        this.statusBarEl.setText("Live share: auth needed");
        break;
    }
  }

  private showRibbonMenu(event: MouseEvent): void {
    const menu = new Menu();
    const active = this.sessionManager.isActive;

    if (!active) {
      menu.addItem((item) =>
        item
          .setTitle("Start session")
          .setIcon("play")
          .onClick(() => void this.startSession()),
      );
      menu.addItem((item) =>
        item
          .setTitle("Join session")
          .setIcon("log-in")
          .onClick(() => void this.joinSession()),
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
          .onClick(() => void this.activatePresenceView()),
      );
      menu.addSeparator();
      if (this.settings.role === "host") {
        menu.addItem((item) =>
          item
            .setTitle("End session")
            .setIcon("square")
            .setWarning(true)
            .onClick(() => {
              void this.confirm(
                "Are you sure you want to end the session? All participants will be disconnected.",
              ).then((confirmed) => {
                if (confirmed) void this.endSession();
              });
            }),
        );
      } else {
        menu.addItem((item) =>
          item
            .setTitle("Leave session")
            .setIcon("log-out")
            .setWarning(true)
            .onClick(() => {
              void this.confirm("Are you sure you want to leave the session?").then((confirmed) => {
                if (confirmed) void this.endSession();
              });
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

    menu.showAtMouseEvent(event);
  }

  async activatePresenceView() {
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

  refreshPresenceView() {
    const leaves = this.app.workspace.getLeavesOfType(PRESENCE_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as PresenceView;
      view.updateState(
        this.remoteUsers,
        this.settings.role === "host",
        this.presenceManager?.getFollowTarget() ?? null,
      );
    }
  }

  async kickUser(userId: string) {
    if (this.settings.role !== "host" || !this.controlChannel) return;
    const user = this.remoteUsers.get(userId);
    const name = user?.displayName ?? userId;
    const confirmed = await this.confirm(`Kick ${name} from the session?`);
    if (!confirmed) return;
    this.controlChannel.send({ type: "kick", userId });
    this.remoteUsers.delete(userId);
    this.refreshPresenceView();
    this.updateStatusBar();
    this.notify(`Live share: kicked ${name}`);
  }

  setUserPermission(userId: string) {
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
    this.notify(`Live share: set ${user.displayName} to ${newPermission}`);
  }

  async fetchAuditLog() {
    if (!this.settings.serverUrl || !this.settings.roomId || !this.settings.token) return;
    try {
      const url = `${this.settings.serverUrl}/rooms/${this.settings.roomId}/logs?limit=100`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.settings.token}`,
      };
      if (this.settings.serverPassword) headers["X-Server-Password"] = this.settings.serverPassword;
      const res = await requestUrl({ url, headers });
      new AuditLogModal(this.app, res.json).open();
    } catch {
      new Notice("Live share: failed to fetch audit log");
    }
  }

  async reloadFromHost() {
    if (!this.controlChannel) return;
    this.notify("Live share: reloading all files from host...");
    const syncedCount = await this.manifestManager.syncFromManifest(
      this.mutePathEvents,
      this.unmutePathEvents,
      this.requestBinaryFile,
    );
    if (syncedCount > 0) this.notify(`Live share: reloaded ${syncedCount} file(s) from host`);
  }

  summonUser(userId: string) {
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
      new Notice("Live share: open a file first to summon");
      return;
    }
    this.controlChannel.send({
      type: "summon",
      fromUserId: this.userId,
      fromDisplayName: this.settings.displayName,
      targetUserId: userId,
      filePath: toCanonicalPath(normalizePath(filePath)),
      line: cursor?.line ?? 0,
      ch: cursor?.ch ?? 0,
    });
    const user = this.remoteUsers.get(userId);
    this.notify(`Live share: summoned ${user?.displayName ?? userId}`);
  }

  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, message, resolve);
      modal.open();
    });
  }
}
