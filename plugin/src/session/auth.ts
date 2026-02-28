import { Notice } from "obsidian";
import type LiveSharePlugin from "../main";
import { PromptModal } from "../ui/modals";
import { parseJwtPayload } from "../utils";

export class AuthManager {
  private pendingModal: PromptModal | null = null;

  constructor(private plugin: LiveSharePlugin) {}

  get isAuthenticated(): boolean {
    return !!this.plugin.settings.jwt;
  }

  completeAuth(jwt: string): boolean {
    if (this.pendingModal) {
      this.pendingModal.closeWithValue(jwt);
      this.pendingModal = null;
      return true;
    }
    return false;
  }

  async authenticate(): Promise<boolean> {
    const serverUrl = this.plugin.settings.serverUrl.replace(/\/+$/, "");
    window.open(`${serverUrl}/auth/github?state=${Date.now()}`);

    const jwt = await new Promise<string | null>((resolve) => {
      const modal = new PromptModal(
        this.plugin.app,
        "Waiting for redirect... or paste token here",
        (value) => {
          this.pendingModal = null;
          resolve(value);
        },
      );
      this.pendingModal = modal;
      modal.open();
    });
    if (!jwt) return false;

    try {
      const payload = parseJwtPayload(jwt);
      this.plugin.settings.jwt = jwt;
      this.plugin.settings.githubUserId = payload.sub;
      this.plugin.settings.displayName =
        (payload.displayName || payload.username || "").trim() || "Anonymous";
      this.plugin.settings.avatarUrl = payload.avatar || "";
      await this.plugin.saveSettings();
      new Notice(
        `Live Share: authenticated as ${this.plugin.settings.displayName}`,
      );
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
