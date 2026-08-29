import { ExtraButtonComponent, ItemView, setIcon } from "obsidian";

import type { Permission } from "../types";
import { HEX_COLOR_RE } from "../utils";

export const PRESENCE_VIEW_TYPE = "live-share-presence";

export interface PresenceUser {
  userId: string;
  displayName: string;
  cursorColor: string;
  currentFile: string;
  avatarUrl?: string;
  scrollTop?: number;
  isHost?: boolean;
  line?: number;
  permission?: Permission;
}

export class PresenceView extends ItemView {
  private users = new Map<string, PresenceUser>();
  private localUserId: string | null = null;
  private onFollowRequest: ((userId: string) => void) | null = null;
  private onKickRequest: ((userId: string) => void) | null = null;
  private onSummonRequest: ((userId: string) => void) | null = null;
  private onSetPermissionRequest: ((userId: string) => void) | null = null;
  private onDisplayNameChange: ((name: string) => void) | null = null;
  private onCursorColorChange: ((color: string) => void) | null = null;
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

  setFollowHandler(handler: (userId: string) => void): void {
    this.onFollowRequest = handler;
  }

  setKickHandler(handler: (userId: string) => void): void {
    this.onKickRequest = handler;
  }

  setSummonHandler(handler: (userId: string) => void): void {
    this.onSummonRequest = handler;
  }

  setPermissionHandler(handler: (userId: string) => void): void {
    this.onSetPermissionRequest = handler;
  }

  setDisplayNameChangeHandler(handler: (name: string) => void): void {
    this.onDisplayNameChange = handler;
  }

  setCursorColorChangeHandler(handler: (color: string) => void): void {
    this.onCursorColorChange = handler;
  }

  updateState(
    users: Map<string, PresenceUser>,
    isHost: boolean,
    followedUserId: string | null,
    localUserId: string | null = null,
  ): void {
    this.users = users;
    this.isHost = isHost;
    this.followedUserId = followedUserId;
    this.localUserId = localUserId;
    if (!this.contentEl.querySelector(".live-share-user-name-input:focus")) {
      this.render();
    }
  }

  override onOpen(): Promise<void> {
    this.render();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
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
      const isSelf = userId === this.localUserId;
      const isFollowed = !isSelf && this.followedUserId === userId;

      const row = list.createEl("div", {
        cls: `live-share-user${isFollowed ? " is-followed" : ""}`,
      });

      const avatar = row.createEl(isSelf ? "button" : "div", {
        cls: `live-share-user-avatar${isSelf ? " live-share-user-avatar-self" : ""}`,
      });
      if (isSelf) {
        avatar.setAttr("type", "button");
        avatar.setAttr("aria-label", "Change your cursor color");
      }
      if (HEX_COLOR_RE.test(user.cursorColor)) {
        avatar.setCssProps({ "--user-color": user.cursorColor });
      }
      let hasAvatar = false;
      if (user.avatarUrl) {
        try {
          const url = new URL(user.avatarUrl);
          if (url.protocol === "https:") {
            const img = avatar.createEl("img", {
              attr: {
                src: url.href,
                width: "28",
                height: "28",
                referrerpolicy: "no-referrer",
              },
              cls: "live-share-user-avatar-img",
            });
            img.addEventListener("error", () => {
              img.remove();
              avatar.setText(this.getInitial(user.displayName));
            });
            hasAvatar = true;
          }
        } catch {
          // Invalid avatar URL, skip rendering
        }
      }
      if (!hasAvatar) {
        avatar.setText(this.getInitial(user.displayName));
      }

      if (isSelf) {
        const colorInput = row.createEl("input", {
          attr: {
            type: "color",
            "aria-label": "Your cursor color",
          },
        });
        colorInput.hidden = true;
        colorInput.value = HEX_COLOR_RE.test(user.cursorColor) ? user.cursorColor : "#7c3aed";
        colorInput.addEventListener("change", () => {
          if (!HEX_COLOR_RE.test(colorInput.value)) return;
          avatar.setCssProps({ "--user-color": colorInput.value });
          this.onCursorColorChange?.(colorInput.value);
        });
        avatar.addEventListener("click", () => colorInput.click());
      }

      const info = row.createEl("div", { cls: "live-share-user-info" });

      const nameRow = info.createEl("div", { cls: "live-share-user-name-row" });
      if (isSelf) {
        const nameInput = nameRow.createEl("input", {
          cls: "live-share-user-name live-share-user-name-input",
          attr: {
            type: "text",
            maxlength: "80",
            "aria-label": "Your display name",
            spellcheck: "false",
          },
        });
        nameInput.value = user.displayName;
        nameInput.addEventListener("change", () => {
          const name = nameInput.value.trim().replace(/\s+/g, " ").slice(0, 80) || "Anonymous";
          nameInput.value = name;
          if (name !== user.displayName) this.onDisplayNameChange?.(name);
        });
        nameInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            nameInput.blur();
          } else if (event.key === "Escape") {
            nameInput.value = user.displayName;
            nameInput.blur();
          }
        });
        nameRow.createEl("span", {
          text: "You",
          cls: "live-share-badge mod-self",
        });
      } else {
        nameRow.createEl("span", {
          text: user.displayName,
          cls: "live-share-user-name",
        });
      }
      if (user.isHost) {
        nameRow.createEl("span", {
          text: "Host",
          cls: "live-share-badge mod-host",
        });
      }
      if (user.permission === "read-only") {
        nameRow.createEl("span", {
          text: "Read-only",
          cls: "live-share-badge mod-readonly",
        });
      }

      if (user.currentFile) {
        info.createEl("div", {
          text: user.currentFile,
          cls: "live-share-user-file",
        });
      }

      if (isSelf) continue;

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
