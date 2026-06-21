import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "./result.js";
import { toWalletAddress } from "./ids.js";

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
