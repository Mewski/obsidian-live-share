import { App, PluginSettingTab, Setting } from "obsidian";
import type LiveSharePlugin from "./main";

export class LiveShareSettingTab extends PluginSettingTab {
  plugin: LiveSharePlugin;

  constructor(app: App, plugin: LiveSharePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const { settings, sessionManager, authManager } = this.plugin;
    const active = sessionManager.isActive;

    // Auth section
    if (authManager.isAuthenticated) {
      new Setting(containerEl)
        .setName("GitHub account")
        .setDesc(`Logged in as ${settings.displayName}`)
        .addButton((btn) =>
          btn.setButtonText("Log out").onClick(() => {
            authManager.logout().then(() => this.display());
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
            .onClick(() => {
              authManager.authenticate().then(() => this.display());
            }),
        );
    }

    // Connection state
    const connState = this.plugin.connectionState.getState();
    if (active) {
      const role = settings.role === "host" ? "Hosting" : "Joined";
      const stateLabel =
        connState === "connected"
          ? "Connected"
          : connState === "reconnecting"
            ? "Reconnecting..."
            : connState === "connecting"
              ? "Connecting..."
              : connState === "error"
                ? "Error"
                : connState;
      new Setting(containerEl)
        .setName("Session active")
        .setDesc(`${role} — Room: ${settings.roomId} — ${stateLabel}`);
    }

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("HTTP URL of the Live Share server")
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
            settings.displayName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Cursor color")
      .setDesc("Your cursor color visible to others")
      .addText((text) =>
        text
          .setPlaceholder("#7c3aed")
          .setValue(settings.cursorColor)
          .onChange(async (value) => {
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

    if (active) {
      new Setting(containerEl)
        .setName("Room ID")
        .setDesc("Read-only during active session")
        .addText((text) => text.setValue(settings.roomId).setDisabled(true));

      new Setting(containerEl)
        .setName("Token")
        .setDesc("Read-only during active session")
        .addText((text) => text.setValue(settings.token).setDisabled(true));
    }

    // File exclusion
    new Setting(containerEl)
      .setName("File exclusion")
      .setDesc(
        "Create a .liveshare.json file in your vault root to exclude files. " +
          'Format: { "exclude": ["*.tmp", "drafts/**"] }. ' +
          "Default excludes: .obsidian/**, .liveshare.json, .trash/**",
      );
  }
}
