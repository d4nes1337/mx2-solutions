import { z } from "zod";

// The Gamma API is inconsistent about numeric fields: the same field (e.g.
// lastTradePrice, bestBid, spread) comes back as a JSON string on some markets
// and a JSON number on others, and the shape drifts over time. We accept either
// and normalize to a string so all downstream consumers (and the frontend) get
// a stable type. Verified against the live API 2026-06-23 (numbers observed).
const numericString = (fallback: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .default(fallback);

export const GammaTagSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    slug: z.string().optional(),
  })
  .passthrough();

export const GammaMarketSchema = z
  .object({
    id: z.string(),
    question: z.string().default(""),
    description: z.string().default(""),
    conditionId: z.string(),
    slug: z.string().default(""),
    resolutionSource: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    image: z.string().default(""),
    icon: z.string().default(""),
    active: z.boolean().default(false),
    closed: z.boolean().default(false),
    archived: z.boolean().default(false),
    restricted: z.boolean().default(false),
    new: z.boolean().default(false),
    featured: z.boolean().default(false),
    acceptingOrders: z.boolean().default(false),
    acceptingOrdersTimestamp: z.string().nullish(),
    liquidity: numericString("0"),
    volume: numericString("0"),
    openInterest: numericString("0"),
    lastTradePrice: numericString("0"),
    bestBid: numericString("0"),
    bestAsk: numericString("0"),
    spread: numericString("0"),
    status: z.string().default("closed"),
    // JSON-encoded arrays stored as strings in the Gamma API response
    outcomes: z.string().default("[]"),
    outcomePrices: z.string().default("[]"),
    clobTokenIds: z.string().default("[]"),
    neg_risk: z.boolean().default(false).optional(),
    maker_base_fee: z.number().default(0).optional(),
    taker_base_fee: z.number().default(0).optional(),
  })
  .passthrough();

export const GammaEventSchema = z
  .object({
    id: z.string(),
    ticker: z.string().default(""),
    slug: z.string().default(""),
    title: z.string().default(""),
    description: z.string().default(""),
    resolutionSource: z.string().default(""),
    startDate: z.string().nullish(),
    creationDate: z.string().nullish(),
    endDate: z.string().nullish(),
    image: z.string().default(""),
    icon: z.string().default(""),
    active: z.boolean().default(false),
    closed: z.boolean().default(false),
    archived: z.boolean().default(false),
    restricted: z.boolean().default(false),
    new: z.boolean().default(false),
    featured: z.boolean().default(false),
    liquidity: z.union([z.number(), z.string()]).optional(),
    volume: z.union([z.number(), z.string()]).optional(),
    openInterest: z.union([z.number(), z.string()]).optional(),
    status: z.string().default(""),
    tags: z.array(GammaTagSchema).default([]),
    markets: z.array(GammaMarketSchema).default([]),
  })
  .passthrough();

// Each point is {t: Unix seconds, p: probability 0–1}
export const PricePointSchema = z.object({ t: z.number(), p: z.number() }).passthrough();

export type GammaTag = z.infer<typeof GammaTagSchema>;
export type GammaMarket = z.infer<typeof GammaMarketSchema>;
export type GammaEvent = z.infer<typeof GammaEventSchema>;
export type PricePoint = z.infer<typeof PricePointSchema>;
