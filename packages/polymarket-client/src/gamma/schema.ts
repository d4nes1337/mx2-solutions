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
    // Sub-market identity inside a multi-market event: the short label
    // ("Over 2.5", a candidate name) and — for sports — the market type
    // (moneyline/spreads/totals), used to order siblings sensibly.
    groupItemTitle: z.string().default(""),
    negRiskMarketID: z.string().nullish(),
    sportsMarketType: z.string().nullish(),
    // Parent event stubs on market payloads (GET /markets/:id) — enough to
    // resolve the full event for sibling listings.
    events: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string().default(""),
            slug: z.string().default(""),
          })
          .passthrough(),
      )
      .optional(),
    // LEGACY caps — read 1000 even where the real taker curve peaks ~1%.
    // Never use for cost math; the fee source of truth is feeSchedule / CLOB fd.
    maker_base_fee: z.number().default(0).optional(),
    taker_base_fee: z.number().default(0).optional(),
    // Fee Structure V2 (verified live 2026-07-15): taker-only fee curve
    // fee = shares · rate · (p(1−p))^exponent, plus the maker-rebate share.
    feesEnabled: z.boolean().nullish(),
    feeType: z.string().nullish(),
    feeSchedule: z
      .object({
        rate: z.coerce.number(),
        exponent: z.coerce.number().default(1),
        takerOnly: z.boolean().default(true),
        rebateRate: z.coerce.number().nullish(),
      })
      .passthrough()
      .nullish(),
    // Maker-rewards program parameters (verified live 2026-07-09, A-050):
    // minimum resting size and max distance from mid (in cents) to qualify.
    rewardsMinSize: z.number().nullish(),
    rewardsMaxSpread: z.number().nullish(),
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
    // Winner-take-all event (elections): sub-markets are mutually exclusive
    // candidates — ordered by price (favorite first) in sibling listings.
    negRisk: z.boolean().default(false).optional(),
    // Recurring-series membership (verified live 2026-07-27): instances of a
    // recurring market ("BTC Up or Down 5m", weekly strikes) carry the parent
    // series slug plus a series stub with its cadence ("5m"/"15m"/"weekly"…).
    seriesSlug: z.string().nullish(),
    series: z
      .array(
        z
          .object({
            id: z.string().optional(),
            title: z.string().optional(),
            slug: z.string().optional(),
            recurrence: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Gamma /public-search response (verified live 2026-07-08): { events, tags }.
 * Only `events` is consumed; unknown keys pass through.
 */
export const PublicSearchSchema = z
  .object({ events: z.array(GammaEventSchema).default([]) })
  .passthrough();

/**
 * Gamma /events/pagination response (verified live 2026-07-27) — the endpoint
 * polymarket.com's homepage grid pages through: { data, pagination }.
 */
export const GammaPaginatedEventsSchema = z
  .object({
    data: z.array(GammaEventSchema).default([]),
    pagination: z
      .object({
        hasMore: z.boolean().default(false),
        totalResults: z.number().default(0),
      })
      .passthrough()
      .default({ hasMore: false, totalResults: 0 }),
  })
  .passthrough();

/**
 * Gamma /series entry (verified live 2026-07-27). `recurrence` is free-form
 * ("5m", "15m", "hourly", "daily", "weekly"…). Embedded `events` are a stale,
 * capped sample — resolve live windows via /events/pagination?series_id=
 * instead of trusting them.
 */
export const GammaSeriesSchema = z
  .object({
    id: z.coerce.string(),
    slug: z.string().default(""),
    title: z.string().default(""),
    recurrence: z.string().nullish(),
    active: z.boolean().default(false),
    events: z.array(GammaEventSchema).default([]),
  })
  .passthrough();

/**
 * Gamma /tags/{id}/related-tags entry (verified live 2026-07-29). Only the
 * relationship is returned — `relatedTagID` must be resolved via /tags/{id} to
 * get a label and slug. `rank` is polymarket.com's own display order for the
 * sub-filter row under a category.
 */
export const GammaRelatedTagSchema = z
  .object({
    tagID: z.coerce.number(),
    relatedTagID: z.coerce.number(),
    rank: z.coerce.number().default(0),
  })
  .passthrough();

// Each point is {t: Unix seconds, p: probability 0–1}
export const PricePointSchema = z.object({ t: z.number(), p: z.number() }).passthrough();

export const PublicProfileSchema = z
  .object({
    createdAt: z.string().nullable().optional(),
    proxyWallet: z.string().nullable().optional(),
    profileImage: z.string().nullable().optional(),
    displayUsernamePublic: z.boolean().nullable().optional(),
    bio: z.string().nullable().optional(),
    pseudonym: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    xUsername: z.string().nullable().optional(),
    verifiedBadge: z.boolean().nullable().optional(),
  })
  .passthrough();

export type GammaTag = z.infer<typeof GammaTagSchema>;
export type GammaRelatedTag = z.infer<typeof GammaRelatedTagSchema>;
export type GammaMarket = z.infer<typeof GammaMarketSchema>;
export type GammaEvent = z.infer<typeof GammaEventSchema>;
export type GammaPaginatedEvents = z.infer<typeof GammaPaginatedEventsSchema>;
export type GammaSeries = z.infer<typeof GammaSeriesSchema>;
export type PricePoint = z.infer<typeof PricePointSchema>;
export type PublicProfile = z.infer<typeof PublicProfileSchema>;
