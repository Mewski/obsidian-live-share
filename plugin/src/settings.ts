import { type App, PluginSettingTab, Setting } from "obsidian";
import type LiveSharePlugin from "./main";

export class LiveShareSettingTab extends PluginSettingTab {
  private plugin: LiveSharePlugin;

  constructor(app: App, plugin: LiveSharePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const { settings, sessionManager, authManager } = this.plugin;
    const active = sessionManager.isActive;

    if (authManager.isAuthenticated) {
      new Setting(containerEl)
        .setName("GitHub account")
        .setDesc(`Logged in as ${settings.displayName}`)
        .addButton((btn) =>
          btn.setButtonText("Log out").onClick(async () => {
            await authManager.logout();
            this.display();
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("GitHub account")
        .setDesc("Log in to authenticate with the server")
        .addButton((btn) =>
          btn
            .setButtonText("Log in with GitHub")
            .setCta()
            .onClick(async () => {
              await authManager.authenticate();
              this.display();
            }),
        );
    }

    const connectionState = this.plugin.connectionState.getState();
    if (active) {
      const role = settings.role === "host" ? "Hosting" : "Joined";
      const stateLabel =
        connectionState === "connected"
          ? "Connected"
          : connectionState === "reconnecting"
            ? "Reconnecting..."
            : connectionState === "connecting"
              ? "Connecting..."
              : connectionState === "error"
                ? "Error"
                : connectionState === "auth-required"
                  ? "Auth required"
                  : connectionState;
      new Setting(containerEl)
        .setName("Session active")
        .setDesc(`${role} — Room: ${settings.roomId} — ${stateLabel}`);
    }

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("HTTP URL of the Obsidian Live Share server")
      .addText((text) => {
        text
          .setPlaceholder("http://localhost:4321")
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            settings.serverUrl = value;
            await this.plugin.saveSettings();
          });
        if (active) text.setDisabled(true);
      });

    new Setting(containerEl)
      .setName("Display name")
      .setDesc("Your name shown to collaborators")
      .addText((text) =>
        text
          .setPlaceholder("Anonymous")
          .setValue(settings.displayName)
          .onChange(async (value) => {
            settings.displayName = value.trim() || "Anonymous";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Cursor color")
      .setDesc("Your cursor color visible to others")
      .addColorPicker((color) =>
        color.setValue(settings.cursorColor).onChange(async (value) => {
          settings.cursorColor = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Shared folder")
      .setDesc("Subfolder to share (empty = whole vault)")
      .addText((text) => {
        text
          .setPlaceholder("shared/")
          .setValue(settings.sharedFolder)
          .onChange(async (value) => {
            settings.sharedFolder = value;
            await this.plugin.saveSettings();
          });
        if (active) text.setDisabled(true);
      });

    new Setting(containerEl)
      .setName("Require approval")
      .setDesc("Guests must be approved by the host before joining")
      .addToggle((toggle) => {
        toggle.setValue(settings.requireApproval).onChange(async (value) => {
          settings.requireApproval = value;
          await this.plugin.saveSettings();
        });
        if (active) toggle.setDisabled(true);
      });

    if (active) {
      new Setting(containerEl)
        .setName("Room ID")
        .setDesc("Read-only during active session")
        .addText((text) => text.setValue(settings.roomId).setDisabled(true));

      new Setting(containerEl)
        .setName("Token")
        .setDesc("Read-only during active session")
        .addText((text) => text.setValue(settings.token).setDisabled(true));

      new Setting(containerEl)
        .setName("End-to-end encryption")
        .setDesc(
          settings.encryptionPassphrase
            ? "Active — file content in control messages is encrypted"
            : "Inactive — no encryption passphrase set",
        );
    }

    new Setting(containerEl)
      .setName("File exclusion")
      .setDesc(
        `Create a .liveshare.json file in your vault root to exclude files. Format: { "exclude": ["*.tmp", "drafts/**"] }. Default excludes: .obsidian/**, .liveshare.json, .trash/**`,
      );
  }
}
