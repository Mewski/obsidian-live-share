import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MUX_SUBSCRIBE, decodeMuxMessage } from "../sync/mux-protocol";
import { SyncManager } from "../sync/sync";
import type { LiveShareSettings } from "../types";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = "blob";
  sent: ArrayBuffer[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;

  url: string;
  constructor(url: string) {
    this.url = url;
  }

  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    if (data instanceof Uint8Array) {
      this.sent.push(
        (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    } else {
      this.sent.push(data);
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

function makeSettings(overrides: Partial<LiveShareSettings> = {}): LiveShareSettings {
  return {
    serverUrl: "http://localhost:3000",
    roomId: "test-room",
    token: "test-token",
    jwt: "",
    serverPassword: "",
    clientId: "client-1",
    githubUserId: "",
    role: "host" as const,
    displayName: "Test",
    avatarUrl: "",
    cursorColor: "#000",
    sharedFolder: "",
    encryptionPassphrase: "",
    autoReconnect: false,
    notificationsEnabled: false,
    debugLogging: false,
    debugLogPath: "",
    excludePatterns: [] as string[],
    requireApproval: false,
    approvalTimeoutSeconds: 60,
    permission: "read-write" as const,
    readOnlyPatterns: [] as string[],
    ...overrides,
  };
}

let mockWsInstances: MockWebSocket[] = [];

describe("SyncManager", () => {
  beforeEach(() => {
    mockWsInstances = [];
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        function MockWSConstructor(url: string) {
          const ws = new MockWebSocket(url);
          mockWsInstances.push(ws);
          return ws;
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getDoc returns a handle before WS opens (shouldConnect is true)", () => {
    const sm = new SyncManager(makeSettings());
    sm.connect();

    // WS is still in CONNECTING state
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].readyState).toBe(MockWebSocket.CONNECTING);

    const handle = sm.getDoc("notes/test.md");
    expect(handle).not.toBeNull();
    expect(handle!.doc).toBeDefined();
    expect(handle!.text).toBeDefined();
    expect(handle!.awareness).toBeDefined();

    sm.destroy();
  });

  it("does not send any messages before WS opens", () => {
    const sm = new SyncManager(makeSettings());
    sm.connect();

    // Register a doc while WS is still CONNECTING
    sm.getDoc("notes/test.md");

    const ws = mockWsInstances[0];
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    expect(ws.sent).toHaveLength(0);

    sm.destroy();
  });

  it("sends subscribe messages for all registered docs after WS opens", () => {
    const sm = new SyncManager(makeSettings());
    sm.connect();

    sm.getDoc("notes/a.md");
    sm.getDoc("notes/b.md");

    const ws = mockWsInstances[0];
    expect(ws.sent).toHaveLength(0);

    // Simulate the WS opening
    ws.simulateOpen();

    // Should have sent subscribe for both docs
    expect(ws.sent.length).toBeGreaterThanOrEqual(2);

    const subscribedPaths = ws.sent
      .map((buf) => decodeMuxMessage(new Uint8Array(buf)))
      .filter((msg) => msg.msgType === MUX_SUBSCRIBE)
      .map((msg) => msg.docId);

    expect(subscribedPaths).toContain("notes/a.md");
    expect(subscribedPaths).toContain("notes/b.md");

    sm.destroy();
  });

  it("local Yjs updates before WS opens are preserved in the doc", () => {
    const sm = new SyncManager(makeSettings());
    sm.connect();

    const handle = sm.getDoc("notes/test.md")!;

    // Write to the Y.Doc before WS is open
    handle.doc.transact(() => {
      handle.text.insert(0, "hello world");
    });

    // The local doc should have the content
    expect(handle.text.toString()).toBe("hello world");

    // No messages sent yet (WS still connecting)
    const ws = mockWsInstances[0];
    expect(ws.sent).toHaveLength(0);

    // After WS opens, subscribe is sent which will trigger sync protocol exchange
    ws.simulateOpen();

    const subscribedPaths = ws.sent
      .map((buf) => decodeMuxMessage(new Uint8Array(buf)))
      .filter((msg) => msg.msgType === MUX_SUBSCRIBE)
      .map((msg) => msg.docId);
    expect(subscribedPaths).toContain("notes/test.md");

    // The local content is still intact
    expect(handle.text.toString()).toBe("hello world");

    sm.destroy();
  });

  it("getDoc returns null when neither connected nor shouldConnect", () => {
    const sm = new SyncManager(makeSettings());
    // Never called connect(), so shouldConnect=false, isConnected=false
    const handle = sm.getDoc("notes/test.md");
    expect(handle).toBeNull();
  });

  it("getDoc returns null when roomId is empty", () => {
    const sm = new SyncManager(makeSettings({ roomId: "" }));
    sm.connect();
    const handle = sm.getDoc("notes/test.md");
    expect(handle).toBeNull();
    sm.destroy();
  });

  it("fires onMaxReconnect callback after max reconnect attempts", () => {
    vi.useFakeTimers();
    try {
      const sm = new SyncManager(makeSettings());
      const callback = vi.fn();
      sm.onMaxReconnect(callback);
      sm.connect();

      // First WS instance is the initial connection attempt.
      // Each iteration: close the current WS (triggering scheduleReconnect),
      // then advance timers so the reconnect fires and opens a new WS.
      // After 15 reconnect attempts, the next close triggers the max-reconnect path.
      for (let i = 0; i < 15; i++) {
        const ws = mockWsInstances[mockWsInstances.length - 1];
        ws.close();
        vi.runAllTimers();
      }

      // Close the final WS — this triggers scheduleReconnect with attempts >= 15
      const lastWs = mockWsInstances[mockWsInstances.length - 1];
      lastWs.close();

      // After exhausting reconnect attempts, the callback should have fired
      expect(callback).toHaveBeenCalledTimes(1);

      // getDoc should return null since shouldConnect is now false
      const handle = sm.getDoc("notes/test.md");
      expect(handle).toBeNull();

      sm.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
