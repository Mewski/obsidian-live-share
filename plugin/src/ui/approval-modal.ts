import { type App, Modal } from "obsidian";

import type { JoinRequestMessage, Permission } from "../types";

export class ApprovalModal extends Modal {
  private request: JoinRequestMessage;
  private onDecision: (approved: boolean, permission: Permission) => void;
  private hasDecided = false;
  private timeoutSeconds: number;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: App,
    request: JoinRequestMessage,
    onDecision: (approved: boolean, permission: Permission) => void,
    timeoutSeconds = 0,
  ) {
    super(app);
    this.setTitle("Join request");
    this.request = request;
    this.onDecision = onDecision;
    this.timeoutSeconds = timeoutSeconds;
  }

  override onOpen() {
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
      } catch {
        // Invalid avatar URL, skip rendering
      }
    }
    const nameEl = info.createEl("p");
    nameEl.appendText(`${this.request.displayName} wants to join your session.`);

    if (this.request.verified) {
      const badge = info.createEl("p", { cls: "live-share-approval-verified" });
      badge.createEl("span", {
        text: "GitHub verified",
        cls: "live-share-verified-badge",
      });
    } else {
      info.createEl("p", {
        text: "Identity not verified",
        cls: "live-share-approval-unverified",
      });
    }

    let timerEl: HTMLElement | null = null;
    if (this.timeoutSeconds > 0) {
      timerEl = contentEl.createEl("p", {
        cls: "live-share-approval-timer",
      });
      let remaining = this.timeoutSeconds;
      timerEl.setText(`Auto-deny in ${remaining}s`);
      this.countdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          this.hasDecided = true;
          this.onDecision(false, "read-only");
          this.close();
        } else if (timerEl) {
          timerEl.setText(`Auto-deny in ${remaining}s`);
        }
      }, 1000);
    }

    const buttons = contentEl.createDiv({ cls: "live-share-approval-buttons" });

    const approveRW = buttons.createEl("button", {
      text: "Approve (read-write)",
      cls: "mod-cta",
    });
    approveRW.addEventListener("click", () => {
      this.hasDecided = true;
      this.onDecision(true, "read-write");
      this.close();
    });

    const approveRO = buttons.createEl("button", {
      text: "Approve (read-only)",
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

  override onClose() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (!this.hasDecided) {
      this.onDecision(false, "read-only");
    }
    this.contentEl.empty();
  }
}
