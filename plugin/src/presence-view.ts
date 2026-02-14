import { ItemView, WorkspaceLeaf } from "obsidian";

export const PRESENCE_VIEW_TYPE = "live-share-presence";

export interface PresenceUser {
  userId: string;
  displayName: string;
  cursorColor: string;
  currentFile: string;
  scrollTop?: number;
}

export class PresenceView extends ItemView {
  private users = new Map<string, PresenceUser>();
  private onFollowRequest: ((userId: string) => void) | null = null;
  private onKickRequest: ((userId: string) => void) | null = null;
  private isHost = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

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

  setIsHost(isHost: boolean) {
    this.isHost = isHost;
    this.render();
  }

  updateUsers(users: Map<string, PresenceUser>) {
    this.users = users;
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
      const item = list.createEl("div", { cls: "live-share-presence-item" });

      const dot = item.createEl("span", { cls: "live-share-presence-dot" });
      if (/^#[0-9a-fA-F]{3,8}$/.test(user.cursorColor)) {
        dot.style.backgroundColor = user.cursorColor;
      }

      const info = item.createEl("div", { cls: "live-share-presence-info" });
      info.createEl("span", {
        text: user.displayName,
        cls: "live-share-presence-name",
      });
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
        cls: "live-share-presence-follow",
      });
      followBtn.addEventListener("click", () => {
        this.onFollowRequest?.(userId);
      });

      if (this.isHost) {
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
