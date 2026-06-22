import { z } from "zod";

// Shapes verified against the live Polymarket Data API on 2026-06-22
// (data-api.polymarket.com/positions and /activity). Numeric fields come back
// as JSON numbers, not strings. `.passthrough()` keeps any fields we don't model.

export const PositionSchema = z
  .object({
    proxyWallet: z.string(),
    asset: z.string(),
    conditionId: z.string(),
    size: z.number(),
    avgPrice: z.number(),
    initialValue: z.number(),
    currentValue: z.number(),
    cashPnl: z.number(),
    percentPnl: z.number(),
    totalBought: z.number(),
    realizedPnl: z.number(),
    percentRealizedPnl: z.number().optional(),
    curPrice: z.number().optional(),
    redeemable: z.boolean().optional(),
    mergeable: z.boolean().optional(),
    title: z.string().optional(),
    slug: z.string().optional(),
    icon: z.string().optional(),
    eventId: z.string().optional(),
    eventSlug: z.string().optional(),
    outcome: z.string().optional(),
    outcomeIndex: z.number().optional(),
    oppositeOutcome: z.string().optional(),
    oppositeAsset: z.string().optional(),
    endDate: z.string().optional(),
    negativeRisk: z.boolean().optional(),
  })
  .passthrough();

export type Position = z.infer<typeof PositionSchema>;

// `type` is an open string set on the live API (e.g. TRADE, REDEEM,
// MAKER_REBATE, SPLIT, MERGE, CONVERSION, REWARD). We keep it as a string so a
// new activity type never breaks the feed. `side` is "BUY"/"SELL"/"" for TRADEs.
export const ActivitySchema = z
  .object({
    proxyWallet: z.string(),
    timestamp: z.number(),
    type: z.string(),
    size: z.number(),
    usdcSize: z.number(),
    price: z.number(),
    transactionHash: z.string().optional(),
    conditionId: z.string().optional(),
    asset: z.string().optional(),
    side: z.string().optional(),
    outcomeIndex: z.number().optional(),
    title: z.string().optional(),
    slug: z.string().optional(),
    outcome: z.string().optional(),
    eventSlug: z.string().optional(),
  })
  .passthrough();

export type Activity = z.infer<typeof ActivitySchema>;
