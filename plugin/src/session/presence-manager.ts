import type { ControlChannel } from "../sync/control-ws";
import { normalizePath, toCanonicalPath } from "../utils";
import type { PresenceUser } from "./presence-view";

export interface PresenceContext {
  getUserId(): string;
  getDisplayName(): string;
  getAvatarUrl(): string;
  getCursorColor(): string;
  getRole(): string;
  getCurrentFile(): string;
  getScrollTop(): number;
  getCursorLine(): number;
  getControlChannel(): ControlChannel | null;
  getRemoteUsers(): Map<string, PresenceUser>;
  notify(msg: string): void;
  openFileAndScroll(filePath: string, scrollTop: number): Promise<void>;
  refreshPresenceView(): void;
  updateStatusBar(): void;
  onActiveFileChange(): void;
}

export class PresenceManager {
  private ctx: PresenceContext;
  private isPresenting = false;
  private followTarget: string | null = null;
  private followSuppressUnfollow = false;
  private isApplyingFollow = false;
  private unfollowListeners: (() => void)[] = [];
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: PresenceContext) {
    this.ctx = ctx;
  }

  getFollowTarget(): string | null {
    return this.followTarget;
  }

  getIsPresenting(): boolean {
    return this.isPresenting;
  }

  startBroadcasting(): void {
    this.broadcastPresence();
    if (this.presenceInterval) clearInterval(this.presenceInterval);
    this.presenceInterval = setInterval(() => this.broadcastPresence(), 3_000);
  }

  debouncedBroadcastPresence(): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.broadcastPresence();
    }, 200);
  }

  broadcastPresence(): void {
    const cc = this.ctx.getControlChannel();
    if (!cc) return;
    cc.send({
      type: "presence-update",
      userId: this.ctx.getUserId(),
      displayName: this.ctx.getDisplayName(),
      avatarUrl: this.ctx.getAvatarUrl() || undefined,
      cursorColor: this.ctx.getCursorColor(),
      currentFile: toCanonicalPath(normalizePath(this.ctx.getCurrentFile())),
      scrollTop: this.ctx.getScrollTop(),
      line: this.ctx.getCursorLine(),
      isHost: this.ctx.getRole() === "host",
    });
  }

  followUser(userId: string): void {
    if (this.followTarget === userId) {
      this.unfollowUser();
      return;
    }
    this.followTarget = userId;
    const user = this.ctx.getRemoteUsers().get(userId);
    this.ctx.notify(`Live Share: following ${user?.displayName ?? userId}`);

    this.clearUnfollowListeners();
    const handler = () => {
      if (!this.followSuppressUnfollow) this.unfollowUser();
    };
    const eventTypes = ["keydown", "mousedown", "wheel"] as const;
    for (const eventType of eventTypes) {
      document.addEventListener(eventType, handler);
      this.unfollowListeners.push(() =>
        document.removeEventListener(eventType, handler),
      );
    }

    if (user) void this.applyFollowState(user);
  }

  unfollowUser(): void {
    if (!this.followTarget) return;
    this.followTarget = null;
    this.clearUnfollowListeners();
    this.ctx.notify("Live Share: stopped following");
  }

  clearUnfollowListeners(): void {
    for (const cleanup of this.unfollowListeners) cleanup();
    this.unfollowListeners = [];
  }

  async applyFollowState(user: PresenceUser): Promise<void> {
    if (!user.currentFile || this.isApplyingFollow) return;

    this.isApplyingFollow = true;
    this.followSuppressUnfollow = true;

    try {
      await this.ctx.openFileAndScroll(user.currentFile, user.scrollTop ?? 0);
    } finally {
      this.followSuppressUnfollow = false;
      this.isApplyingFollow = false;
    }
  }

  handlePresenceUpdate(user: PresenceUser): void {
    const remoteUsers = this.ctx.getRemoteUsers();
    const isNew = !remoteUsers.has(user.userId);
    const existing = remoteUsers.get(user.userId);
    if (existing?.permission && !user.permission) {
      user.permission = existing.permission;
    }
    remoteUsers.set(user.userId, user);
    this.ctx.refreshPresenceView();
    this.ctx.updateStatusBar();
    if (isNew) {
      this.broadcastPresence();
    }
    if (this.followTarget === user.userId) {
      void this.applyFollowState(user);
    }
  }

  handlePresenceLeave(userId: string): void {
    const remoteUsers = this.ctx.getRemoteUsers();
    remoteUsers.delete(userId);
    this.ctx.refreshPresenceView();
    this.ctx.updateStatusBar();
    if (this.followTarget === userId) {
      this.followTarget = null;
      this.clearUnfollowListeners();
    }
  }

  togglePresent(): void {
    this.isPresenting = !this.isPresenting;
    const cc = this.ctx.getControlChannel();
    if (this.isPresenting) {
      cc?.send({ type: "present-start", userId: this.ctx.getUserId() });
      this.ctx.notify("Live Share: presentation mode ON");
    } else {
      cc?.send({ type: "present-stop", userId: this.ctx.getUserId() });
      this.ctx.notify("Live Share: presentation mode OFF");
    }
    this.ctx.updateStatusBar();
  }

  handlePresentStart(hostUserId: string): void {
    if (this.ctx.getRole() === "host") return;
    this.clearUnfollowListeners();
    this.followTarget = hostUserId;
    const user = this.ctx.getRemoteUsers().get(hostUserId);
    if (user) void this.applyFollowState(user);
    this.ctx.notify("Live Share: host started presenting, now following");
  }

  handlePresentStop(userId: string): void {
    if (this.ctx.getRole() === "host") return;
    if (this.followTarget === userId) {
      this.followTarget = null;
      this.clearUnfollowListeners();
      this.ctx.notify("Live Share: host stopped presenting");
    }
  }

  destroy(): void {
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }
    this.isPresenting = false;
    this.followTarget = null;
    this.clearUnfollowListeners();
  }
}
