import { describe, expect, it } from "vitest";
import { stepForAccount } from "./TradingModes";
import type { TradingAccount } from "@/lib/types";

const account = (status: string): TradingAccount =>
  ({
    id: "account-id",
    kind: "internal_privy",
    label: "Arima trading wallet",
    signerAddress: "0x1111111111111111111111111111111111111111",
    funderAddress: "0x2222222222222222222222222222222222222222",
    signatureType: 0,
    signingMode: "server",
    status,
    credentialsReady: false,
    isPrimary: true,
    depositWalletAddress: "0x3333333333333333333333333333333333333333",
    nextAction: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }) satisfies TradingAccount;

describe("stepForAccount", () => {
  it("matches the real deposit-wallet setup order", () => {
    expect(stepForAccount(null)).toBe(0);
    expect(stepForAccount(account("needs_deposit_wallet"))).toBe(1);
    expect(stepForAccount(account("needs_funding"))).toBe(2);
    expect(stepForAccount(account("needs_credentials"))).toBe(3);
    expect(stepForAccount(account("needs_delegation"))).toBe(3);
    expect(stepForAccount(account("ready"))).toBe(4);
  });
});
