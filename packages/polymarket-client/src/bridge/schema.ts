import { z } from "zod";

export const BridgeTokenSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  address: z.string(),
  decimals: z.number().int().nonnegative(),
});

export const BridgeSupportedAssetSchema = z.object({
  // The Bridge API currently returns this as a string. Keep it as string in the
  // raw client and normalize at the API boundary where product DTOs are shaped.
  chainId: z.string(),
  chainName: z.string(),
  token: BridgeTokenSchema,
  minCheckoutUsd: z.number().nonnegative(),
});

export const BridgeSupportedAssetsResponseSchema = z.object({
  supportedAssets: z.array(BridgeSupportedAssetSchema),
  note: z.string().optional(),
});

export const BridgeAddressTypeSchema = z.enum(["evm", "svm", "btc", "tvm"]);

export const BridgeDepositAddressesSchema = z
  .object({
    evm: z.string().optional(),
    svm: z.string().optional(),
    btc: z.string().optional(),
    // The live API emits `tron`; we normalize it to `tvm` at the client boundary.
    // Keep both here so parsing never drops a family the provider sends.
    tron: z.string().optional(),
    tvm: z.string().optional(),
  })
  .catchall(z.string());

export const BridgeDepositResponseSchema = z
  .object({
    // Live API returns the family map under `address` (singular). The older
    // `addresses`/`depositAddresses` keys are kept as fallbacks. Passthrough so
    // sibling fields (note, warnings) and provider-added families don't break reads.
    address: BridgeDepositAddressesSchema.optional(),
    addresses: BridgeDepositAddressesSchema.optional(),
    depositAddresses: BridgeDepositAddressesSchema.optional(),
  })
  .passthrough();

// ── Quotes (POST /quote) ────────────────────────────────────────────────────
// Shapes observed in official docs 2026-07-17; everything optional/passthrough
// so provider drift degrades to missing display fields, never a hard failure.

const looseNumber = z.union([z.number(), z.string().transform(Number)]).optional();

export const BridgeFeeBreakdownSchema = z
  .object({
    appFeeLabel: z.string().optional(),
    appFeePercent: looseNumber,
    appFeeUsd: looseNumber,
    gasUsd: looseNumber,
    fillCostUsd: looseNumber,
    swapImpactUsd: looseNumber,
    totalImpactUsd: looseNumber,
    maxSlippage: looseNumber,
    minReceived: looseNumber,
  })
  .passthrough();

export const BridgeQuoteResponseSchema = z
  .object({
    quoteId: z.string().optional(),
    estCheckoutTimeMs: looseNumber,
    estToTokenBaseUnit: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
    estInputUsd: looseNumber,
    estOutputUsd: looseNumber,
    estFeeBreakdown: BridgeFeeBreakdownSchema.optional(),
  })
  .passthrough();

// ── Status (GET /status/{bridgeAddress}) ────────────────────────────────────

/** Provider transfer statuses documented 2026-07-17. Unknown values map to a
 * non-terminal bucket downstream — never a parse failure. */
export const KNOWN_BRIDGE_STATUSES = [
  "DEPOSIT_DETECTED",
  "PROCESSING",
  "ORIGIN_TX_CONFIRMED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
] as const;

export const BridgeStatusTransactionSchema = z
  .object({
    fromChainId: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
    fromTokenAddress: z.string().optional(),
    fromAmountBaseUnit: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
    toChainId: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
    toTokenAddress: z.string().optional(),
    status: z.string().default("PROCESSING"),
    txHash: z.string().nullish(),
    createdTimeMs: looseNumber,
  })
  .passthrough();

export const BridgeStatusResponseSchema = z
  .object({ transactions: z.array(BridgeStatusTransactionSchema).default([]) })
  .passthrough();

// ── Withdrawals (POST /withdraw) ────────────────────────────────────────────
// Same address-based model as deposits: the response is an intermediate bridge
// address; moving funds to it on Polygon executes the withdrawal.

export const BridgeWithdrawResponseSchema = z
  .object({
    address: BridgeDepositAddressesSchema.optional(),
    addresses: BridgeDepositAddressesSchema.optional(),
    note: z.string().optional(),
  })
  .passthrough();

export type BridgeSupportedAsset = z.infer<typeof BridgeSupportedAssetSchema>;
export type BridgeSupportedAssetsResponse = z.infer<typeof BridgeSupportedAssetsResponseSchema>;
export type BridgeAddressType = z.infer<typeof BridgeAddressTypeSchema>;
export type BridgeDepositAddresses = z.infer<typeof BridgeDepositAddressesSchema>;
export type BridgeDepositResponse = z.infer<typeof BridgeDepositResponseSchema>;
export type BridgeFeeBreakdown = z.infer<typeof BridgeFeeBreakdownSchema>;
export type BridgeQuoteResponse = z.infer<typeof BridgeQuoteResponseSchema>;
export type BridgeStatusTransaction = z.infer<typeof BridgeStatusTransactionSchema>;
export type BridgeStatusResponse = z.infer<typeof BridgeStatusResponseSchema>;
export type BridgeWithdrawResponse = z.infer<typeof BridgeWithdrawResponseSchema>;
