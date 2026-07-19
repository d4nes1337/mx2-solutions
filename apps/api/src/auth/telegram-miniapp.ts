import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Telegram Mini App initData verification (https://core.telegram.org/bots/webapps).
 * The webview hands the page a signed query string; the server proves it came
 * from Telegram by recomputing HMAC-SHA256 over the data-check string with
 * secret_key = HMAC_SHA256(bot_token, key="WebAppData"), and rejects stale
 * auth_date values (replay window).
 */

export const INIT_DATA_MAX_AGE_SECONDS = 5 * 60;

export interface VerifiedInitData {
  /** Telegram user id (private-chat id === user id). */
  userId: string;
  username: string | null;
  authDate: number;
}

export const verifyTelegramInitData = (
  initData: string,
  botToken: string,
  nowMs = Date.now(),
): VerifiedInitData | null => {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken, "utf8").digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return null;
  if (nowMs / 1000 - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as { id?: number | string; username?: string };
    if (user.id === undefined || user.id === null) return null;
    return {
      userId: String(user.id),
      username: typeof user.username === "string" ? user.username : null,
      authDate,
    };
  } catch {
    return null;
  }
};
