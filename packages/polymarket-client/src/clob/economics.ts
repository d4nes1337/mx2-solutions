import { z } from "zod";

/**
 * Per-market economics read models: the CLOB V2 fee schedule (`fd` on
 * GET /clob-markets/{condition_id}, the authoritative source — the legacy
 * mbf/tbf bps fields are deliberately IGNORED: they read 1000 even on markets
 * whose real taker curve peaks near 1%) and the liquidity-rewards config
 * (GET /rewards/markets/*). Schemas are tolerant (.passthrough(), coerced
 * numbers) because these endpoints drift — parse failures must degrade to
 * "unknown", never to fabricated zeros (R-029).
 *
 * Verified against docs.polymarket.com (trading/fees, api-reference) 2026-07-15.
 */

/** fd = { r: rate, e: exponent, to: takerOnly } — feeds fee = C·r·(p(1−p))^e. */
export const FeeDetailsSchema = z
  .object({
    r: z.coerce.number(),
    e: z.coerce.number().default(1),
    to: z.boolean().default(true),
  })
  .passthrough();

export const ClobMarketInfoSchema = z
  .object({
    condition_id: z.string().optional(),
    fd: FeeDetailsSchema.nullish(),
  })
  .passthrough();
export type ClobMarketInfo = z.infer<typeof ClobMarketInfoSchema>;

export const FeeRateResponseSchema = z
  .object({ base_fee: z.coerce.number() })
  .passthrough();

export const RewardsConfigSchema = z
  .object({
    asset_address: z.string().optional(),
    rate_per_day: z.coerce.number().optional(),
    total_rewards: z.coerce.number().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
  })
  .passthrough();
export type RewardsConfig = z.infer<typeof RewardsConfigSchema>;

export const RewardsMarketSchema = z
  .object({
    condition_id: z.string().optional(),
    market: z.string().optional(),
    rewards_max_spread: z.coerce.number().nullish(),
    rewards_min_size: z.coerce.number().nullish(),
    rewards_config: RewardsConfigSchema.array().nullish(),
  })
  .passthrough();
export type RewardsMarket = z.infer<typeof RewardsMarketSchema>;

/** The rewards endpoints wrap results inconsistently — accept both shapes. */
export const RewardsMarketsResponseSchema = z
  .union([
    RewardsMarketSchema.array(),
    z.object({ data: RewardsMarketSchema.array() }).passthrough(),
  ])
  .transform((v): RewardsMarket[] => (Array.isArray(v) ? v : v.data));
