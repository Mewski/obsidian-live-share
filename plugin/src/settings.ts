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

    session.addSetting((s) => {
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
        s.setName(`${role} · ${stateLabel}`).setDesc(
          `Room: ${settings.roomId}`,
        );
        s.addButton((btn) =>
          btn.setButtonText("Copy invite link").onClick(() => {
            sessionManager.copyInvite();
          }),
        );
        if (settings.role === "host") {
          s.addButton((btn) =>
            btn
              .setButtonText("End session")
              .setWarning()
              .onClick(async () => {
                await this.plugin.endSession();
                this.display();
              }),
          );
        } else {
          s.addButton((btn) =>
            btn
              .setButtonText("Leave session")
              .setWarning()
              .onClick(async () => {
                await this.plugin.endSession();
                this.display();
              }),
          );
        }
      } else {
        s.setName("No active session");
        s.addButton((btn) =>
          btn.setButtonText("Join session").onClick(async () => {
            await this.plugin.joinSession();
            this.display();
          }),
        );
        s.addButton((btn) =>
          btn
            .setButtonText("Start session")
            .setCta()
            .onClick(async () => {
              await this.plugin.startSession();
              this.display();
            }),
        );
      }
    });

    session
      .addSetting((s) => {
        s.setName("Shared folder")
          .setDesc("Only share a subfolder instead of the whole vault")
          .addText((text) => {
            text
              .setPlaceholder("Entire vault")
              .setValue(settings.sharedFolder)
              .onChange(async (value) => {
                settings.sharedFolder = value
                  .replace(/^[./\\]+/, "")
                  .replace(/\.\./g, "");
                await this.plugin.saveSettings();
              });
            if (active) text.setDisabled(true);
          });
      })
      .addSetting((s) => {
        s.setName("Require approval")
          .setDesc("Guests must be approved by the host before joining")
          .addToggle((toggle) => {
            toggle
              .setValue(settings.requireApproval)
              .onChange(async (value) => {
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

    new SettingGroup(containerEl)
      .setHeading("Preferences")
      .addSetting((s) => {
        s.setName("Notifications")
          .setDesc(
            "Show status notices for non-critical events like file syncs and follows",
          )
          .addToggle((toggle) =>
            toggle
              .setValue(settings.notificationsEnabled)
              .onChange(async (value) => {
                settings.notificationsEnabled = value;
                await this.plugin.saveSettings();
              }),
          );
      })
      .addSetting((s) => {
        s.setName("Auto-reconnect")
          .setDesc(
            "Automatically rejoin the previous session when Obsidian starts",
          )
          .addToggle((toggle) =>
            toggle.setValue(settings.autoReconnect).onChange(async (value) => {
              settings.autoReconnect = value;
              await this.plugin.saveSettings();
            }),
          );
      });

    new SettingGroup(containerEl)
      .setHeading("Debug")
      .addSetting((s) => {
        s.setName("Debug logging")
          .setDesc("Write timestamped debug logs to a file in your vault")
          .addToggle((toggle) =>
            toggle.setValue(settings.debugLogging).onChange(async (value) => {
              settings.debugLogging = value;
              await this.plugin.saveSettings();
            }),
          );
      })
      .addSetting((s) => {
        s.setName("Debug log file")
          .setDesc("Path within your vault for the debug log")
          .addText((text) =>
            text
              .setPlaceholder("live-share-debug.md")
              .setValue(settings.debugLogPath)
              .onChange(async (value) => {
                settings.debugLogPath = value.trim() || "live-share-debug.md";
                await this.plugin.saveSettings();
              }),
          );
      });

    const advanced = new SettingGroup(containerEl).setHeading("Advanced");

    advanced.addSetting((s) => {
      s.setName("Excluded patterns").setDesc(
        "Glob patterns for files to exclude from sharing.",
      );
      s.addButton((btn) =>
        btn
          .setButtonText("Add exclusion")
          .setCta()
          .onClick(async () => {
            const value = await this.plugin.promptText(
              "Glob pattern, e.g. *.tmp or drafts/**",
            );
            if (value) {
              const trimmed = value.trim();
              if (trimmed && !settings.excludePatterns.includes(trimmed)) {
                settings.excludePatterns.push(trimmed);
                await this.plugin.saveSettings();
                this.display();
              }
            }
          }),
      );
    });

    for (const pattern of settings.excludePatterns) {
      advanced.addSetting((s) => {
        s.setName(pattern);
        s.addExtraButton((btn) =>
          btn
            .setIcon("cross")
            .setTooltip("Remove this pattern")
            .onClick(async () => {
              settings.excludePatterns = settings.excludePatterns.filter(
                (p) => p !== pattern,
              );
              await this.plugin.saveSettings();
              this.display();
            }),
        );
      });
    }
  }
}
