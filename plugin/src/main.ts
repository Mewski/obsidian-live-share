import { Plugin, MarkdownView, Notice, TAbstractFile, TFile } from "obsidian";
import { LiveShareSettings, DEFAULT_SETTINGS } from "./types";
import { LiveShareSettingTab } from "./settings";
import { SyncManager } from "./sync";
import { CollabManager } from "./collab";
import { FileOpsManager } from "./file-ops";
import { SessionManager } from "./session";
import { ManifestManager } from "./manifest";
import { ControlChannel } from "./control-ws";
import { AuthManager } from "./auth";
import { ApprovalModal, type JoinRequest } from "./approval-modal";
import { showFocusNotification, type FocusRequest } from "./focus-notification";
import { ExclusionManager } from "./exclusion";
import { ConnectionStateManager } from "./connection-state";
import {
  PresenceView,
  PRESENCE_VIEW_TYPE,
  type PresenceUser,
} from "./presence-view";

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
  private followTarget: string | null = null;
  private followSuppressUnfollow = false;
  private unfollowListeners: (() => void)[] = [];
  statusBarEl!: HTMLElement;

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
    this.connectionState.onChange((state) => this.updateStatusBar());

    this.registerEditorExtension(this.collabManager.getBaseExtension());

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addEventListener("click", () =>
      this.activatePresenceView(),
    );
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
      id: "authenticate",
      name: "Log in with GitHub",
      callback: () => this.authManager.authenticate(),
    });

    this.addCommand({
      id: "logout",
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
        new Notice("Focus request sent");
      },
    });

    this.addCommand({
      id: "summon-all",
      name: "Summon all participants here",
      editorCallback: (editor, view) => {
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
        new Notice("Summon sent to all participants");
      },
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
        this.broadcastPresence();
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
        this.fileOpsManager.onFileCreate(file);
        if (this.settings.role === "host" && file instanceof TFile) {
          this.app.vault.read(file).then((content) => {
            this.manifestManager.updateFile(file, content);
          });
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!this.manifestManager.isSharedPath(file.path)) return;
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
        this.fileOpsManager.onFileRename(file, oldPath);
        if (this.settings.role === "host") {
          this.manifestManager.renameFile(oldPath, file.path, this.syncManager);
        }
      }),
    );

    // Watch for .liveshare.json changes
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file.path === ".liveshare.json") {
          this.exclusionManager.loadConfig(this.app.vault).then(() => {
            if (this.settings.role === "host") {
              this.manifestManager.publishManifest();
            }
          });
        }
      }),
    );

    this.addSettingTab(new LiveShareSettingTab(this.app, this));

    // Auto-reconnect if session was active
    if (this.settings.roomId && this.settings.token && this.settings.role) {
      this.connectSync();
      this.manifestManager.connect().then(() => {
        if (this.settings.role === "host") {
          this.manifestManager.publishManifest();
        } else {
          this.manifestManager.syncFromManifest();
          this.manifestManager.onManifestChange(async (added, removed) => {
            if (added.length > 0) {
              const n = await this.manifestManager.syncFromManifest();
              if (n > 0) new Notice(`Live Share: synced ${n} file(s)`);
            }
            for (const path of removed) {
              const file = this.app.vault.getAbstractFileByPath(path);
              if (file) await this.app.vault.delete(file);
            }
            if (removed.length > 0)
              new Notice(`Live Share: removed ${removed.length} file(s)`);
          });
        }
      });
    }
  }

  onunload() {
    this.controlChannel?.destroy();
    this.clearUnfollowListeners();
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
      new Notice("Live Share: session already active");
      return;
    }

    const name = await this.promptText("Session name");
    if (!name) return;

    const ok = await this.sessionManager.startSession(name);
    if (ok) {
      this.connectSync();
      await this.manifestManager.connect();
      await this.manifestManager.publishManifest();
      new Notice("Live Share: session started, invite copied");
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
      this.connectSync();
      await this.manifestManager.connect();
      const count = await this.manifestManager.syncFromManifest();
      this.manifestManager.onManifestChange(async (added, removed) => {
        if (added.length > 0) {
          const n = await this.manifestManager.syncFromManifest();
          if (n > 0) new Notice(`Live Share: synced ${n} file(s)`);
        }
        for (const path of removed) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file) await this.app.vault.delete(file);
        }
        if (removed.length > 0)
          new Notice(`Live Share: removed ${removed.length} file(s)`);
      });
      new Notice(`Live Share: joined session, synced ${count} file(s)`);
    }
  }

  private async endSession() {
    if (!this.sessionManager.isActive) {
      new Notice("Live Share: no active session");
      return;
    }

    // Deactivate collab extensions before disconnecting
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      // @ts-ignore
      const cmView = (activeView.editor as any).cm as
        | import("@codemirror/view").EditorView
        | undefined;
      if (cmView) this.collabManager.deactivateAll(cmView);
    }

    this.syncManager.disconnect();
    this.controlChannel?.destroy();
    this.controlChannel = null;
    this.followTarget = null;
    this.clearUnfollowListeners();
    this.remoteUsers.clear();
    this.refreshPresenceView();
    this.manifestManager.destroy();
    await this.sessionManager.endSession();
    this.connectionState.transition({ type: "disconnect" });
    new Notice("Live Share: session ended");
  }

  private connectSync() {
    this.connectionState.transition({ type: "connect" });
    this.syncManager.connect();

    // Set up control channel for file ops
    this.controlChannel = new ControlChannel(this.settings);
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
    this.controlChannel.connect();
    this.fileOpsManager.setSender((op) => {
      this.controlChannel?.send({ type: "file-op", op });
    });
    this.controlChannel.on("file-op", (msg) => {
      const op = msg.op as import("./types").FileOp;
      // Validate paths are within shared scope
      const paths = [
        "path" in op ? op.path : null,
        "oldPath" in op ? op.oldPath : null,
        "newPath" in op ? op.newPath : null,
      ].filter(Boolean) as string[];
      if (paths.some((p) => !this.manifestManager.isSharedPath(p))) return;
      this.fileOpsManager.applyRemoteOp(op);
    });
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

    // Host: handle join requests from guests
    this.controlChannel.on("join-request", (msg) => {
      if (this.settings.role !== "host") return;
      new ApprovalModal(
        this.app,
        msg as unknown as JoinRequest,
        (approved, permission) => {
          this.controlChannel?.send({
            type: "join-response",
            userId: msg.userId as string,
            approved,
            permission,
          });
        },
      ).open();
    });

    // Handle focus requests and summons
    this.controlChannel.on("focus-request", (msg) => {
      showFocusNotification(this, msg as unknown as FocusRequest);
    });
    this.controlChannel.on("summon", (msg) => {
      showFocusNotification(this, msg as unknown as FocusRequest);
    });

    // Guest: handle kicked
    this.controlChannel.on("kicked", () => {
      new Notice("Live Share: you have been removed from the session");
      this.endSession();
    });

    // Send initial presence with isHost flag
    this.broadcastPresence();

    this.onActiveFileChange();
  }

  private onActiveFileChange() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const file = view.file;
    const editor = view.editor;
    // @ts-ignore -- Obsidian exposes this but doesn't type it
    const cmView = (editor as any).cm as import("@codemirror/view").EditorView;
    if (!cmView) return;

    const filePath = file?.path ?? null;
    const sharedPath =
      filePath && this.manifestManager.isSharedPath(filePath) ? filePath : null;
    this.collabManager.activateForFile(
      cmView,
      sharedPath,
      this.syncManager,
      this.settings.role,
    );
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
        this.statusBarEl.setText(`Live Share: ${role}${users}`);
        break;
      }
      case "reconnecting":
        this.statusBarEl.setText("Live Share: reconnecting...");
        break;
      case "error":
        this.statusBarEl.setText("Live Share: error");
        break;
      case "auth-required":
        this.statusBarEl.setText("Live Share: auth needed");
        break;
    }
  }

  private broadcastPresence() {
    if (!this.controlChannel) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const currentFile = view?.file?.path ?? "";
    let scrollTop = 0;
    if (view) {
      // @ts-ignore
      const cmView = (view.editor as any).cm as
        | import("@codemirror/view").EditorView
        | undefined;
      if (cmView) scrollTop = cmView.scrollDOM.scrollTop;
    }
    this.controlChannel.send({
      type: "presence-update",
      userId: this.settings.githubUserId || this.settings.displayName,
      displayName: this.settings.displayName,
      cursorColor: this.settings.cursorColor,
      currentFile,
      scrollTop,
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
    new Notice(`Kicked user`);
  }

  followUser(userId: string) {
    if (this.followTarget === userId) {
      this.unfollowUser();
      return;
    }
    this.followTarget = userId;
    const user = this.remoteUsers.get(userId);
    new Notice(`Following ${user?.displayName ?? userId}`);

    // Register unfollow-on-interaction listeners
    this.clearUnfollowListeners();
    const handler = () => {
      if (!this.followSuppressUnfollow) this.unfollowUser();
    };
    const events = ["keydown", "mousedown", "wheel"] as const;
    for (const evt of events) {
      document.addEventListener(evt, handler);
      this.unfollowListeners.push(() =>
        document.removeEventListener(evt, handler),
      );
    }

    // Apply immediately if we have state
    if (user) this.applyFollowState(user);
  }

  private unfollowUser() {
    if (!this.followTarget) return;
    this.followTarget = null;
    this.clearUnfollowListeners();
    new Notice("Stopped following");
  }

  private clearUnfollowListeners() {
    for (const cleanup of this.unfollowListeners) cleanup();
    this.unfollowListeners = [];
  }

  private async applyFollowState(user: PresenceUser) {
    if (!user.currentFile) return;

    this.followSuppressUnfollow = true;

    // Open their file if different
    const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (currentView?.file?.path !== user.currentFile) {
      const file = this.app.vault.getAbstractFileByPath(user.currentFile);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    }

    // Scroll to their position
    if (user.scrollTop !== undefined) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        // @ts-ignore
        const cmView = (view.editor as any).cm as
          | import("@codemirror/view").EditorView
          | undefined;
        if (cmView) {
          cmView.scrollDOM.scrollTop = user.scrollTop;
        }
      }
    }

    this.followSuppressUnfollow = false;
  }

  promptText(placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new (class extends (
        require("obsidian") as typeof import("obsidian")
      ).Modal {
        result: string | null = null;
        onOpen() {
          const { contentEl } = this;
          const input = contentEl.createEl("input", {
            type: "text",
            placeholder,
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
          resolve(this.result || null);
          this.contentEl.empty();
        }
      })(this.app);
      modal.open();
    });
  }
}
