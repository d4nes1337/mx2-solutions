import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for small secrets stored in the DB (per-user L2 CLOB
 * credentials). Lives in @mx2/core so BOTH the API (credential setup) and the
 * worker (auto-execution) can decrypt without crossing the apps/* boundary.
 * The master key is environment-only and never persisted; ciphertext carries a
 * keyVersion so keys can be rotated.
 */

const ALGORITHM = "aes-256-gcm";
const CURRENT_KEY_VERSION = 1;

export interface EncryptedCreds {
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: number;
}

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

/**
 * One-way fingerprint for correlating a secret in audit/log metadata without
 * persisting the secret itself. 12 hex chars of SHA-256 — enough to match two
 * events to the same credential, useless for recovering it.
 */
export const fingerprintSecret = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

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
