import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials, CryptoError } from "./crypto.js";

const VALID_KEY = "a".repeat(64); // 32 bytes, valid hex

const SAMPLE = { apiKey: "key-abc", secret: "c2VjcmV0", passphrase: "passphrase-123" };

describe("encryptCredentials / decryptCredentials", () => {
  it("round-trips data correctly", () => {
    const encrypted = encryptCredentials(SAMPLE, VALID_KEY);
    const decrypted = decryptCredentials<typeof SAMPLE>(encrypted, VALID_KEY);
    expect(decrypted).toEqual(SAMPLE);
  });

  it("produces different ciphertext each call (random IV)", () => {
    const e1 = encryptCredentials(SAMPLE, VALID_KEY);
    const e2 = encryptCredentials(SAMPLE, VALID_KEY);
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it("sets correct keyVersion", () => {
    const encrypted = encryptCredentials(SAMPLE, VALID_KEY);
    expect(encrypted.keyVersion).toBe(1);
  });

  it("throws CryptoError for wrong key on decrypt", () => {
    const encrypted = encryptCredentials(SAMPLE, VALID_KEY);
    const wrongKey = "b".repeat(64);
    expect(() => decryptCredentials(encrypted, wrongKey)).toThrowError(CryptoError);
  });

  it("throws CryptoError for invalid key format", () => {
    expect(() => encryptCredentials(SAMPLE, "tooshort")).toThrowError(CryptoError);
  });

  it("encrypts arbitrary JSON-serializable values", () => {
    const data = { nested: { x: [1, 2, 3] }, flag: true };
    const enc = encryptCredentials(data, VALID_KEY);
    const dec = decryptCredentials<typeof data>(enc, VALID_KEY);
    expect(dec.nested.x).toEqual([1, 2, 3]);
    expect(dec.flag).toBe(true);
  });
});
