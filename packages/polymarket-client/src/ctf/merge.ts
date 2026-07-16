import { encodeFunctionData, parseUnits } from "viem";

/**
 * CTF merge calldata: burn equal YES+NO balances of one market back into
 * collateral. On the current (CLOB V2) stack merges route through a
 * collateral adapter contract — the standard adapter for regular markets and
 * the negRisk adapter for negRisk markets (verified against official docs +
 * ctf-exchange-v2 README 2026-07-15; the two sources DISAGREE on the exact
 * addresses, so adapter addresses are REQUIRED CONFIG, never module
 * constants, and apps/api/src/scripts/verify-ctf-adapters.ts must pass
 * on-chain before any live merge — R-028).
 *
 * Legacy paths (direct ConditionalTokens.mergePositions, the CLOB-v1 negRisk
 * adapter) are deliberately not offered: the quoter targets the V2 stack.
 */

/** Polygon USDC.e — Polymarket's CTF collateral (docs, stable since launch). */
export const POLYGON_USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/** Standard adapter: mergePositions(conditionId, amount). */
const ADAPTER_MERGE_ABI = [
  {
    type: "function",
    name: "mergePositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface MergeCalldataInput {
  /** The market's conditionId (bytes32 hex). */
  conditionId: string;
  /** Pairs to merge, in SHARES (6-decimals collateral units on-chain). */
  amountShares: number;
  /** Adapter address from verified config (standard or negRisk variant). */
  adapterAddress: string;
}

export interface MergeTransaction {
  to: string;
  data: string;
  value: string;
}

/**
 * Build the adapter mergePositions transaction. Pure — no I/O; amount is
 * converted at USDC's 6 decimals (1 share pair merges into $1 of collateral).
 */
export const buildMergeTransaction = (input: MergeCalldataInput): MergeTransaction => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.conditionId)) {
    throw new Error("conditionId must be a bytes32 hex string");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.adapterAddress)) {
    throw new Error("adapterAddress must be a checksummable 20-byte hex address");
  }
  if (!(input.amountShares > 0)) {
    throw new Error("amountShares must be positive");
  }
  const amount = parseUnits(input.amountShares.toFixed(6), 6);
  const data = encodeFunctionData({
    abi: ADAPTER_MERGE_ABI,
    functionName: "mergePositions",
    args: [input.conditionId as `0x${string}`, amount],
  });
  return { to: input.adapterAddress, data, value: "0" };
};
