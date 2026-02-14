import { Modal, App } from "obsidian";

export interface JoinRequest {
  userId: string;
  displayName: string;
  avatarUrl: string;
}

export class ApprovalModal extends Modal {
  private request: JoinRequest;
  private onDecision: (
    approved: boolean,
    permission: "read-write" | "read-only",
  ) => void;
  private decided = false;

  constructor(
    app: App,
    request: JoinRequest,
    onDecision: (
      approved: boolean,
      permission: "read-write" | "read-only",
    ) => void,
  ) {
    super(app);
    this.request = request;
    this.onDecision = onDecision;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Join Request" });

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
        // Skip invalid avatar URLs
      }
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
      this.decided = true;
      this.onDecision(true, "read-write");
      this.close();
    });

    const approveRO = buttons.createEl("button", {
      text: "Approve (Read-Only)",
    });
    approveRO.addEventListener("click", () => {
      this.decided = true;
      this.onDecision(true, "read-only");
      this.close();
    });

    const deny = buttons.createEl("button", { text: "Deny" });
    deny.addEventListener("click", () => {
      this.decided = true;
      this.onDecision(false, "read-only");
      this.close();
    });
  }

  onClose() {
    if (!this.decided) {
      this.onDecision(false, "read-only");
    }
    this.contentEl.empty();
  }
}
