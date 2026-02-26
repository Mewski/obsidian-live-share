import { type App, PluginSettingTab, SettingGroup } from "obsidian";
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

    new SettingGroup(containerEl)
      .setHeading("Connection")
      .addSetting((s) => {
        s.setName("Server URL")
          .setDesc("The Live Share server to connect to")
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
      })
      .addSetting((s) => {
        s.setName("Server password")
          .setDesc("Required if the server has a password set")
          .addText((text) => {
            text
              .setPlaceholder("None")
              .setValue(settings.serverPassword)
              .onChange(async (value) => {
                settings.serverPassword = value;
                await this.plugin.saveSettings();
              });
            text.inputEl.type = "password";
            if (active) text.setDisabled(true);
          });
      })
      .addSetting((s) => {
        if (authManager.isAuthenticated) {
          s.setName("GitHub account")
            .setDesc(`Logged in as ${settings.displayName}`)
            .addButton((btn) =>
              btn.setButtonText("Log out").onClick(async () => {
                await authManager.logout();
                this.display();
              }),
            );
        } else {
          s.setName("GitHub account")
            .setDesc("Optional, used for identity verification")
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
      });

    new SettingGroup(containerEl)
      .setHeading("Identity")
      .addSetting((s) => {
        s.setName("Display name")
          .setDesc("Shown to other collaborators")
          .addText((text) => {
            text
              .setPlaceholder("Anonymous")
              .setValue(settings.displayName)
              .onChange(async (value) => {
                settings.displayName = value.trim() || "Anonymous";
                await this.plugin.saveSettings();
              });
            if (authManager.isAuthenticated) text.setDisabled(true);
          });
      })
      .addSetting((s) => {
        s.setName("Cursor color")
          .setDesc("Your cursor and selection color visible to others")
          .addColorPicker((color) =>
            color.setValue(settings.cursorColor).onChange(async (value) => {
              settings.cursorColor = value;
              await this.plugin.saveSettings();
            }),
          );
      });

    const session = new SettingGroup(containerEl).setHeading("Session");

    if (active) {
      const connectionState = this.plugin.connectionState.getState();
      const role = settings.role === "host" ? "Hosting" : "Joined";
      const stateLabel =
        connectionState === "connected"
          ? "Connected"
          : connectionState === "connecting"
            ? "Connecting..."
            : connectionState === "error"
              ? "Error"
              : connectionState === "auth-required"
                ? "Auth required"
                : connectionState;
      session.addSetting((s) => {
        s.setName(`${role} · ${stateLabel}`).setDesc(`Room: ${settings.roomId}`);
      });
    }

    session
      .addSetting((s) => {
        s.setName("Shared folder")
          .setDesc("Only share a subfolder instead of the whole vault")
          .addText((text) => {
            text
              .setPlaceholder("Entire vault")
              .setValue(settings.sharedFolder)
              .onChange(async (value) => {
                settings.sharedFolder = value;
                await this.plugin.saveSettings();
              });
            if (active) text.setDisabled(true);
          });
      })
      .addSetting((s) => {
        s.setName("Require approval")
          .setDesc("Guests must be approved by the host before joining")
          .addToggle((toggle) => {
            toggle.setValue(settings.requireApproval).onChange(async (value) => {
              settings.requireApproval = value;
              await this.plugin.saveSettings();
            });
            if (active) toggle.setDisabled(true);
          });
      });

    if (active) {
      session.addSetting((s) => {
        s.setName("End-to-end encryption").setDesc(
          settings.encryptionPassphrase ? "Active" : "Inactive",
        );
      });
    }

    new SettingGroup(containerEl).setHeading("Advanced").addSetting((s) => {
      s.setName("File exclusion").setDesc(
        'To exclude files from sharing, create a .liveshare.json file in your vault root with an "exclude" array of glob patterns. For example: { "exclude": ["*.tmp", "drafts/**", "private/**"] }. The .obsidian and .trash folders are always excluded.',
      );
    });
  }
}
