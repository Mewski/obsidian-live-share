import { ExtraButtonComponent, ItemView, setIcon } from "obsidian";

import type { Permission } from "./types";
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
  permission?: Permission;
}

export class PresenceView extends ItemView {
  private users = new Map<string, PresenceUser>();
  private onFollowRequest: ((userId: string) => void) | null = null;
  private onKickRequest: ((userId: string) => void) | null = null;
  private onSummonRequest: ((userId: string) => void) | null = null;
  private onSetPermissionRequest: ((userId: string) => void) | null = null;
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
    this.onSummonRequest = handler;
  }

  setPermissionHandler(handler: (userId: string) => void): void {
    this.onSetPermissionRequest = handler;
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

  private getInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || "?";
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("live-share-presence-panel");

    if (this.users.size === 0) {
      const empty = contentEl.createEl("div", {
        cls: "live-share-presence-empty",
      });
      const iconEl = empty.createEl("div", {
        cls: "live-share-presence-empty-icon",
      });
      setIcon(iconEl, "users");
      empty.createEl("div", {
        text: "No collaborators connected",
        cls: "live-share-presence-empty-text",
      });
      return;
    }

    const list = contentEl.createEl("div", {
      cls: "live-share-presence-list",
    });

    for (const [userId, user] of this.users) {
      const isFollowed = this.followedUserId === userId;

      const row = list.createEl("div", {
        cls: `live-share-user${isFollowed ? " is-followed" : ""}`,
      });

      const avatar = row.createEl("div", {
        cls: "live-share-user-avatar",
        text: this.getInitial(user.displayName),
      });
      if (HEX_COLOR_RE.test(user.cursorColor)) {
        avatar.style.backgroundColor = user.cursorColor;
      }

      const info = row.createEl("div", { cls: "live-share-user-info" });

      const nameRow = info.createEl("div", { cls: "live-share-user-name-row" });
      nameRow.createEl("span", {
        text: user.displayName,
        cls: "live-share-user-name",
      });
      if (user.isHost) {
        nameRow.createEl("span", {
          text: "Host",
          cls: "live-share-badge mod-host",
        });
      }
      if (user.permission === "read-only") {
        nameRow.createEl("span", {
          text: "R/O",
          cls: "live-share-badge mod-readonly",
        });
      }

      if (user.currentFile) {
        info.createEl("div", {
          text: user.currentFile,
          cls: "live-share-user-file",
        });
      }

      const actions = row.createEl("div", {
        cls: "live-share-user-actions",
      });

      const followBtn = new ExtraButtonComponent(actions)
        .setIcon(isFollowed ? "eye-off" : "eye")
        .setTooltip(isFollowed ? "Unfollow" : "Follow");
      if (isFollowed) followBtn.extraSettingsEl.addClass("is-active");
      followBtn.extraSettingsEl.addEventListener("click", () => {
        this.onFollowRequest?.(userId);
      });

      if (this.isHost) {
        const isReadOnly = user.permission === "read-only";
        new ExtraButtonComponent(actions)
          .setIcon(isReadOnly ? "unlock" : "lock")
          .setTooltip(isReadOnly ? "Make read-write" : "Make read-only")
          .extraSettingsEl.addEventListener("click", () => {
            this.onSetPermissionRequest?.(userId);
          });

        new ExtraButtonComponent(actions)
          .setIcon("compass")
          .setTooltip("Summon here")
          .extraSettingsEl.addEventListener("click", () => {
            this.onSummonRequest?.(userId);
          });

        const kickBtn = new ExtraButtonComponent(actions)
          .setIcon("x")
          .setTooltip("Kick from session");
        kickBtn.extraSettingsEl.addClass("mod-warning");
        kickBtn.extraSettingsEl.addEventListener("click", () => {
          this.onKickRequest?.(userId);
        });
      }
    }
  }
}
