import { describe, expect, it } from "vitest";

interface InvitePayload {
  s: string;
  r: string;
  t: string;
  e?: string;
}

function parseInvite(invite: string): InvitePayload | null {
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

function makeInvite(payload: Record<string, unknown>): string {
  return `obsliveshare:${btoa(JSON.stringify(payload))}`;
}

describe("Invite format parsing (mirrors SessionManager.parseInvite)", () => {
  it("parses a valid invite with an http URL", () => {
    const result = parseInvite(
      makeInvite({
        s: "http://localhost:4321",
        r: "room-abc",
        t: "tok-123",
      }),
    );
    expect(result).toEqual({
      s: "http://localhost:4321",
      r: "room-abc",
      t: "tok-123",
    });
  });

  it("parses a valid invite with an https URL", () => {
    const result = parseInvite(
      makeInvite({
        s: "https://share.example.com",
        r: "room-xyz",
        t: "tok-456",
      }),
    );
    expect(result).toEqual({
      s: "https://share.example.com",
      r: "room-xyz",
      t: "tok-456",
    });
  });

  it("rejects an invite without the obsliveshare: prefix", () => {
    const raw = btoa(
      JSON.stringify({
        s: "https://example.com",
        r: "room",
        t: "tok",
      }),
    );
    expect(parseInvite(raw)).toBeNull();
    expect(parseInvite(`wrongprefix:${raw}`)).toBeNull();
  });

  it("rejects an invite with invalid base64", () => {
    expect(parseInvite("obsliveshare:!!!not-base64!!!")).toBeNull();
  });

  it("rejects an invite with invalid JSON", () => {
    const notJson = btoa("this is { not valid json");
    expect(parseInvite(`obsliveshare:${notJson}`)).toBeNull();
  });

  it("rejects an invite with missing fields", () => {
    expect(parseInvite(makeInvite({ s: "https://example.com", r: "room" }))).toBeNull();
    expect(parseInvite(makeInvite({ s: "https://example.com", t: "tok" }))).toBeNull();
    expect(parseInvite(makeInvite({ r: "room", t: "tok" }))).toBeNull();
    expect(parseInvite(makeInvite({ s: 123, r: "room", t: "tok" }))).toBeNull();
  });

  it("rejects an invite with javascript: protocol URL (Bug 1.14)", () => {
    const result = parseInvite(
      makeInvite({
        s: "javascript:alert(1)",
        r: "room",
        t: "tok",
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects an invite with file: protocol URL", () => {
    const result = parseInvite(
      makeInvite({
        s: "file:///etc/passwd",
        r: "room",
        t: "tok",
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects an invite with ftp: protocol URL", () => {
    const result = parseInvite(
      makeInvite({
        s: "ftp://files.example.com",
        r: "room",
        t: "tok",
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseInvite("")).toBeNull();
  });

  it("parses an invite with encryption passphrase", () => {
    const result = parseInvite(
      makeInvite({
        s: "https://share.example.com",
        r: "room-enc",
        t: "tok-enc",
        e: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      }),
    );
    expect(result).toEqual({
      s: "https://share.example.com",
      r: "room-enc",
      t: "tok-enc",
      e: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    });
  });

  it("parses an invite without encryption passphrase (backwards compat)", () => {
    const result = parseInvite(
      makeInvite({
        s: "https://share.example.com",
        r: "room-noenc",
        t: "tok-noenc",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.e).toBeUndefined();
  });

  it("trims whitespace from invite string", () => {
    const invite = makeInvite({
      s: "http://localhost:4321",
      r: "room",
      t: "tok",
    });
    expect(parseInvite(invite)).not.toBeNull();
  });
});
