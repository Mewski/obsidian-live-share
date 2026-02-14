import { Notice } from "obsidian";
import type LiveSharePlugin from "./main";

interface InvitePayload {
  s: string; // serverUrl
  r: string; // roomId
  t: string; // token
}

export class SessionManager {
  constructor(private plugin: LiveSharePlugin) {}

  async startSession(name: string): Promise<boolean> {
    const { settings } = this.plugin;
    const baseUrl = settings.serverUrl.replace(/\/+$/, "");

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          hostUserId: settings.githubUserId || settings.displayName,
        }),
      });
    } catch {
      new Notice("Live Share: cannot reach server");
      return false;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      new Notice(`Live Share: ${(err as { error: string }).error}`);
      return false;
    }

    const data = (await res.json()) as {
      id: string;
      token: string;
      name: string;
    };

    settings.roomId = data.id;
    settings.token = data.token;
    settings.role = "host";
    await this.plugin.saveSettings();

    await this.copyInvite();
    return true;
  }

  async joinSession(inviteString: string): Promise<boolean> {
    const parsed = this.parseInvite(inviteString);
    if (!parsed) {
      new Notice("Live Share: invalid invite string");
      return false;
    }

    const { settings } = this.plugin;
    const baseUrl = parsed.s.replace(/\/+$/, "");

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/rooms/${parsed.r}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: parsed.t }),
      });
    } catch {
      new Notice("Live Share: cannot reach server");
      return false;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      new Notice(`Live Share: ${(err as { error: string }).error}`);
      return false;
    }

    settings.serverUrl = parsed.s;
    settings.roomId = parsed.r;
    settings.token = parsed.t;
    settings.role = "guest";
    await this.plugin.saveSettings();

    return true;
  }

  async endSession(): Promise<void> {
    const { settings } = this.plugin;

    if (settings.role === "host" && settings.roomId && settings.token) {
      const baseUrl = settings.serverUrl.replace(/\/+$/, "");
      try {
        await fetch(`${baseUrl}/rooms/${settings.roomId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${settings.token}` },
        });
      } catch {
        // Best effort
      }
    }

    settings.roomId = "";
    settings.token = "";
    settings.role = null;
    await this.plugin.saveSettings();
  }

  async copyInvite(): Promise<void> {
    const { settings } = this.plugin;
    if (!settings.roomId || !settings.token) {
      new Notice("Live Share: no active session");
      return;
    }

    const payload: InvitePayload = {
      s: settings.serverUrl,
      r: settings.roomId,
      t: settings.token,
    };
    const invite = `obsliveshare:${btoa(JSON.stringify(payload))}`;
    await navigator.clipboard.writeText(invite);
    new Notice("Invite link copied to clipboard");
  }

  private parseInvite(raw: string): InvitePayload | null {
    const invite = raw.trim();
    const prefix = "obsliveshare:";
    if (!invite.startsWith(prefix)) return null;
    try {
      const json = atob(invite.slice(prefix.length));
      const parsed = JSON.parse(json);
      if (
        typeof parsed.s === "string" &&
        typeof parsed.r === "string" &&
        typeof parsed.t === "string"
      ) {
        // Validate server URL protocol
        const url = new URL(parsed.s);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return null;
        }
        return parsed as InvitePayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  get isActive(): boolean {
    return this.plugin.settings.role !== null;
  }

  get role() {
    return this.plugin.settings.role;
  }
}
