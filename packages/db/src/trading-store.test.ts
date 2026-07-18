import { describe, it, expect } from "vitest";
import { resolveInternalStatus } from "./trading-store.js";

// The internal-account re-provision path runs on every login and must never
// walk an activated/funded wallet backwards (the bug where re-login reset it to
// needs_deposit_wallet and wiped the deposit address).
describe("resolveInternalStatus (forward-only)", () => {
  it("advances forward", () => {
    expect(resolveInternalStatus("needs_deposit_wallet", "needs_funding")).toBe("needs_funding");
    expect(resolveInternalStatus("needs_funding", "needs_delegation")).toBe("needs_delegation");
  });

  it("never regresses on idempotent re-provision (needs_deposit_wallet floor)", () => {
    expect(resolveInternalStatus("needs_funding", "needs_deposit_wallet")).toBe("needs_funding");
    expect(resolveInternalStatus("needs_delegation", "needs_deposit_wallet")).toBe(
      "needs_delegation",
    );
    expect(resolveInternalStatus("ready", "needs_deposit_wallet")).toBe("ready");
  });

  it("keeps equal status", () => {
    expect(resolveInternalStatus("needs_funding", "needs_funding")).toBe("needs_funding");
  });

  it("honors an explicit disable in either position", () => {
    expect(resolveInternalStatus("ready", "disabled")).toBe("disabled");
    expect(resolveInternalStatus("disabled", "needs_funding")).toBe("disabled");
  });
});
