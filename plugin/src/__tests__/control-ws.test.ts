import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlChannel, ControlMessage } from "../control-ws";
import type { LiveShareSettings } from "../types";

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: string | ArrayBuffer) {
    this.onmessage?.({ data } as any);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

const { ControlChannel: CC } = await import("../control-ws");

function createSettings(
  overrides?: Partial<LiveShareSettings>,
): LiveShareSettings {
  return {
    serverUrl: "http://localhost:4321",
    roomId: "test-room",
    token: "tok123",
    jwt: "",
    githubUserId: "u1",
    avatarUrl: "",
    displayName: "Tester",
    cursorColor: "#000",
    sharedFolder: "shared",
    role: "host",
    encryptionPassphrase: "",
    ...overrides,
  };
}

function createMockE2E() {
  return {
    enabled: true,
    encryptString: vi.fn(async (s: string) => `encrypted:${s}`),
    decryptString: vi.fn(async (s: string) => s.replace("encrypted:", "")),
  };
}

function connectAndGetWs(channel: ControlChannel): MockWebSocket {
  channel.connect();
  return (channel as any).ws as MockWebSocket;
}

describe("ControlChannel", () => {
  let channel: ControlChannel;

  afterEach(() => {
    channel?.destroy();
    vi.restoreAllMocks();
  });

  describe("message dispatch", () => {
    beforeEach(() => {
      channel = new CC(createSettings());
    });

    it("dispatches messages to registered handlers by type", () => {
      const handler = vi.fn();
      channel.on("file-op", handler);

      const ws = connectAndGetWs(channel);
      const msg: ControlMessage = {
        type: "file-op",
        op: { type: "create", path: "a.md", content: "hi" },
      };
      ws.simulateMessage(JSON.stringify(msg));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("does not dispatch to handlers after off()", () => {
      const handler = vi.fn();
      channel.on("file-op", handler);
      channel.off("file-op", handler);

      const ws = connectAndGetWs(channel);
      ws.simulateMessage(JSON.stringify({ type: "file-op" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores binary (non-string) message data", () => {
      const handler = vi.fn();
      channel.on("file-op", handler);

      const ws = connectAndGetWs(channel);
      ws.simulateMessage(new ArrayBuffer(8));

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores malformed JSON messages", () => {
      const handler = vi.fn();
      channel.on("file-op", handler);

      const ws = connectAndGetWs(channel);
      ws.simulateMessage("{not valid json!!!");

      expect(handler).not.toHaveBeenCalled();
    });

    it("dispatches multiple handler types independently", () => {
      const fileOpHandler = vi.fn();
      const presenceHandler = vi.fn();
      channel.on("file-op", fileOpHandler);
      channel.on("presence-update", presenceHandler);

      const ws = connectAndGetWs(channel);
      ws.simulateMessage(JSON.stringify({ type: "file-op", path: "a.md" }));
      ws.simulateMessage(
        JSON.stringify({ type: "presence-update", userId: "u1" }),
      );

      expect(fileOpHandler).toHaveBeenCalledOnce();
      expect(presenceHandler).toHaveBeenCalledOnce();
    });

    it("dispatches to multiple handlers for the same type", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      channel.on("file-op", h1);
      channel.on("file-op", h2);

      const ws = connectAndGetWs(channel);
      ws.simulateMessage(JSON.stringify({ type: "file-op" }));

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it("does not dispatch for message types with no handlers", () => {
      const handler = vi.fn();
      channel.on("file-op", handler);

      const ws = connectAndGetWs(channel);
      ws.simulateMessage(JSON.stringify({ type: "presence-update" }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("send", () => {
    beforeEach(() => {
      channel = new CC(createSettings());
    });

    it("sends JSON-stringified messages when WebSocket is open", () => {
      const ws = connectAndGetWs(channel);
      ws.readyState = MockWebSocket.OPEN;

      const msg: ControlMessage = { type: "presence-update", name: "Alice" };
      channel.send(msg);

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0])).toEqual(msg);
    });

    it("does not send when WebSocket is not open", () => {
      const ws = connectAndGetWs(channel);
      ws.readyState = MockWebSocket.CLOSED;

      channel.send({ type: "presence-update" });

      expect(ws.sent).toHaveLength(0);
    });

    it("does not send when ws is null", () => {
      channel = new CC(createSettings());
      channel.send({ type: "presence-update" });
    });
  });

  describe("E2E encryption", () => {
    it("encrypts file-op content before sending", async () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const ws = connectAndGetWs(channel);

      channel.send({
        type: "file-op",
        op: { type: "create", path: "a.md", content: "hello" },
      });

      await vi.waitFor(() => expect(ws.sent.length).toBe(1));

      const sent = JSON.parse(ws.sent[0]);
      expect(sent.encrypted).toBe(true);
      expect(sent.op.content).toBe("encrypted:hello");
      expect(e2e.encryptString).toHaveBeenCalledWith("hello");
    });

    it("does not encrypt non-encryptable message types", () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const ws = connectAndGetWs(channel);

      channel.send({ type: "presence-update", name: "Bob" });

      expect(ws.sent).toHaveLength(1);
      const sent = JSON.parse(ws.sent[0]);
      expect(sent.encrypted).toBeUndefined();
      expect(e2e.encryptString).not.toHaveBeenCalled();
    });

    it("decrypts incoming encrypted messages and dispatches", async () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const handler = vi.fn();
      channel.on("file-op", handler);

      const ws = connectAndGetWs(channel);

      ws.simulateMessage(
        JSON.stringify({
          type: "file-op",
          encrypted: true,
          op: { type: "create", path: "b.md", content: "encrypted:secret" },
        }),
      );

      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      const dispatched = handler.mock.calls[0][0];
      expect(dispatched.op.content).toBe("secret");
      expect(dispatched.encrypted).toBeUndefined();
    });

    it("handles decryption failure gracefully (logs warning)", async () => {
      const e2e = createMockE2E();
      e2e.decryptString.mockRejectedValue(new Error("bad key"));
      channel = new CC(createSettings(), e2e as any);

      const handler = vi.fn();
      channel.on("file-op", handler);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ws = connectAndGetWs(channel);

      ws.simulateMessage(
        JSON.stringify({
          type: "file-op",
          encrypted: true,
          op: { type: "create", path: "c.md", content: "garbage" },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(handler).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "Live Share: failed to decrypt control message",
      );

      warnSpy.mockRestore();
    });

    it("passes through delete ops without encrypting content", async () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const ws = connectAndGetWs(channel);

      channel.send({
        type: "file-op",
        op: { type: "delete", path: "old.md" },
      });

      await vi.waitFor(() => expect(ws.sent.length).toBe(1));

      const sent = JSON.parse(ws.sent[0]);
      expect(sent.op.type).toBe("delete");
      expect(sent.encrypted).toBeUndefined();
      expect(e2e.encryptString).not.toHaveBeenCalled();
    });

    it("encrypts file-chunk-data content before sending", async () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const ws = connectAndGetWs(channel);

      channel.send({
        type: "file-chunk-data",
        path: "big.bin",
        index: 0,
        data: "chunk-content",
      });

      await vi.waitFor(() => expect(ws.sent.length).toBe(1));

      const sent = JSON.parse(ws.sent[0]);
      expect(sent.encrypted).toBe(true);
      expect(sent.data).toBe("encrypted:chunk-content");
      expect(e2e.encryptString).toHaveBeenCalledWith("chunk-content");
    });

    it("decrypts incoming encrypted file-chunk-data and dispatches", async () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const handler = vi.fn();
      channel.on("file-chunk-data", handler);

      const ws = connectAndGetWs(channel);

      ws.simulateMessage(
        JSON.stringify({
          type: "file-chunk-data",
          encrypted: true,
          path: "big.bin",
          index: 0,
          data: "encrypted:secret-chunk",
        }),
      );

      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      const dispatched = handler.mock.calls[0][0];
      expect(dispatched.data).toBe("secret-chunk");
      expect(dispatched.encrypted).toBeUndefined();
    });

    it("does not encrypt file-chunk-start (not in encryptable list)", () => {
      const e2e = createMockE2E();
      channel = new CC(createSettings(), e2e as any);
      const ws = connectAndGetWs(channel);

      channel.send({
        type: "file-chunk-start",
        path: "big.bin",
        totalSize: 1000,
      });

      expect(ws.sent).toHaveLength(1);
      const sent = JSON.parse(ws.sent[0]);
      expect(sent.encrypted).toBeUndefined();
      expect(e2e.encryptString).not.toHaveBeenCalled();
    });

    it("drops message when encryption fails instead of sending plaintext", async () => {
      const e2e = createMockE2E();
      e2e.encryptString.mockRejectedValue(new Error("crypto error"));
      channel = new CC(createSettings(), e2e as any);
      const ws = connectAndGetWs(channel);

      channel.send({
        type: "file-op",
        op: { type: "create", path: "a.md", content: "hello" },
      });

      // Give the async encryptAndSend time to settle
      await new Promise((r) => setTimeout(r, 50));
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("reports connected state on open", async () => {
      channel = new CC(createSettings());
      const stateCallback = vi.fn();
      channel.onStateChange(stateCallback);

      connectAndGetWs(channel);

      await vi.waitFor(() =>
        expect(stateCallback).toHaveBeenCalledWith("connected"),
      );
    });

    it("cleans up on destroy", () => {
      channel = new CC(createSettings());
      const stateCallback = vi.fn();
      channel.onStateChange(stateCallback);

      const ws = connectAndGetWs(channel);
      channel.destroy();

      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      expect(stateCallback).toHaveBeenCalledWith("disconnected");
      expect((channel as any).ws).toBeNull();
    });

    it("does not reconnect after destroy", () => {
      channel = new CC(createSettings());
      const ws = connectAndGetWs(channel);
      channel.destroy();

      channel.connect();

      expect((channel as any).ws).toBeNull();
    });

    it("clears handlers on destroy", () => {
      channel = new CC(createSettings());
      const handler = vi.fn();
      channel.on("file-op", handler);

      channel.destroy();

      expect((channel as any).handlers.size).toBe(0);
    });
  });

  describe("reconnection scheduling", () => {
    it("schedules reconnect on close when not destroyed", () => {
      vi.useFakeTimers();
      channel = new CC(createSettings());
      const ws = connectAndGetWs(channel);
      ws.onopen?.();

      const stateCallback = vi.fn();
      channel.onStateChange(stateCallback);

      ws.readyState = MockWebSocket.CLOSED;
      ws.onclose?.();

      expect(stateCallback).toHaveBeenCalledWith("reconnecting");
      expect((channel as any).reconnectTimer).not.toBeNull();
      expect((channel as any).reconnectAttempt).toBe(1);

      vi.useRealTimers();
    });

    it("does not double-schedule reconnect if timer already set", () => {
      vi.useFakeTimers();
      channel = new CC(createSettings());
      const ws = connectAndGetWs(channel);
      ws.onopen?.();

      ws.readyState = MockWebSocket.CLOSED;
      ws.onclose?.();

      const timer1 = (channel as any).reconnectTimer;
      ws.onclose?.();
      const timer2 = (channel as any).reconnectTimer;

      expect(timer1).toBe(timer2);

      vi.useRealTimers();
    });

    it("resets reconnect delay on successful connection", () => {
      vi.useFakeTimers();
      channel = new CC(createSettings());
      const ws = connectAndGetWs(channel);
      ws.onopen?.();

      ws.readyState = MockWebSocket.CLOSED;
      ws.onclose?.();

      vi.advanceTimersByTime(1500);

      const ws2 = (channel as any).ws as MockWebSocket;
      ws2.onopen?.();

      expect((channel as any).reconnectDelay).toBe(1000);
      expect((channel as any).reconnectAttempt).toBe(0);

      vi.useRealTimers();
    });

    it("does not schedule reconnect if destroyed", () => {
      channel = new CC(createSettings());
      const ws = connectAndGetWs(channel);

      channel.destroy();

      expect((channel as any).reconnectTimer).toBeNull();
    });
  });

  describe("updateSettings", () => {
    it("updates the internal settings reference", () => {
      channel = new CC(createSettings());
      const newSettings = createSettings({ displayName: "Updated" });
      channel.updateSettings(newSettings);
      expect((channel as any).settings.displayName).toBe("Updated");
    });
  });

  describe("URL construction", () => {
    it("constructs WebSocket URL with room and token", () => {
      channel = new CC(
        createSettings({
          serverUrl: "http://example.com",
          roomId: "room1",
          token: "tok",
        }),
      );
      const ws = connectAndGetWs(channel);
      expect(ws.url).toContain("/control/room1");
      expect(ws.url).toContain("token=tok");
    });

    it("includes jwt parameter when set", () => {
      channel = new CC(createSettings({ jwt: "my-jwt-token" }));
      const ws = connectAndGetWs(channel);
      expect(ws.url).toContain("jwt=my-jwt-token");
    });

    it("does not include jwt parameter when empty", () => {
      channel = new CC(createSettings({ jwt: "" }));
      const ws = connectAndGetWs(channel);
      expect(ws.url).not.toContain("jwt=");
    });
  });
});
