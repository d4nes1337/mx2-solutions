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

export const ClosedPositionSchema = z
  .object({
    proxyWallet: z.string(),
    asset: z.string(),
    conditionId: z.string(),
    avgPrice: z.number(),
    totalBought: z.number(),
    realizedPnl: z.number(),
    curPrice: z.number(),
    timestamp: z.number(),
    title: z.string().optional(),
    slug: z.string().optional(),
    icon: z.string().optional(),
    eventSlug: z.string().optional(),
    outcome: z.string().optional(),
    outcomeIndex: z.number().optional(),
    oppositeOutcome: z.string().optional(),
    oppositeAsset: z.string().optional(),
    endDate: z.string().optional(),
  })
  .passthrough();

export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

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

export const PositionValueSchema = z
  .object({
    user: z.string(),
    value: z.number(),
  })
  .passthrough();

export type PositionValue = z.infer<typeof PositionValueSchema>;

export const LeaderboardEntrySchema = z
  .object({
    rank: z.string(),
    proxyWallet: z.string(),
    userName: z.string().optional(),
    vol: z.number(),
    pnl: z.number(),
    profileImage: z.string().optional(),
    xUsername: z.string().optional(),
    verifiedBadge: z.boolean().optional(),
  })
  .passthrough();

export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

// Shapes verified against the official Data-API reference on 2026-07-15
// (docs.polymarket.com → /trades and /holders). See docs/INTEGRATION_VERIFIED.md §11.

export const MarketTradeSchema = z
  .object({
    proxyWallet: z.string(),
    side: z.string(),
    conditionId: z.string().optional(),
    asset: z.string().optional(),
    size: z.number(),
    price: z.number(),
    /** Unix seconds. */
    timestamp: z.number(),
    title: z.string().optional(),
    outcome: z.string().optional(),
    outcomeIndex: z.number().optional(),
    name: z.string().optional(),
    pseudonym: z.string().optional(),
    profileImage: z.string().optional(),
    transactionHash: z.string().optional(),
  })
  .passthrough();

export type MarketTrade = z.infer<typeof MarketTradeSchema>;

export const MarketHolderSchema = z
  .object({
    proxyWallet: z.string(),
    amount: z.number(),
    outcomeIndex: z.number().optional(),
    asset: z.string().optional(),
    name: z.string().optional(),
    pseudonym: z.string().optional(),
    bio: z.string().optional(),
    profileImage: z.string().optional(),
    profileImageOptimized: z.string().optional(),
    displayUsernamePublic: z.boolean().optional(),
  })
  .passthrough();

export type MarketHolder = z.infer<typeof MarketHolderSchema>;

export const MarketHoldersGroupSchema = z
  .object({
    token: z.string(),
    holders: MarketHolderSchema.array(),
  })
  .passthrough();

export type MarketHoldersGroup = z.infer<typeof MarketHoldersGroupSchema>;
