import { describe, it, expect } from "vitest";
import { deriveDepositWallet } from "./derive.js";

describe("deriveDepositWallet", () => {
  // Anchor pair: the owner's MetaMask signer EOA and the Polymarket deposit wallet
  // shown on their Polymarket profile (used by docs/test-auth.html). This is the
  // correctness gate — if derivation drifts, this fails.
  it("derives the owner's known deposit wallet from their EOA", () => {
    const eoa = "0x77117F39dc33292c657a366643Dd995010b7E36d";
    const expected = "0x997C95D8BE61D5779EdfB49aAF5dD83d85f31434";
    expect(deriveDepositWallet(eoa)).toBe(expected);
  });

  it("is case-insensitive on the input EOA", () => {
    const lower = deriveDepositWallet("0x77117f39dc33292c657a366643dd995010b7e36d");
    expect(lower).toBe("0x997C95D8BE61D5779EdfB49aAF5dD83d85f31434");
  });

  it("returns a checksummed address", () => {
    const out = deriveDepositWallet("0x77117F39dc33292c657a366643Dd995010b7E36d");
    expect(out).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Mixed-case checksum (not all-lower / all-upper).
    expect(out).not.toBe(out.toLowerCase());
  });

  it("throws on a malformed address", () => {
    expect(() => deriveDepositWallet("not-an-address")).toThrow(/invalid EOA/);
    expect(() => deriveDepositWallet("0x1234")).toThrow(/invalid EOA/);
  });
});
