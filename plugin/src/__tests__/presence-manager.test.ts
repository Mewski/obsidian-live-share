import { describe, expect, it, vi } from "vitest";

import { type PresenceContext, PresenceManager } from "../session/presence-manager";
import type { PresenceUser } from "../session/presence-view";

function user(scrollTop: number): PresenceUser {
  return {
    userId: "host",
    displayName: "Host",
    cursorColor: "#3366cc",
    currentFile: "notes/shared.md",
    scrollTop,
  };
}

function createManager(openFileAndScroll: PresenceContext["openFileAndScroll"]): {
  manager: PresenceManager;
  users: Map<string, PresenceUser>;
} {
  const users = new Map<string, PresenceUser>();
  const context: PresenceContext = {
    getUserId: () => "guest",
    getDisplayName: () => "Guest",
    getAvatarUrl: () => "",
    getCursorColor: () => "#cc6633",
    getRole: () => "guest",
    getCurrentFile: () => "",
    getScrollTop: () => 0,
    getCursorLine: () => 0,
    getControlChannel: () => null,
    getRemoteUsers: () => users,
    notify: vi.fn(),
    openFileAndScroll,
    refreshPresenceView: vi.fn(),
    updateStatusBar: vi.fn(),
    onActiveFileChange: vi.fn(),
  };
  return { manager: new PresenceManager(context), users };
}

describe("PresenceManager follow state", () => {
  it("applies the latest presence update after navigation finishes", async () => {
    let navigationFinished = false;
    const firstNavigation = vi
      .waitUntil(() => navigationFinished, { interval: 1, timeout: 100 })
      .then(() => undefined);
    const openFileAndScroll = vi
      .fn<PresenceContext["openFileAndScroll"]>()
      .mockImplementationOnce(() => firstNavigation)
      .mockResolvedValue(undefined);
    const { manager, users } = createManager(openFileAndScroll);
    users.set("host", user(10));

    manager.handlePresentStart("host");
    manager.handlePresenceUpdate(user(200));

    expect(openFileAndScroll).toHaveBeenCalledTimes(1);
    navigationFinished = true;
    await firstNavigation;

    await vi.waitFor(() => expect(openFileAndScroll).toHaveBeenCalledTimes(2));
    expect(openFileAndScroll).toHaveBeenLastCalledWith("notes/shared.md", 200);
  });

  it("discards queued follow state after presentation stops", async () => {
    let navigationFinished = false;
    const firstNavigation = vi
      .waitUntil(() => navigationFinished, { interval: 1, timeout: 100 })
      .then(() => undefined);
    const openFileAndScroll = vi
      .fn<PresenceContext["openFileAndScroll"]>()
      .mockImplementationOnce(() => firstNavigation)
      .mockResolvedValue(undefined);
    const { manager, users } = createManager(openFileAndScroll);
    users.set("host", user(10));

    manager.handlePresentStart("host");
    manager.handlePresenceUpdate(user(200));
    manager.handlePresentStop("host");
    navigationFinished = true;
    await firstNavigation;
    await Promise.resolve();

    expect(openFileAndScroll).toHaveBeenCalledTimes(1);
  });
});
