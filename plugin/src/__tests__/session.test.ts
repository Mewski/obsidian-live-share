import { describe, it, expect } from "vitest";

/**
 * The SessionManager.parseInvite() method is private, so we replicate its
 * validation logic here to unit-test the invite format independently of any
 * network calls. The format is:
 *
 *   obsliveshare:{base64(JSON.stringify({ s: serverUrl, r: roomId, t: token }))}
 *
 * Validation rules (from session.ts):
 *   - Must start with "obsliveshare:"
 *   - Base64 payload must decode to valid JSON
 *   - JSON must contain string fields `s`, `r`, `t`
 *   - `s` must be a valid URL with http: or https: protocol (Bug 1.14 fix)
 */

interface InvitePayload {
  s: string;
  r: string;
  t: string;
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
    // Missing `t`
    expect(
      parseInvite(makeInvite({ s: "https://example.com", r: "room" })),
    ).toBeNull();

    // Missing `r`
    expect(
      parseInvite(makeInvite({ s: "https://example.com", t: "tok" })),
    ).toBeNull();

    // Missing `s`
    expect(parseInvite(makeInvite({ r: "room", t: "tok" }))).toBeNull();

    // Fields present but wrong type (number instead of string)
    expect(
      parseInvite(makeInvite({ s: 123, r: "room", t: "tok" })),
    ).toBeNull();
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
});
