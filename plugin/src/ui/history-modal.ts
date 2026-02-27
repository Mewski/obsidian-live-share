import { type App, Modal, Notice } from "obsidian";

import type { SnapshotEntry } from "../files/version-history";
import { ConfirmModal } from "./modals";

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private filePath: string,
    private snapshots: SnapshotEntry[],
    private onPreview: (index: number) => string,
    private onRestore: (index: number) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: `Version History: ${this.filePath}` });

    if (this.snapshots.length === 0) {
      contentEl.createEl("p", { text: "No snapshots available for this file." });
      return;
    }

    const list = contentEl.createDiv({ cls: "live-share-history-list" });

    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const snapshot = this.snapshots[i];
      const item = list.createDiv({ cls: "live-share-history-item" });

      const header = item.createDiv({ cls: "live-share-history-header" });

      const date = new Date(snapshot.timestamp);
      const dateStr = date.toLocaleString();
      const title = snapshot.label ? `${snapshot.label} (${dateStr})` : dateStr;

      header.createEl("strong", { text: title });
      header.createEl("span", {
        text: ` by ${snapshot.displayName}`,
        cls: "live-share-history-author",
      });

      const actions = item.createDiv({ cls: "live-share-history-actions" });

      const previewBtn = actions.createEl("button", { text: "Preview" });
      const idx = i;
      previewBtn.addEventListener("click", () => {
        try {
          const content = this.onPreview(idx);
          new PreviewModal(this.app, snapshot, content).open();
        } catch {
          new Notice("Live Share: failed to preview snapshot");
        }
      });

      const restoreBtn = actions.createEl("button", {
        text: "Restore",
        cls: "mod-warning",
      });
      restoreBtn.addEventListener("click", () => {
        new ConfirmModal(
          this.app,
          "Are you sure you want to restore to this snapshot? Current content will be replaced.",
          (confirmed) => {
            if (!confirmed) return;
            try {
              this.onRestore(idx);
              new Notice("Live Share: snapshot restored");
              this.close();
            } catch {
              new Notice("Live Share: failed to restore snapshot");
            }
          },
        ).open();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PreviewModal extends Modal {
  constructor(
    app: App,
    private snapshot: SnapshotEntry,
    private content: string,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const date = new Date(this.snapshot.timestamp);
    const title = this.snapshot.label
      ? `${this.snapshot.label} (${date.toLocaleString()})`
      : date.toLocaleString();

    contentEl.createEl("h2", { text: `Preview: ${title}` });
    contentEl.createEl("p", {
      text: `Author: ${this.snapshot.displayName}`,
      cls: "live-share-history-author",
    });

    const preview = contentEl.createEl("pre", {
      cls: "live-share-preview-content",
    });
    preview.textContent = this.content;
  }

  onClose() {
    this.contentEl.empty();
  }
}
