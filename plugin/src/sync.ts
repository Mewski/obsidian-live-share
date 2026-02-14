import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { LiveShareSettings } from "./types";

export function waitForSync(provider: WebsocketProvider, timeoutMs = 10_000): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off("sync", onSync);
      reject(new Error(`Sync timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function onSync() {
      clearTimeout(timer);
      resolve();
    }
    provider.once("sync", onSync);
  });
}

export class SyncManager {
  private docs = new Map<string, Y.Doc>();
  private providers = new Map<string, WebsocketProvider>();
  private settings: LiveShareSettings;
  private connected = false;

  constructor(settings: LiveShareSettings) {
    this.settings = settings;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  // Get or create a Y.Doc + provider for a file path
  getDoc(filePath: string): { doc: Y.Doc; text: Y.Text; provider: WebsocketProvider } | null {
    if (!this.connected || !this.settings.roomId) return null;

    let doc = this.docs.get(filePath);
    let provider = this.providers.get(filePath);

    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(filePath, doc);
    }

    if (!provider) {
      // Room name = roomId:encodedFilePath to scope per file
      const roomName = `${this.settings.roomId}:${encodeURIComponent(filePath)}`;
      const wsUrl = this.settings.serverUrl.replace(/^http/, "ws");
      const params: Record<string, string> = { token: this.settings.token };
      if (this.settings.jwt) params.jwt = this.settings.jwt;
      provider = new WebsocketProvider(`${wsUrl}/ws`, roomName, doc, {
        params,
      });
      provider.awareness.setLocalStateField("user", {
        name: this.settings.displayName,
        color: this.settings.cursorColor,
        colorLight: `${this.settings.cursorColor}33`,
      });
      this.providers.set(filePath, provider);
    }

    const text = doc.getText("content");
    return { doc, text, provider };
  }

  // Clean up a specific file's doc + provider
  releaseDoc(filePath: string) {
    const provider = this.providers.get(filePath);
    if (provider) {
      provider.destroy();
      this.providers.delete(filePath);
    }
    const doc = this.docs.get(filePath);
    if (doc) {
      doc.destroy();
      this.docs.delete(filePath);
    }
  }

  connect() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
    for (const path of [...this.providers.keys()]) {
      this.releaseDoc(path);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  destroy() {
    this.disconnect();
  }
}
