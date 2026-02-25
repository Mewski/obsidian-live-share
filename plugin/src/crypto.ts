import { arrayBufferToBase64, base64ToArrayBuffer } from "./utils";

const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 100_000;

function passphraseSaltInput(passphrase: string): string {
  return `obsidian-live-share-salt:${passphrase}`;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(passphrase);
  const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function uint8ToBase64(bytes: Uint8Array): string {
  return arrayBufferToBase64(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function base64ToUint8(base64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(base64));
}

export class E2ECrypto {
  private key: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private passphrase: string;

  constructor(passphrase: string) {
    this.passphrase = passphrase;
  }

  async init(): Promise<void> {
    const raw = new TextEncoder().encode(passphraseSaltInput(this.passphrase));
    const hashBuf = await crypto.subtle.digest("SHA-256", raw);
    this.salt = new Uint8Array(hashBuf).slice(0, SALT_BYTES);
    this.key = await deriveKey(this.passphrase, this.salt);
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error("E2E not initialised");
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.key,
      plaintext as BufferSource,
    );
    const result = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), IV_BYTES);
    return result;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error("E2E not initialised");
    const iv = data.slice(0, IV_BYTES);
    const ciphertext = data.slice(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.key, ciphertext);
    return new Uint8Array(plaintext);
  }

  async encryptString(plain: string): Promise<string> {
    const bytes = new TextEncoder().encode(plain);
    const encrypted = await this.encrypt(bytes);
    return uint8ToBase64(encrypted);
  }

  async decryptString(encoded: string): Promise<string> {
    const encrypted = base64ToUint8(encoded);
    const decrypted = await this.decrypt(encrypted);
    return new TextDecoder().decode(decrypted);
  }
}
