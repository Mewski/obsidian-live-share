import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStateManager } from "../connection-state";
import type { ConnectionEvent } from "../connection-state";

describe("ConnectionStateManager", () => {
  let csm: ConnectionStateManager;

  beforeEach(() => {
    csm = new ConnectionStateManager();
  });

  describe("individual transitions", () => {
    it("has initial state of disconnected", () => {
      expect(csm.getState()).toBe("disconnected");
    });

    it("transitions to connecting on connect event", () => {
      csm.transition({ type: "connect" });
      expect(csm.getState()).toBe("connecting");
    });

    it("transitions to connected on connected event", () => {
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      expect(csm.getState()).toBe("connected");
    });

    it("transitions to disconnected on disconnect event", () => {
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.transition({ type: "disconnect" });
      expect(csm.getState()).toBe("disconnected");
    });

    it("transitions to error on error event", () => {
      csm.transition({ type: "error", message: "timeout" });
      expect(csm.getState()).toBe("error");
    });

    it("transitions to auth-required on auth-expired event", () => {
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.transition({ type: "auth-expired" });
      expect(csm.getState()).toBe("auth-required");
    });
  });

  describe("full lifecycle", () => {
    it("walks through disconnected -> connecting -> connected -> disconnected", () => {
      expect(csm.getState()).toBe("disconnected");

      csm.transition({ type: "connect" });
      expect(csm.getState()).toBe("connecting");

      csm.transition({ type: "connected" });
      expect(csm.getState()).toBe("connected");

      csm.transition({ type: "disconnect" });
      expect(csm.getState()).toBe("disconnected");
    });
  });

  describe("listeners", () => {
    it("receives state changes with correct state and event", () => {
      const listener = vi.fn();
      csm.onChange(listener);

      const event: ConnectionEvent = { type: "connect" };
      csm.transition(event);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("connecting", event);
    });

    it("is NOT called when state does not change (same transition twice)", () => {
      const listener = vi.fn();

      csm.transition({ type: "connect" });
      csm.onChange(listener);

      csm.transition({ type: "connect" });
      expect(listener).not.toHaveBeenCalled();
    });

    it("stops receiving events after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = csm.onChange(listener);

      csm.transition({ type: "connect" });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      csm.transition({ type: "connected" });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies multiple listeners", () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      csm.onChange(listenerA);
      csm.onChange(listenerB);

      csm.transition({ type: "connect" });

      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);
      expect(listenerA).toHaveBeenCalledWith("connecting", { type: "connect" });
      expect(listenerB).toHaveBeenCalledWith("connecting", { type: "connect" });
    });
  });

  describe("transitions from every state", () => {
    it("error -> connecting via connect event", () => {
      csm.transition({ type: "error", message: "fail" });
      expect(csm.getState()).toBe("error");

      csm.transition({ type: "connect" });
      expect(csm.getState()).toBe("connecting");
    });

    it("error -> disconnected via disconnect event", () => {
      csm.transition({ type: "error", message: "fail" });
      csm.transition({ type: "disconnect" });
      expect(csm.getState()).toBe("disconnected");
    });

    it("auth-required -> connecting via connect event", () => {
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.transition({ type: "auth-expired" });
      expect(csm.getState()).toBe("auth-required");

      csm.transition({ type: "connect" });
      expect(csm.getState()).toBe("connecting");
    });

    it("auth-required -> disconnected via disconnect event", () => {
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.transition({ type: "auth-expired" });

      csm.transition({ type: "disconnect" });
      expect(csm.getState()).toBe("disconnected");
    });

    it("connecting -> error via error event", () => {
      csm.transition({ type: "connect" });
      expect(csm.getState()).toBe("connecting");

      csm.transition({ type: "error", message: "refused" });
      expect(csm.getState()).toBe("error");
    });

    it("connected -> error via error event", () => {
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });

      csm.transition({ type: "error", message: "dropped" });
      expect(csm.getState()).toBe("error");
    });

    it("disconnected -> error via error event", () => {
      csm.transition({ type: "error", message: "unexpected" });
      expect(csm.getState()).toBe("error");
    });
  });

  describe("no-op transitions", () => {
    it("connecting -> connect event stays connecting (no listener fire)", () => {
      const listener = vi.fn();
      csm.transition({ type: "connect" });
      csm.onChange(listener);

      csm.transition({ type: "connect" });
      expect(csm.getState()).toBe("connecting");
      expect(listener).not.toHaveBeenCalled();
    });

    it("disconnected -> disconnect event stays disconnected (no listener fire)", () => {
      const listener = vi.fn();
      csm.onChange(listener);

      csm.transition({ type: "disconnect" });
      expect(csm.getState()).toBe("disconnected");
      expect(listener).not.toHaveBeenCalled();
    });

    it("connected -> connected event stays connected (no listener fire)", () => {
      const listener = vi.fn();
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.onChange(listener);

      csm.transition({ type: "connected" });
      expect(csm.getState()).toBe("connected");
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("rapid transitions", () => {
    it("handles many rapid transitions correctly", () => {
      const listener = vi.fn();
      csm.onChange(listener);

      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.transition({ type: "error", message: "oops" });
      csm.transition({ type: "connect" });
      csm.transition({ type: "connected" });
      csm.transition({ type: "auth-expired" });
      csm.transition({ type: "disconnect" });

      expect(csm.getState()).toBe("disconnected");
      expect(listener).toHaveBeenCalledTimes(7);
    });
  });
});
