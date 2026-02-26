import { type App, Modal } from "obsidian";

import type { JoinRequestMessage, Permission } from "./types";

export class ApprovalModal extends Modal {
  private request: JoinRequestMessage;
  private onDecision: (approved: boolean, permission: Permission) => void;
  private hasDecided = false;

  constructor(
    app: App,
    request: JoinRequestMessage,
    onDecision: (approved: boolean, permission: Permission) => void,
  ) {
    super(app);
    this.setTitle("Join Request");
    this.request = request;
    this.onDecision = onDecision;
  }

  onOpen() {
    const { contentEl } = this;

    const info = contentEl.createDiv({ cls: "live-share-approval-info" });
    if (this.request.avatarUrl) {
      try {
        const avatarUrl = new URL(this.request.avatarUrl);
        if (avatarUrl.protocol === "https:") {
          info.createEl("img", {
            attr: { src: avatarUrl.href, width: "48", height: "48" },
            cls: "live-share-approval-avatar",
          });
        }
      } catch {}
    }
    info.createEl("p", {
      text: `${this.request.displayName} wants to join your session.`,
    });

    const buttons = contentEl.createDiv({ cls: "live-share-approval-buttons" });

    const approveRW = buttons.createEl("button", {
      text: "Approve (Read-Write)",
      cls: "mod-cta",
    });
    approveRW.addEventListener("click", () => {
      this.hasDecided = true;
      this.onDecision(true, "read-write");
      this.close();
    });

    const approveRO = buttons.createEl("button", {
      text: "Approve (Read-Only)",
    });
    approveRO.addEventListener("click", () => {
      this.hasDecided = true;
      this.onDecision(true, "read-only");
      this.close();
    });

    const deny = buttons.createEl("button", { text: "Deny" });
    deny.addEventListener("click", () => {
      this.hasDecided = true;
      this.onDecision(false, "read-only");
      this.close();
    });
  }

  onClose() {
    if (!this.hasDecided) {
      this.onDecision(false, "read-only");
    }
    this.contentEl.empty();
  }
}
