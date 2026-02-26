import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugLogger } from "../debug-logger";

function mockVault() {
  return {
    adapter: {
      append: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

describe("DebugLogger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes nothing when disabled", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", false);
    logger.log("test", "hello");
    vi.advanceTimersByTime(1000);
    expect(vault.adapter.append).not.toHaveBeenCalled();
    logger.destroy();
  });

  it("batches writes with debounce", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", true);
    logger.log("cat1", "msg1");
    logger.log("cat2", "msg2");
    expect(vault.adapter.append).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(vault.adapter.append).toHaveBeenCalledTimes(1);
    const written = vault.adapter.append.mock.calls[0][1] as string;
    expect(written).toContain("[INFO] [cat1] msg1");
    expect(written).toContain("[INFO] [cat2] msg2");
    logger.destroy();
  });

  it("formats error messages with Error objects", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", true);
    logger.error("net", "connection failed", new Error("timeout"));
    vi.advanceTimersByTime(500);
    const written = vault.adapter.append.mock.calls[0][1] as string;
    expect(written).toContain("[ERROR] [net] connection failed: timeout");
    logger.destroy();
  });

  it("formats error messages with string errors", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", true);
    logger.error("net", "connection failed", "some reason");
    vi.advanceTimersByTime(500);
    const written = vault.adapter.append.mock.calls[0][1] as string;
    expect(written).toContain("[ERROR] [net] connection failed: some reason");
    logger.destroy();
  });

  it("formats error messages without error arg", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", true);
    logger.error("net", "connection failed");
    vi.advanceTimersByTime(500);
    const written = vault.adapter.append.mock.calls[0][1] as string;
    expect(written).toContain("[ERROR] [net] connection failed");
    expect(written).not.toContain("connection failed:");
    logger.destroy();
  });

  it("destroy() flushes remaining buffer", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", true);
    logger.log("test", "pending");
    expect(vault.adapter.append).not.toHaveBeenCalled();
    logger.destroy();
    expect(vault.adapter.append).toHaveBeenCalledTimes(1);
    const written = vault.adapter.append.mock.calls[0][1] as string;
    expect(written).toContain("[INFO] [test] pending");
  });

  it("updateSettings toggles enabled state", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", false);
    logger.log("test", "should not write");
    vi.advanceTimersByTime(500);
    expect(vault.adapter.append).not.toHaveBeenCalled();

    logger.updateSettings(true, "new-path.md");
    logger.log("test", "should write");
    vi.advanceTimersByTime(500);
    expect(vault.adapter.append).toHaveBeenCalledTimes(1);
    expect(vault.adapter.append.mock.calls[0][0]).toBe("new-path.md");
    logger.destroy();
  });

  it("includes ISO timestamp in log lines", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "debug.md", true);
    logger.log("test", "hello");
    vi.advanceTimersByTime(500);
    const written = vault.adapter.append.mock.calls[0][1] as string;
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    logger.destroy();
  });

  it("writes to configured path", () => {
    const vault = mockVault();
    const logger = new DebugLogger(vault, "custom/path.md", true);
    logger.log("test", "hello");
    vi.advanceTimersByTime(500);
    expect(vault.adapter.append.mock.calls[0][0]).toBe("custom/path.md");
    logger.destroy();
  });
});
