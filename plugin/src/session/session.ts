import { Notice, requestUrl } from "obsidian";

import type LiveSharePlugin from "../main";

interface InvitePayload {
  s: string;
  r: string;
  t: string;
  e?: string;
  p?: string;
}

function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class SessionManager {
  constructor(private plugin: LiveSharePlugin) {}

  async startSession(): Promise<boolean> {
    const { settings } = this.plugin;
    const baseUrl = settings.serverUrl.replace(/\/+$/, "");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (settings.serverPassword) headers["X-Server-Password"] = settings.serverPassword;

    let roomData: { id: string; token: string; name: string };
    try {
      const createResponse = await requestUrl({
        url: `${baseUrl}/rooms`,
        method: "POST",
        headers,
        body: JSON.stringify({
          hostUserId: settings.githubUserId || settings.clientId,
          requireApproval: settings.requireApproval,
          readOnlyPatterns: settings.readOnlyPatterns,
        }),
        throw: false,
      });
      if (createResponse.status >= 400) {
        const errMsg = createResponse.json?.error ?? "unknown error";
        new Notice(`Live share: ${errMsg}`);
        return false;
      }
      roomData = createResponse.json;
    } catch {
      new Notice("Live share: cannot reach server");
      return false;
    }

    settings.roomId = roomData.id;
    settings.token = roomData.token;
    settings.role = "host";
    settings.encryptionPassphrase = generatePassphrase();
    await this.plugin.saveSettings();

    await this.copyInvite();
    return true;
  }

  async joinSession(inviteString: string): Promise<boolean> {
    const parsedInvite = parseInvite(inviteString);
    if (!parsedInvite) {
      new Notice("Live share: invalid invite string");
      return false;
    }

    const { settings } = this.plugin;
    const baseUrl = parsedInvite.s.replace(/\/+$/, "");
    const serverPassword = parsedInvite.p || settings.serverPassword;

    const joinHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (serverPassword) joinHeaders["X-Server-Password"] = serverPassword;

    try {
      const joinResponse = await requestUrl({
        url: `${baseUrl}/rooms/${parsedInvite.r}/join`,
        method: "POST",
        headers: joinHeaders,
        body: JSON.stringify({ token: parsedInvite.t }),
        throw: false,
      });
      if (joinResponse.status >= 400) {
        const errMsg = joinResponse.json?.error ?? "unknown error";
        new Notice(`Live share: ${errMsg}`);
        return false;
      }
    } catch {
      new Notice("Live share: cannot reach server");
      return false;
    }

    settings.serverUrl = parsedInvite.s;
    settings.roomId = parsedInvite.r;
    settings.token = parsedInvite.t;
    settings.encryptionPassphrase = parsedInvite.e ?? "";
    if (parsedInvite.p) settings.serverPassword = parsedInvite.p;
    settings.role = "guest";
    await this.plugin.saveSettings();

    return true;
  }

  async endSession(): Promise<void> {
    const { settings } = this.plugin;

    if (settings.role === "host" && settings.roomId && settings.token) {
      const baseUrl = settings.serverUrl.replace(/\/+$/, "");
      const deleteHeaders: Record<string, string> = {
        Authorization: `Bearer ${settings.token}`,
      };
      if (settings.serverPassword) deleteHeaders["X-Server-Password"] = settings.serverPassword;
      try {
        await requestUrl({
          url: `${baseUrl}/rooms/${settings.roomId}`,
          method: "DELETE",
          headers: deleteHeaders,
          throw: false,
        });
      } catch {
        // Best-effort cleanup, server may already be gone
      }
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
      new Notice("Live share: no active session");
      return;
    }

    const payload: InvitePayload = {
      s: settings.serverUrl,
      r: settings.roomId,
      t: settings.token,
      e: settings.encryptionPassphrase || undefined,
      p: settings.serverPassword || undefined,
    };
    const invite = `obsliveshare:${btoa(JSON.stringify(payload))}`;
    await navigator.clipboard.writeText(invite);
    new Notice("Live share: invite link copied to clipboard");
  }
}

export function parseInvite(raw: string): InvitePayload | null {
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
    // Invalid base64 or JSON
    return null;
  }
}
