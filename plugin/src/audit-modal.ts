import { type App, Modal } from "obsidian";

interface AuditEntry {
  timestamp: number;
  event: string;
  userId: string;
  displayName: string;
  details?: string;
}

export class AuditLogModal extends Modal {
  constructor(
    app: App,
    private entries: AuditEntry[],
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Audit Log" });

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "No audit log entries." });
      return;
    }

    const list = contentEl.createDiv({ cls: "live-share-audit-list" });
    for (const entry of this.entries) {
      const item = list.createDiv({ cls: "live-share-audit-item" });
      const date = new Date(entry.timestamp);
      const time = date.toLocaleString();
      const name = entry.displayName || entry.userId;
      const detail = entry.details ? ` (${entry.details})` : "";
      item.createEl("span", {
        text: `${time} — ${entry.event}: ${name}${detail}`,
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
