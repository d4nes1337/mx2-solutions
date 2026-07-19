import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INIT_DATA_MAX_AGE_SECONDS, verifyTelegramInitData } from "./telegram-miniapp.js";

const BOT_TOKEN = "12345:test-bot-token";

/** Reference implementation of Telegram's signing side (spec mirror). */
const signInitData = (fields: Record<string, string>, botToken: string): string => {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  pairs.sort();
  const secretKey = createHmac("sha256", "WebAppData").update(botToken, "utf8").digest();
  const hash = createHmac("sha256", secretKey).update(pairs.join("\n"), "utf8").digest("hex");
  const qs = new URLSearchParams(fields);
  qs.set("hash", hash);
  return qs.toString();
};

const NOW = 1_784_500_000_000;
const freshFields = () => ({
  auth_date: String(Math.floor(NOW / 1000) - 30),
  query_id: "AAF9tW1TAAAAAH21bVN4x1Ql",
  user: JSON.stringify({ id: 424242, first_name: "Alice", username: "alice" }),
});

describe("verifyTelegramInitData", () => {
  it("accepts a correctly signed, fresh initData and extracts the user", () => {
    const initData = signInitData(freshFields(), BOT_TOKEN);
    const verified = verifyTelegramInitData(initData, BOT_TOKEN, NOW);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe("424242");
    expect(verified!.username).toBe("alice");
  });

  it("rejects a signature made with a different bot token", () => {
    const initData = signInitData(freshFields(), "999:other-token");
    expect(verifyTelegramInitData(initData, BOT_TOKEN, NOW)).toBeNull();
  });

  it("rejects tampered fields (user swapped after signing)", () => {
    const initData = signInitData(freshFields(), BOT_TOKEN);
    const params = new URLSearchParams(initData);
    params.set("user", JSON.stringify({ id: 666, username: "mallory" }));
    expect(verifyTelegramInitData(params.toString(), BOT_TOKEN, NOW)).toBeNull();
  });

  it("rejects stale auth_date (replay window)", () => {
    const fields = freshFields();
    fields.auth_date = String(Math.floor(NOW / 1000) - INIT_DATA_MAX_AGE_SECONDS - 10);
    const initData = signInitData(fields, BOT_TOKEN);
    expect(verifyTelegramInitData(initData, BOT_TOKEN, NOW)).toBeNull();
  });

  it("rejects garbage and missing-hash inputs", () => {
    expect(verifyTelegramInitData("", BOT_TOKEN, NOW)).toBeNull();
    expect(verifyTelegramInitData("hash=zz", BOT_TOKEN, NOW)).toBeNull();
    expect(verifyTelegramInitData("auth_date=1&user=%7B%7D", BOT_TOKEN, NOW)).toBeNull();
  });
});
