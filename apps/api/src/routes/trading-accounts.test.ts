/**
 * The setup ladder must walk: activate → top_up → bootstrap_allowances →
 * delegate → setup_credentials → done. The authorize rung is the owner-beta
 * regression: a funded account without exchange allowances previously showed
 * NO next step at all.
 */
import { describe, it, expect } from "vitest";
import { nextAction } from "./trading-accounts.js";

const privy = (status: string, funder: string | null = "0xdeposit") => ({
  status,
  signingMode: "server",
  kind: "internal_privy",
  funderAddress: funder,
});

describe("trading-account nextAction ladder", () => {
  it("activation comes first", () => {
    expect(nextAction(privy("needs_deposit_wallet", null), false, null)).toBe(
      "activate_deposit_wallet",
    );
    expect(nextAction(privy("ready", null), true, true)).toBe("activate_deposit_wallet");
  });

  it("funding before authorization", () => {
    expect(nextAction(privy("needs_funding"), false, false)).toBe("top_up");
  });

  it("funded but allowances missing → bootstrap_allowances (even when otherwise ready)", () => {
    expect(nextAction(privy("needs_delegation"), false, false)).toBe("bootstrap_allowances");
    expect(nextAction(privy("ready"), true, false)).toBe("bootstrap_allowances");
  });

  it("allowances unprobeable (no RPC) → the rung is skipped, never invented", () => {
    expect(nextAction(privy("needs_delegation"), false, null)).toBe("delegate");
    expect(nextAction(privy("ready"), true, null)).toBeNull();
  });

  it("clean allowances continue to delegation / credentials / done", () => {
    expect(nextAction(privy("needs_delegation"), false, true)).toBe("delegate");
    expect(nextAction(privy("needs_credentials"), false, true)).toBe("setup_credentials");
    expect(nextAction(privy("ready"), true, true)).toBeNull();
  });

  it("external wallets never get the authorize rung", () => {
    expect(
      nextAction(
        { status: "ready", signingMode: "browser", kind: "external_wallet", funderAddress: null },
        true,
        false,
      ),
    ).toBeNull();
  });
});
