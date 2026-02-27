import { MarkdownView, Notice } from "obsidian";

import type LiveSharePlugin from "../main";
import { FilePermissionModal, type FilePermissionUser } from "../ui/file-permission-modal";
import { HistoryModal } from "../ui/history-modal";
import { UserPickerModal } from "../ui/modals";

export function registerCommands(plugin: LiveSharePlugin): void {
  plugin.addCommand({
    id: "start-session",
    name: "Start session",
    callback: () => plugin.startSession(),
  });

  plugin.addCommand({
    id: "join-session",
    name: "Join session",
    callback: () => plugin.joinSession(),
  });

  plugin.addCommand({
    id: "end-session",
    name: "End session",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      if (checking) return true;
      (async () => {
        const confirmed = await plugin.confirm(
          "Are you sure you want to end the session? All participants will be disconnected.",
        );
        if (confirmed) plugin.endSession();
      })().catch(() => {});
    },
  });

  plugin.addCommand({
    id: "leave-session",
    name: "Leave session",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "guest" || !plugin.sessionManager.isActive) return false;
      if (checking) return true;
      (async () => {
        const confirmed = await plugin.confirm("Are you sure you want to leave the session?");
        if (confirmed) plugin.endSession();
      })().catch(() => {});
    },
  });

  plugin.addCommand({
    id: "copy-invite",
    name: "Copy invite link",
    callback: () => plugin.sessionManager.copyInvite(),
  });

  plugin.addCommand({
    id: "show-collaborators",
    name: "Show collaborators panel",
    callback: () => plugin.activatePresenceView(),
  });

  plugin.addCommand({
    id: "log-in",
    name: "Log in with GitHub",
    callback: () => plugin.authManager.authenticate(),
  });

  plugin.addCommand({
    id: "log-out",
    name: "Log out",
    callback: () => plugin.authManager.logout(),
  });

  plugin.addCommand({
    id: "focus-here",
    name: "Focus participants here",
    editorCallback: (editor, view) => {
      const cursor = editor.getCursor();
      const filePath = view.file?.path;
      if (!filePath || !plugin.controlChannel) return;
      plugin.controlChannel.send({
        type: "focus-request",
        fromUserId: plugin.settings.githubUserId || plugin.settings.clientId,
        fromDisplayName: plugin.settings.displayName,
        filePath,
        line: cursor.line,
        ch: cursor.ch,
      });
      plugin.notify("Live Share: focus request sent");
    },
  });

  plugin.addCommand({
    id: "summon-all",
    name: "Summon all participants here",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView?.file) return false;
      if (checking) return true;
      const cursor = activeView.editor.getCursor();
      plugin.controlChannel?.send({
        type: "summon",
        fromUserId: plugin.settings.githubUserId || plugin.settings.clientId,
        fromDisplayName: plugin.settings.displayName,
        targetUserId: "__all__",
        filePath: activeView.file.path,
        line: cursor.line,
        ch: cursor.ch,
      });
      plugin.notify("Live Share: summon sent to all participants");
    },
  });

  plugin.addCommand({
    id: "reload-from-host",
    name: "Reload all files from host",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "guest" || !plugin.sessionManager.isActive) return false;
      if (checking) return true;
      plugin.reloadFromHost();
    },
  });

  plugin.addCommand({
    id: "summon-user",
    name: "Summon a specific participant here",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      if (plugin.remoteUsers.size === 0) return false;
      if (checking) return true;
      new UserPickerModal(plugin.app, plugin.remoteUsers, (userId) => {
        plugin.summonUser(userId);
      }).open();
    },
  });

  plugin.addCommand({
    id: "toggle-present",
    name: "Toggle presentation mode",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      if (checking) return true;
      plugin.presenceManager?.togglePresent();
    },
  });

  plugin.addCommand({
    id: "transfer-host",
    name: "Transfer host role",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      if (plugin.remoteUsers.size === 0) return false;
      if (checking) return true;
      new UserPickerModal(plugin.app, plugin.remoteUsers, (userId) => {
        plugin.controlChannel?.send({
          type: "host-transfer-offer",
          userId,
        });
        const user = plugin.remoteUsers.get(userId);
        plugin.notify(`Live Share: offered host role to ${user?.displayName ?? userId}`);
      }).open();
    },
  });

  plugin.addCommand({
    id: "show-version-history",
    name: "Show version history",
    editorCallback: (_editor, view) => {
      if (!view.file) return;
      const filePath = view.file.path;
      const snapshots = plugin.versionHistory.getSnapshots(filePath);
      new HistoryModal(
        plugin.app,
        filePath,
        snapshots,
        (index) => plugin.versionHistory.restoreSnapshot(filePath, index),
        (index) => {
          plugin.versionHistory.applySnapshot(filePath, index);
          plugin.saveVersionHistory();
        },
      ).open();
    },
  });

  plugin.addCommand({
    id: "create-snapshot",
    name: "Create snapshot",
    editorCallback: async (_editor, view) => {
      if (!view.file) return;
      const label = await plugin.promptText("Snapshot label (optional)");
      try {
        plugin.versionHistory.captureSnapshot(view.file.path, label || undefined);
        await plugin.saveVersionHistory();
        plugin.notify("Live Share: snapshot created");
      } catch {
        new Notice("Live Share: failed to create snapshot");
      }
    },
  });

  plugin.addCommand({
    id: "show-audit-log",
    name: "Show audit log",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      if (checking) return true;
      plugin.fetchAuditLog();
    },
  });

  plugin.addCommand({
    id: "set-file-permissions",
    name: "Set file permissions",
    checkCallback: (checking) => {
      if (plugin.settings.role !== "host" || !plugin.sessionManager.isActive) return false;
      const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView?.file) return false;
      if (plugin.remoteUsers.size === 0) return false;
      if (checking) return true;
      const filePath = activeView.file.path;
      const users: FilePermissionUser[] = [];
      for (const [userId, user] of plugin.remoteUsers) {
        users.push({
          userId,
          displayName: user.displayName,
          permission: user.permission ?? "read-write",
        });
      }
      new FilePermissionModal(plugin.app, filePath, users, (userId, fp, permission) => {
        plugin.controlChannel?.send({
          type: "set-file-permission",
          userId,
          filePath: fp,
          permission,
        });
      }).open();
    },
  });
}
