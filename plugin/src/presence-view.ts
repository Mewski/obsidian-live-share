/**
 * Sidebar panel showing connected users with follow, kick, and summon controls.
 *
 * Renders a list of collaborators with colored dots, file locations, and action
 * buttons. The host sees additional kick and summon controls.
 */
import { ItemView, WorkspaceLeaf } from "obsidian";
import { HEX_COLOR_RE } from "./utils";

export const PRESENCE_VIEW_TYPE = "live-share-presence";

export interface PresenceUser {
  userId: string;
  displayName: string;
  cursorColor: string;
  currentFile: string;
  scrollTop?: number;
  isHost?: boolean;
  line?: number;
}

export class PresenceView extends ItemView {
  private users = new Map<string, PresenceUser>();
  private onFollowRequest: ((userId: string) => void) | null = null;
  private onKickRequest: ((userId: string) => void) | null = null;
  private summonHandler: ((userId: string) => void) | null = null;
  private isHost = false;
  private followedUserId: string | null = null;

  getViewType(): string {
    return PRESENCE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Collaborators";
  }

  getIcon(): string {
    return "users";
  }

  setFollowHandler(handler: (userId: string) => void) {
    this.onFollowRequest = handler;
  }

  setKickHandler(handler: (userId: string) => void) {
    this.onKickRequest = handler;
  }

  setSummonHandler(handler: (userId: string) => void): void {
    this.summonHandler = handler;
  }

  setIsHost(isHost: boolean) {
    this.isHost = isHost;
    this.render();
  }

  updateState(users: Map<string, PresenceUser>, isHost: boolean, followedUserId: string | null) {
    this.users = users;
    this.isHost = isHost;
    this.followedUserId = followedUserId;
    this.render();
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    if (this.users.size === 0) {
      contentEl.createEl("p", {
        text: "No collaborators connected",
        cls: "live-share-presence-empty",
      });
      return;
    }

    const list = contentEl.createEl("div", { cls: "live-share-presence-list" });

    for (const [userId, user] of this.users) {
      const isFollowed = this.followedUserId === userId;
      const itemCls = isFollowed
        ? "live-share-presence-item is-followed"
        : "live-share-presence-item";
      const item = list.createEl("div", { cls: itemCls });

      const dot = item.createEl("span", { cls: "live-share-presence-dot" });
      if (HEX_COLOR_RE.test(user.cursorColor)) {
        dot.style.backgroundColor = user.cursorColor;
      }

      const info = item.createEl("div", { cls: "live-share-presence-info" });
      const nameEl = info.createEl("span", {
        text: user.displayName,
        cls: "live-share-presence-name",
      });
      if (user.isHost) {
        nameEl.createEl("span", {
          text: "Host",
          cls: "live-share-presence-badge",
        });
      }
      if (user.currentFile) {
        info.createEl("span", {
          text: user.currentFile,
          cls: "live-share-presence-file",
        });
      }

      const actions = item.createEl("div", {
        cls: "live-share-presence-actions",
      });

      const followBtn = actions.createEl("button", {
        text: "Follow",
        cls: isFollowed ? "live-share-presence-follow is-active" : "live-share-presence-follow",
      });
      followBtn.addEventListener("click", () => {
        this.onFollowRequest?.(userId);
      });

      if (this.isHost) {
        const summonBtn = actions.createEl("button", {
          text: "Summon",
          cls: "live-share-presence-summon",
        });
        summonBtn.addEventListener("click", () => {
          this.summonHandler?.(userId);
        });

        const kickBtn = actions.createEl("button", {
          text: "Kick",
          cls: "live-share-presence-kick",
        });
        kickBtn.addEventListener("click", () => {
          this.onKickRequest?.(userId);
        });
      }
    }
  }
}
