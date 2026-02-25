import { Notice } from "obsidian";

import type LiveSharePlugin from "./main";

interface InvitePayload {
  s: string;
  r: string;
  t: string;
  e?: string;
}

function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class SessionManager {
  constructor(private plugin: LiveSharePlugin) {}

  async startSession(): Promise<boolean> {
    const { settings } = this.plugin;
    const baseUrl = settings.serverUrl.replace(/\/+$/, "");

    let createResponse: Response;
    try {
      createResponse = await fetch(`${baseUrl}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostUserId: settings.githubUserId || settings.clientId,
          requireApproval: settings.requireApproval,
        }),
      });
    } catch {
      new Notice("Live Share: cannot reach server");
      return false;
    }

    if (!createResponse.ok) {
      const err = await createResponse.json().catch(() => ({ error: "unknown" }));
      new Notice(`Live Share: ${(err as { error: string }).error}`);
      return false;
    }

    const roomData = (await createResponse.json()) as {
      id: string;
      token: string;
      name: string;
    };

    settings.roomId = roomData.id;
    settings.token = roomData.token;
    settings.role = "host";
    settings.encryptionPassphrase = generatePassphrase();
    await this.plugin.saveSettings();

    await this.copyInvite();
    return true;
  }

  async joinSession(inviteString: string): Promise<boolean> {
    const parsedInvite = this.parseInvite(inviteString);
    if (!parsedInvite) {
      new Notice("Live Share: invalid invite string");
      return false;
    }

    const { settings } = this.plugin;
    const baseUrl = parsedInvite.s.replace(/\/+$/, "");

    let joinResponse: Response;
    try {
      joinResponse = await fetch(`${baseUrl}/rooms/${parsedInvite.r}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: parsedInvite.t }),
      });
    } catch {
      new Notice("Live Share: cannot reach server");
      return false;
    }

    if (!joinResponse.ok) {
      const err = await joinResponse.json().catch(() => ({ error: "unknown" }));
      new Notice(`Live Share: ${(err as { error: string }).error}`);
      return false;
    }

    settings.serverUrl = parsedInvite.s;
    settings.roomId = parsedInvite.r;
    settings.token = parsedInvite.t;
    settings.encryptionPassphrase = parsedInvite.e ?? "";
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
      } catch {}
    }

    settings.roomId = "";
    settings.token = "";
    settings.encryptionPassphrase = "";
    settings.role = null;
    settings.permission = "read-write";
    await this.plugin.saveSettings();
  }

  get isActive(): boolean {
    return this.plugin.settings.role !== null;
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
      e: settings.encryptionPassphrase || undefined,
    };
    const invite = `obsliveshare:${btoa(JSON.stringify(payload))}`;
    await navigator.clipboard.writeText(invite);
    new Notice("Live Share: invite link copied to clipboard");
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
}
