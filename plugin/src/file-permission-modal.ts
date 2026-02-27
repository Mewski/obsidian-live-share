import { type App, Modal, Setting } from "obsidian";

import type { Permission } from "./types";

export interface FilePermissionUser {
  userId: string;
  displayName: string;
  permission: Permission;
}

export class FilePermissionModal extends Modal {
  private filePath: string;
  private users: FilePermissionUser[];
  private onSetPermission: (userId: string, filePath: string, permission: Permission) => void;

  constructor(
    app: App,
    filePath: string,
    users: FilePermissionUser[],
    onSetPermission: (userId: string, filePath: string, permission: Permission) => void,
  ) {
    super(app);
    this.filePath = filePath;
    this.users = users;
    this.onSetPermission = onSetPermission;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `File permissions: ${this.filePath}` });

    if (this.users.length === 0) {
      contentEl.createEl("p", { text: "No collaborators connected." });
      return;
    }

    for (const user of this.users) {
      new Setting(contentEl).setName(user.displayName).addDropdown((dropdown) => {
        dropdown
          .addOption("read-write", "Read-Write")
          .addOption("read-only", "Read-Only")
          .setValue(user.permission)
          .onChange((value) => {
            const perm = value as Permission;
            user.permission = perm;
            this.onSetPermission(user.userId, this.filePath, perm);
          });
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
