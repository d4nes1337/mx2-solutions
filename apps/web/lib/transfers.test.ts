import { describe, expect, it } from "vitest";
import {
  BRIDGE_WITHDRAWAL_TERMINAL_STATES,
  DEPOSIT_TERMINAL_STATES,
  WALLET_WITHDRAWAL_TERMINAL_STATES,
  bridgeWithdrawalToTransfer,
  conversionToTransfer,
  depositToTransfer,
  isTerminal,
  walletWithdrawalToTransfer,
} from "./transfers";
import type {
  BridgeDepositItem,
  BridgeWithdrawalItem,
  FundsAsset,
  WalletWithdrawalItem,
} from "./types";

const asset: FundsAsset = {
  id: "8453:0xusdc",
  chainId: "8453",
  chainName: "Base",
  addressType: "evm",
  minCheckoutUsd: 2,
  token: { name: "USD Coin", symbol: "USDC", address: "0xUSDC", decimals: 6 },
};

const deposit = (state: BridgeDepositItem["state"]): BridgeDepositItem => ({
  id: "1",
  fromChainId: "8453",
  fromTokenAddress: "0xusdc",
  fromAmountBaseUnit: "5000000",
  dismissedAt: null,
  completionSource: null,
  state,
  providerStatus: "X",
  txHash: null,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:01:00Z",
});

const walletWithdrawal = (state: WalletWithdrawalItem["state"]): WalletWithdrawalItem => ({
  id: "2",
  amountUsd: 25,
  destination: "0xme",
  state,
  transactionHash: state === "confirmed" ? "0xhash" : null,
  createdAt: "2026-07-01T00:00:00Z",
});

const bridgeWithdrawal = (state: BridgeWithdrawalItem["state"]): BridgeWithdrawalItem => ({
  id: "3",
  amountUsd: 50,
  destination: "0xme",
  toChainId: "8453",
  state,
  polygonTxHash: null,
  bridgeTxHash: null,
  createdAt: "2026-07-01T00:00:00Z",
});

describe("depositToTransfer", () => {
  const cases: [BridgeDepositItem["state"], number, string][] = [
    ["detected", 0, "pending"],
    ["processing", 1, "pending"],
    ["origin_confirmed", 2, "pending"],
    ["submitted", 2, "pending"],
    ["completed", 3, "success"],
    ["failed", 1, "failed"],
  ];
  it.each(cases)("maps %s → step %i, status %s", (state, step, status) => {
    const t = depositToTransfer(deposit(state), asset);
    expect(t.currentStep).toBe(step);
    expect(t.status).toBe(status);
    expect(t.stageLabel.length).toBeGreaterThan(0);
    expect(isTerminal(t)).toBe(status !== "pending");
  });

  it("labels amount and chain from the asset", () => {
    const t = depositToTransfer(deposit("processing"), asset);
    expect(t.amountLabel).toBe("+5.00 USDC");
    expect(t.chainName).toBe("Base");
    expect(t.stageLabel).toBe("confirming on Base");
    expect(t.steps.map((s) => s.id)).toEqual(["detected", "confirming", "arriving", "done"]);
  });

  it("degrades gracefully without an asset match or amount", () => {
    const t = depositToTransfer({ ...deposit("detected"), fromAmountBaseUnit: "" }, null);
    expect(t.amountLabel).toBe("Deposit");
    expect(t.chainName).toBe("Base"); // from CHAIN_NAMES fallback for 8453
  });

  it("keeps a generic label on malformed base units", () => {
    const t = depositToTransfer(
      { ...deposit("detected"), fromAmountBaseUnit: "not-a-number" },
      asset,
    );
    expect(t.amountLabel).toBe("Deposit");
  });
});

describe("walletWithdrawalToTransfer", () => {
  const cases: [WalletWithdrawalItem["state"], number, string][] = [
    ["requested", 0, "pending"],
    ["submitted", 1, "pending"],
    ["confirmed", 2, "success"],
    ["failed", 1, "failed"],
  ];
  it.each(cases)("maps %s → step %i, status %s", (state, step, status) => {
    const t = walletWithdrawalToTransfer(walletWithdrawal(state));
    expect(t.currentStep).toBe(step);
    expect(t.status).toBe(status);
    expect(t.direction).toBe("out");
  });

  it("links the Polygon tx when present", () => {
    const t = walletWithdrawalToTransfer(walletWithdrawal("confirmed"));
    expect(t.txUrl).toBe("https://polygonscan.com/tx/0xhash");
    expect(t.amountLabel).toBe("−$25.00");
  });
});

describe("bridgeWithdrawalToTransfer", () => {
  const cases: [BridgeWithdrawalItem["state"], number, string, string | null][] = [
    ["requested", 0, "pending", null],
    ["address_created", 0, "pending", null],
    ["polygon_submitted", 1, "pending", null],
    ["polygon_confirmed", 2, "pending", null],
    ["bridging", 2, "pending", null],
    ["completed", 3, "success", null],
    ["failed_address", 0, "failed", "recoverable"],
    ["failed_polygon", 1, "failed", "recoverable"],
    ["failed_bridge", 2, "failed", "support"],
  ];
  it.each(cases)("maps %s → step %i, status %s, tone %s", (state, step, status, tone) => {
    const t = bridgeWithdrawalToTransfer(bridgeWithdrawal(state));
    expect(t.currentStep).toBe(step);
    expect(t.status).toBe(status);
    expect(t.failureTone).toBe(tone);
  });

  it("names the destination chain in steps and stage", () => {
    const t = bridgeWithdrawalToTransfer(bridgeWithdrawal("bridging"));
    expect(t.steps[2]!.label).toBe("Bridging to Base");
    expect(t.stageLabel).toBe("bridging to Base");
  });

  it("newly-tracked polygon_confirmed advances the tracker past the Polygon leg", () => {
    const before = bridgeWithdrawalToTransfer(bridgeWithdrawal("polygon_submitted"));
    const after = bridgeWithdrawalToTransfer(bridgeWithdrawal("polygon_confirmed"));
    expect(after.currentStep).toBeGreaterThan(before.currentStep);
  });
});

describe("conversionToTransfer", () => {
  it("is a pending in-flight step while USDC.e sits unconverted", () => {
    const t = conversionToTransfer(12.34);
    expect(t.status).toBe("pending");
    expect(t.currentStep).toBe(1);
    expect(t.amountLabel).toBe("+$12.34");
    expect(t.stageLabel).toBe("converting to pUSD");
  });

  it("flips to success once completion is observed", () => {
    const t = conversionToTransfer(12.34, { completedAt: Date.now() });
    expect(t.status).toBe("success");
    expect(t.currentStep).toBe(2);
  });

  it("keeps a stable createdAt from startedAt (pill dismissal anchoring)", () => {
    const startedAt = Date.now() - 30_000;
    expect(conversionToTransfer(1, { startedAt }).createdAt).toBe(startedAt);
  });
});

describe("terminal state tables", () => {
  it("cover the full unions", () => {
    expect([...DEPOSIT_TERMINAL_STATES].sort()).toEqual([
      "completed",
      "expired",
      "failed",
      "superseded",
    ]);
    expect([...WALLET_WITHDRAWAL_TERMINAL_STATES].sort()).toEqual(["confirmed", "failed"]);
    expect([...BRIDGE_WITHDRAWAL_TERMINAL_STATES].sort()).toEqual([
      "completed",
      "failed_address",
      "failed_bridge",
      "failed_polygon",
    ]);
  });
});
