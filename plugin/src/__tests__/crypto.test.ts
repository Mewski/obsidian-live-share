import { describe, expect, it } from "vitest";
import { E2ECrypto } from "../crypto";

describe("E2ECrypto", () => {
  it("is not enabled before init()", () => {
    const e2e = new E2ECrypto("test-passphrase");
    expect(e2e.enabled).toBe(false);
  });

  it("is enabled after init()", async () => {
    const e2e = new E2ECrypto("test-passphrase");
    await e2e.init();
    expect(e2e.enabled).toBe(true);
  });

  it("encrypts and decrypts a Uint8Array round-trip", async () => {
    const e2e = new E2ECrypto("round-trip-test");
    await e2e.init();

    const plaintext = new TextEncoder().encode("Hello, Live Share!");
    const encrypted = await e2e.encrypt(plaintext);

    // Encrypted output should differ from plaintext
    expect(encrypted).not.toEqual(plaintext);
    // Should be longer (IV prepended)
    expect(encrypted.byteLength).toBeGreaterThan(plaintext.byteLength);

    const decrypted = await e2e.decrypt(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("encrypts and decrypts a string round-trip", async () => {
    const e2e = new E2ECrypto("string-round-trip");
    await e2e.init();

    const original = "# My Secret Note\n\nThis is private content.";
    const encrypted = await e2e.encryptString(original);

    // Encrypted is a base64 string, not the original
    expect(encrypted).not.toBe(original);
    expect(typeof encrypted).toBe("string");

    const decrypted = await e2e.decryptString(encrypted);
    expect(decrypted).toBe(original);
  });

  it("two instances with the same passphrase can decrypt each other's data", async () => {
    const alice = new E2ECrypto("shared-secret");
    const bob = new E2ECrypto("shared-secret");
    await alice.init();
    await bob.init();

    const message = "Message from Alice to Bob";
    const encrypted = await alice.encryptString(message);
    const decrypted = await bob.decryptString(encrypted);
    expect(decrypted).toBe(message);
  });

  it("different passphrases cannot decrypt each other's data", async () => {
    const alice = new E2ECrypto("passphrase-a");
    const eve = new E2ECrypto("passphrase-b");
    await alice.init();
    await eve.init();

    const encrypted = await alice.encryptString("secret");
    await expect(eve.decryptString(encrypted)).rejects.toThrow();
  });

  it("throws if encrypt is called before init", async () => {
    const e2e = new E2ECrypto("not-initialized");
    const data = new TextEncoder().encode("test");
    await expect(e2e.encrypt(data)).rejects.toThrow("E2E not initialised");
  });

  it("throws if decrypt is called before init", async () => {
    const e2e = new E2ECrypto("not-initialized");
    const data = new Uint8Array(32);
    await expect(e2e.decrypt(data)).rejects.toThrow("E2E not initialised");
  });

  it("handles empty string encryption", async () => {
    const e2e = new E2ECrypto("empty-test");
    await e2e.init();

    const encrypted = await e2e.encryptString("");
    const decrypted = await e2e.decryptString(encrypted);
    expect(decrypted).toBe("");
  });

  it("handles unicode content", async () => {
    const e2e = new E2ECrypto("unicode-test");
    await e2e.init();

    const unicode = "Hello \u{1F30D} \u00E9\u00E8\u00EA \u4F60\u597D \u{1F600}";
    const encrypted = await e2e.encryptString(unicode);
    const decrypted = await e2e.decryptString(encrypted);
    expect(decrypted).toBe(unicode);
  });

  it("produces different ciphertext for the same plaintext (random IV)", async () => {
    const e2e = new E2ECrypto("iv-test");
    await e2e.init();

    const plaintext = "same message";
    const enc1 = await e2e.encryptString(plaintext);
    const enc2 = await e2e.encryptString(plaintext);

    // Two encryptions of the same plaintext should produce different ciphertext
    expect(enc1).not.toBe(enc2);

    // But both decrypt to the same value
    expect(await e2e.decryptString(enc1)).toBe(plaintext);
    expect(await e2e.decryptString(enc2)).toBe(plaintext);
  });
});
