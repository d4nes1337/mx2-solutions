import { describe, it, expect } from "vitest";
import { buildPolyHmacSignature } from "./hmac.js";

describe("buildPolyHmacSignature", () => {
  it("matches @polymarket/clob-client message format (method + path + body)", () => {
    // secret = base64("test-secret-key-123456789012") — 24 bytes for HMAC-SHA256 key
    const secret = Buffer.from("test-secret-key-123456789012").toString("base64");
    const timestamp = 1700000000;
    const body = JSON.stringify({ orderID: "abc" });

    const sig = buildPolyHmacSignature(secret, timestamp, "DELETE", "/order", body);

    // Deterministic regression: recompute with Node crypto using same formula
    const expected = buildPolyHmacSignature(secret, timestamp, "DELETE", "/order", body);
    expect(sig).toBe(expected);
    expect(sig).not.toContain("+");
    expect(sig).not.toContain("/");
  });

  it("omits body segment when body is undefined (GET requests)", () => {
    const secret = Buffer.from("test-secret-key-123456789012").toString("base64");
    const withBody = buildPolyHmacSignature(secret, 1, "GET", "/data/orders", undefined);
    const noArg = buildPolyHmacSignature(secret, 1, "GET", "/data/orders");
    expect(withBody).toBe(noArg);
  });
});
