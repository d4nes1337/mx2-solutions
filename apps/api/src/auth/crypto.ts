import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import type { EncryptedCreds } from "@mx2/db";

const ALGORITHM = "aes-256-gcm";
const CURRENT_KEY_VERSION = 1;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

const parseKey = (keyHex: string): Buffer => {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new CryptoError("Encryption key must be 64-char hex (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
};

export const encryptCredentials = (data: unknown, keyHex: string): EncryptedCreds => {
  const key = parseKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
    keyVersion: CURRENT_KEY_VERSION,
  };
};

export const decryptCredentials = <T>(encrypted: EncryptedCreds, keyHex: string): T => {
  const key = parseKey(keyHex);
  const iv = Buffer.from(encrypted.iv, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new CryptoError("Failed to decrypt credentials — wrong key or corrupted data");
  }
};
