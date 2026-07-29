import type { ClobClient, GammaClient } from "@mx2/polymarket-client";

/**
 * Per-market economics (fee schedule + liquidity-rewards config) with a 5-min
 * in-memory cache. Extracted from the markets route so the AI generator's
 * get_market_stats tool shares the exact same source of truth and cache.
 */

export interface MarketEconomics {
  feeSchedule: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number | null;
  } | null;
  rewards: {
    minSize: number | null;
    maxSpread: number | null;
    ratePerDayUsd: number | null;
    totalRewards: number | null;
    startDate: string | null;
    endDate: string | null;
  } | null;
  fetchedAt: string;
}

export interface EconomicsDeps {
  clobClient: ClobClient;
  gammaClient: GammaClient;
}

const ECONOMICS_TTL_MS = 5 * 60_000;
const economicsCache = new Map<string, { at: number; value: MarketEconomics }>();

/** Test hook. */
export const resetEconomicsCache = (): void => {
  economicsCache.clear();
};

/**
 * Fee source of truth: CLOB `fd`; Gamma `feeSchedule` is the fallback. A null
 * section means UNKNOWN — the UI must say "fee unknown", never assume zero
 * (fail-open display posture, R-029).
 */
export const getMarketEconomics = async (
  deps: EconomicsDeps,
  conditionId: string,
): Promise<MarketEconomics> => {
  const hit = economicsCache.get(conditionId);
  if (hit && Date.now() - hit.at < ECONOMICS_TTL_MS) return hit.value;

  const [clobInfo, rewardsRes, gammaRes] = await Promise.all([
    deps.clobClient.getClobMarket(conditionId),
    deps.clobClient.getRewardsMarket(conditionId),
    // Gamma /markets/{id} only accepts numeric ids — a conditionId 422s there.
    deps.gammaClient.findMarket({ conditionId }),
  ]);

  const gamma = gammaRes.ok ? gammaRes.value : null; // null also when not found
  const fd = clobInfo.ok ? clobInfo.value.fd : null;
  const gammaFee = gamma?.feeSchedule ?? null;
  const feeSchedule =
    fd != null
      ? {
          rate: fd.r,
          exponent: fd.e,
          takerOnly: fd.to,
          rebateRate: gammaFee?.rebateRate ?? null,
        }
      : gammaFee != null
        ? {
            rate: gammaFee.rate,
            exponent: gammaFee.exponent,
            takerOnly: gammaFee.takerOnly,
            rebateRate: gammaFee.rebateRate ?? null,
          }
        : gamma?.feesEnabled === false
          ? { rate: 0, exponent: 1, takerOnly: true, rebateRate: null }
          : null;

  const rewardsRow = rewardsRes.ok ? rewardsRes.value[0] : undefined;
  const activeConfig = rewardsRow?.rewards_config?.find((c) => (c.rate_per_day ?? 0) > 0);
  const anyRewards =
    rewardsRow != null || gamma?.rewardsMinSize != null || gamma?.rewardsMaxSpread != null;
  const rewards = anyRewards
    ? {
        minSize: rewardsRow?.rewards_min_size ?? gamma?.rewardsMinSize ?? null,
        maxSpread: rewardsRow?.rewards_max_spread ?? gamma?.rewardsMaxSpread ?? null,
        ratePerDayUsd: activeConfig?.rate_per_day ?? null,
        totalRewards: activeConfig?.total_rewards ?? null,
        startDate: activeConfig?.start_date ?? null,
        endDate: activeConfig?.end_date ?? null,
      }
    : null;

  const value: MarketEconomics = { feeSchedule, rewards, fetchedAt: new Date().toISOString() };
  economicsCache.set(conditionId, { at: Date.now(), value });
  return value;
};
