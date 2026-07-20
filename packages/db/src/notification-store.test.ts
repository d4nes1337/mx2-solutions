import { describe, expect, it } from "vitest";
import {
  MAX_SEND_ATTEMPTS,
  NOTIFICATION_KINDS,
  isKindEnabled,
  nextRetryDelayMs,
} from "./notification-store.js";

// Preferences are default-ON (owner decision): a channel notifies about every
// kind unless the user explicitly opted a kind out.
describe("isKindEnabled", () => {
  it("defaults to enabled for an empty preferences map", () => {
    expect(isKindEnabled({}, "order_awaiting_signature")).toBe(true);
  });

  it("defaults to enabled when preferences are malformed", () => {
    expect(isKindEnabled(null, "rule_alert")).toBe(true);
    expect(isKindEnabled(undefined, "rule_alert")).toBe(true);
    expect(isKindEnabled("garbage", "rule_alert")).toBe(true);
  });

  it("only an explicit false opts out", () => {
    expect(isKindEnabled({ order_filled: false }, "order_filled")).toBe(false);
    expect(isKindEnabled({ order_filled: false }, "rule_alert")).toBe(true);
    expect(isKindEnabled({ order_filled: true }, "order_filled")).toBe(true);
  });
});

describe("nextRetryDelayMs", () => {
  it("grows exponentially from 5s", () => {
    expect(nextRetryDelayMs(1)).toBe(5_000);
    expect(nextRetryDelayMs(2)).toBe(15_000);
    expect(nextRetryDelayMs(3)).toBe(45_000);
  });

  it("caps at 15 minutes", () => {
    expect(nextRetryDelayMs(10)).toBe(15 * 60_000);
  });

  it("tolerates zero/negative attempt counts", () => {
    expect(nextRetryDelayMs(0)).toBe(5_000);
    expect(nextRetryDelayMs(-1)).toBe(5_000);
  });
});

describe("notification kinds", () => {
  it("covers the owner-approved event set", () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([
      // auto_retry_abandoned added with the funds-arrival retry (2026-07 fix
      // plan): the user must hear when an auto-execution gives up waiting.
      "auto_retry_abandoned",
      "deposit_completed",
      "order_auto_executed",
      "order_awaiting_signature",
      "order_filled",
      "rule_alert",
      "withdrawal_completed",
    ]);
  });

  it("gives up after a bounded number of attempts", () => {
    expect(MAX_SEND_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_SEND_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
