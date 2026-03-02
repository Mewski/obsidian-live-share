import { type App, PluginSettingTab, SettingGroup } from "obsidian";
import type LiveSharePlugin from "../main";

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
      .addSetting((setting) => {
        setting
          .setName("Server URL")
          .setDesc("The server to connect to")
          .addText((text) => {
            text.setValue(settings.serverUrl).onChange(async (value) => {
              settings.serverUrl = value;
              await this.plugin.saveSettings();
            });
            text.inputEl.placeholder = "http://localhost:3000";
            if (active) text.setDisabled(true);
          });
      })
      .addSetting((setting) => {
        setting
          .setName("Server password")
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
      .addSetting((setting) => {
        if (authManager.isAuthenticated) {
          setting
            .setName("GitHub account")
            .setDesc(`Logged in as ${settings.displayName}`)
            .addButton((button) =>
              button.setButtonText("Log out").onClick(async () => {
                await authManager.logout();
                this.display();
              }),
            );
        } else {
          setting
            .setName("GitHub account")
            .setDesc("Optional, used for identity verification")
            .addButton((button) =>
              button
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
      .addSetting((setting) => {
        setting
          .setName("Display name")
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
      .addSetting((setting) => {
        setting
          .setName("Cursor color")
          .setDesc("Your cursor and selection color visible to others")
          .addColorPicker((color) =>
            color.setValue(settings.cursorColor).onChange(async (value) => {
              settings.cursorColor = value;
              await this.plugin.saveSettings();
            }),
          );
      });

    const session = new SettingGroup(containerEl).setHeading("Session");

    session.addSetting((setting) => {
      if (active) {
        const connectionState = this.plugin.connectionState.getState();
        const role = settings.role === "host" ? "Hosting" : "Joined";
        const stateLabels: Record<string, string> = {
          connected: "Connected",
          connecting: "Connecting...",
          reconnecting: "Reconnecting...",
          error: "Error",
          "auth-required": "Auth required",
          disconnected: "Disconnected",
        };
        const stateLabel = stateLabels[connectionState] ?? connectionState;
        const encrypted = settings.encryptionPassphrase ? "Encrypted" : "Not encrypted";
        setting
          .setName(`${role} · ${stateLabel}`)
          .setDesc(`Room: ${settings.roomId} · ${encrypted}`);
        setting.addButton((button) =>
          button.setButtonText("Copy invite link").onClick(() => {
            sessionManager.copyInvite();
          }),
        );
        if (settings.role === "host") {
          setting.addButton((button) =>
            button
              .setButtonText("End session")
              .setWarning()
              .onClick(() => {
                void this.plugin.endSession().then(() => this.display());
              }),
          );
        } else {
          setting.addButton((button) =>
            button
              .setButtonText("Leave session")
              .setWarning()
              .onClick(() => {
                void this.plugin.endSession().then(() => this.display());
              }),
          );
        }
      } else {
        setting.setName("No active session");
        setting.addButton((button) =>
          button.setButtonText("Join session").onClick(async () => {
            await this.plugin.joinSession();
            this.display();
          }),
        );
        setting.addButton((button) =>
          button
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
      .addSetting((setting) => {
        setting
          .setName("Shared folder")
          .setDesc("Only share a subfolder instead of the whole vault")
          .addText((text) => {
            text
              .setPlaceholder("Entire vault")
              .setValue(settings.sharedFolder)
              .onChange(async (value) => {
                settings.sharedFolder = value.replace(/^[./\\]+/, "").replace(/\.\./g, "");
                await this.plugin.saveSettings();
              });
            if (active) text.setDisabled(true);
          });
      })
      .addSetting((setting) => {
        setting
          .setName("Require approval")
          .setDesc("Guests must be approved by the host before joining")
          .addToggle((toggle) => {
            toggle.setValue(settings.requireApproval).onChange(async (value) => {
              settings.requireApproval = value;
              await this.plugin.saveSettings();
            });
            if (active) toggle.setDisabled(true);
          });
      })
      .addSetting((setting) => {
        setting
          .setName("Approval timeout (seconds)")
          .setDesc("Auto-deny join requests after this many seconds. 0 to disable.")
          .addText((text) => {
            text
              .setPlaceholder("60")
              .setValue(String(settings.approvalTimeoutSeconds))
              .onChange(async (value) => {
                const parsed = Number.parseInt(value, 10);
                settings.approvalTimeoutSeconds = Number.isNaN(parsed) ? 60 : Math.max(0, parsed);
                await this.plugin.saveSettings();
              });
          });
      });

    new SettingGroup(containerEl)
      .setHeading("Preferences")
      .addSetting((setting) => {
        setting
          .setName("Notifications")
          .setDesc("Show status notices for non-critical events like file syncs and follows")
          .addToggle((toggle) =>
            toggle.setValue(settings.notificationsEnabled).onChange(async (value) => {
              settings.notificationsEnabled = value;
              await this.plugin.saveSettings();
            }),
          );
      })
      .addSetting((setting) => {
        setting
          .setName("Auto-reconnect")
          .setDesc("Automatically rejoin the previous session when Obsidian starts")
          .addToggle((toggle) =>
            toggle.setValue(settings.autoReconnect).onChange(async (value) => {
              settings.autoReconnect = value;
              await this.plugin.saveSettings();
            }),
          );
      });

    new SettingGroup(containerEl)
      .setHeading("Debug")
      .addSetting((setting) => {
        setting
          .setName("Debug logging")
          .setDesc("Write timestamped debug logs to a file in your vault")
          .addToggle((toggle) =>
            toggle.setValue(settings.debugLogging).onChange(async (value) => {
              settings.debugLogging = value;
              await this.plugin.saveSettings();
            }),
          );
      })
      .addSetting((setting) => {
        setting
          .setName("Debug log file")
          .setDesc("Path within your vault for the debug log")
          .addText((text) => {
            text.setValue(settings.debugLogPath).onChange(async (value) => {
              settings.debugLogPath = value.trim() || "live-share-debug.md";
              await this.plugin.saveSettings();
            });
            text.inputEl.placeholder = "live-share-debug.md";
          });
      });

    const exclusions = new SettingGroup(containerEl).setHeading("Exclusions");

    exclusions.addSetting((setting) => {
      setting
        .setName("Excluded patterns")
        .setDesc("Glob patterns for files to exclude from sharing.");
      setting.addButton((button) =>
        button
          .setButtonText("Add exclusion")
          .setCta()
          .onClick(async () => {
            const value = await this.plugin.promptText("Glob pattern, e.g. *.tmp or drafts/**");
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
      exclusions.addSetting((setting) => {
        setting.setName(pattern);
        setting.addExtraButton((button) =>
          button
            .setIcon("cross")
            .setTooltip("Remove this pattern")
            .onClick(async () => {
              settings.excludePatterns = settings.excludePatterns.filter((p) => p !== pattern);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
      });
    }

    const readOnly = new SettingGroup(containerEl).setHeading("Permissions");

    readOnly.addSetting((setting) => {
      setting
        .setName("Read-only patterns")
        .setDesc("Glob patterns for files that guests cannot edit.");
      setting.addButton((button) =>
        button
          .setButtonText("Add pattern")
          .setCta()
          .onClick(async () => {
            const value = await this.plugin.promptText(
              "Glob pattern, e.g. journal/** or README.md",
            );
            if (value) {
              const trimmed = value.trim();
              if (trimmed && !settings.readOnlyPatterns.includes(trimmed)) {
                settings.readOnlyPatterns.push(trimmed);
                await this.plugin.saveSettings();
                this.display();
              }
            }
          }),
      );
    });

    for (const pattern of settings.readOnlyPatterns) {
      readOnly.addSetting((setting) => {
        setting.setName(pattern);
        setting.addExtraButton((button) =>
          button
            .setIcon("cross")
            .setTooltip("Remove this pattern")
            .onClick(async () => {
              settings.readOnlyPatterns = settings.readOnlyPatterns.filter((p) => p !== pattern);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
      });
    }
  }
}
