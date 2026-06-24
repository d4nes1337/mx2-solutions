import { createHmac } from "crypto";

/** Decode Polymarket API secret (standard or URL-safe base64). */
const decodeBase64Secret = (secret: string): Buffer => {
  const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
};

export interface L2HeaderArgs {
  method: string;
  requestPath: string;
  body?: string;
}

/**
 * Canonical Polymarket CLOB L2 HMAC (matches @polymarket/clob-client buildPolyHmacSignature).
 * message = timestamp + method + requestPath + body?
 */
export const buildPolyHmacSignature = (
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): string => {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined) message += body;
  const hmac = createHmac("sha256", decodeBase64Secret(secret)).update(message).digest("base64");
  return hmac.replace(/\+/g, "-").replace(/\//g, "_");
};

export const buildL2Headers = (
  address: string,
  creds: { apiKey: string; secret: string; passphrase: string },
  timestamp: number,
  args: L2HeaderArgs,
): Record<string, string> => ({
  POLY_ADDRESS: address,
  POLY_SIGNATURE: buildPolyHmacSignature(
    creds.secret,
    timestamp,
    args.method,
    args.requestPath,
    args.body,
  ),
  POLY_TIMESTAMP: String(timestamp),
  POLY_API_KEY: creds.apiKey,
  POLY_PASSPHRASE: creds.passphrase,
});
