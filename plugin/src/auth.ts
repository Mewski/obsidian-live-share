import { Notice } from "obsidian";
import type LiveSharePlugin from "./main";
import { parseJwtPayload } from "./utils";

export class AuthManager {
  constructor(private plugin: LiveSharePlugin) {}

  get isAuthenticated(): boolean {
    return !!this.plugin.settings.jwt;
  }

  async authenticate(): Promise<boolean> {
    const serverUrl = this.plugin.settings.serverUrl.replace(/\/+$/, "");
    window.open(`${serverUrl}/auth/github?state=${Date.now()}`);

    const jwt = await this.plugin.promptText("Paste your auth token");
    if (!jwt) return false;

    try {
      const payload = parseJwtPayload(jwt);
      this.plugin.settings.jwt = jwt;
      this.plugin.settings.githubUserId = payload.sub;
      this.plugin.settings.displayName = payload.displayName || payload.username;
      this.plugin.settings.avatarUrl = payload.avatar || "";
      await this.plugin.saveSettings();
      new Notice(`Live Share: authenticated as ${this.plugin.settings.displayName}`);
      return true;
    } catch {
      new Notice("Live Share: invalid auth token");
      return false;
    }
  }

  async logout(): Promise<void> {
    this.plugin.settings.jwt = "";
    this.plugin.settings.githubUserId = "";
    this.plugin.settings.displayName = "Anonymous";
    this.plugin.settings.avatarUrl = "";
    await this.plugin.saveSettings();
    new Notice("Live Share: logged out");
  }
}
