import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "./result.js";
import { toWalletAddress } from "./ids.js";
import { fingerprintSecret } from "./crypto.js";

describe("Result", () => {
  it("narrows ok/err", () => {
    const good = ok(42);
    const bad = err("nope");
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(42);
    if (isErr(bad)) expect(bad.error).toBe("nope");
  });
});

describe("toWalletAddress", () => {
  it("lowercases a valid address", () => {
    expect(toWalletAddress("0xABCDEF0123456789ABCDEF0123456789ABCDEF01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("rejects invalid addresses", () => {
    expect(() => toWalletAddress("not-an-address")).toThrow();
    expect(() => toWalletAddress("0x123")).toThrow();
  });
});

describe("fingerprintSecret", () => {
  it("is deterministic, 12 hex chars, and never echoes the input", () => {
    const fp = fingerprintSecret("ak-123");
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).toBe(fingerprintSecret("ak-123"));
    expect(fp).not.toContain("ak-123");
    expect(fingerprintSecret("ak-124")).not.toBe(fp);
  });
});
