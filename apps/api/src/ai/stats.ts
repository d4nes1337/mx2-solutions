import type { ClobClient, GammaClient } from "@mx2/polymarket-client";
import { recentDrift, typicalMovement } from "@mx2/rules";
import { getMarketEconomics, type MarketEconomics } from "../lib/market-economics.js";
import { getMarketScenarios, type ScenarioLogger } from "../lib/scenarios.js";
import type { MarketSearchHit } from "../lib/market-search.js";

/**
 * Compact analytics payload behind the AI's get_market_stats tool. Every
 * section is BEST-EFFORT: an upstream failure nulls that section, never the
 * whole tool call — the model can still reason from whatever survived.
 * All prices are probabilities in 0–1 (58¢ = 0.58), matching the rest of the
 * prompt contract. Reuses the shared caches (economics 5-min, scenarios
 * 15-min); the price-history fetch is one direct CLOB call.
 */

export interface StatsDeps {
  clobClient: ClobClient;
  gammaClient: GammaClient;
  logger: ScenarioLogger;
}

export interface MarketStatsPayload {
  title: string;
  outcome: string;
  /** Best book prices from the (≤30s old) search snapshot. */
  book: { bestBid: number | null; bestAsk: number | null; spread: number | null };
  price: {
    current: number | null;
    high7d: number | null;
    low7d: number | null;
    /** Mean |Δp| between consecutive samples — a volatility feel. */
    typicalMove: number | null;
    /** Signed change over the trailing 24h. */
    drift24h: number | null;
  } | null;
  activity: { volumeUsd: number | null; liquidityUsd: number | null; endDate: string | null };
  economics: Pick<MarketEconomics, "feeSchedule" | "rewards"> | null;
  /** Top backtested entry ideas (summaries only — never full definitions). */
  scenarios:
    | {
        kind: string;
        sentence: string;
        entryPriceCents: number;
        stats: Record<string, number | undefined>;
      }[]
    | null;
}

const DRIFT_LOOKBACK_MS = 24 * 60 * 60_000;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const numOrNull = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export const buildMarketStats = async (
  deps: StatsDeps,
  hit: MarketSearchHit,
  pos: number,
): Promise<MarketStatsPayload> => {
  const tokenId = hit.tokenIds[pos] ?? "";
  const outcome = hit.outcomes[pos] ?? "";
  const current = numOrNull(hit.outcomePrices[pos] ?? "");

  const [priceSection, economicsSection, scenariosSection] = await Promise.all([
    deps.clobClient
      .getPricesHistory({ tokenId, interval: "1w" })
      .then((res) => {
        if (!res.ok || res.value.length < 2) return null;
        // CLOB history timestamps are SECONDS — drift helpers expect ms.
        const series = res.value.map((s) => ({ t: s.t * 1000, p: s.p }));
        const prices = series.map((s) => s.p);
        const typical = typicalMovement(series);
        const drift = recentDrift(series, DRIFT_LOOKBACK_MS);
        return {
          current,
          high7d: round3(Math.max(...prices)),
          low7d: round3(Math.min(...prices)),
          typicalMove: typical !== null ? round3(typical) : null,
          drift24h: drift !== null ? round3(drift) : null,
        };
      })
      .catch(() => null),
    getMarketEconomics(deps, hit.conditionId)
      .then(({ feeSchedule, rewards }) => ({ feeSchedule, rewards }))
      .catch(() => null),
    getMarketScenarios(
      { clobClient: deps.clobClient },
      {
        conditionId: hit.conditionId,
        tokenId,
        outcome,
        title: hit.title,
        currentPrice: current ?? 0.5,
      },
      deps.logger,
    )
      .then((res) =>
        res.scenarios.slice(0, 2).map((s) => ({
          kind: s.kind,
          sentence: s.sentence,
          entryPriceCents: s.entryPriceCents,
          stats: {
            hypotheticalPnlUsd: s.stats.hypotheticalPnlUsd,
            triggerCount: s.stats.triggerCount,
            touches: s.stats.touches,
            rewardsPerDayUsd: s.stats.rewardsPerDayUsd,
          },
        })),
      )
      .catch(() => null),
  ]);

  return {
    title: hit.title,
    outcome,
    book: {
      bestBid: numOrNull(hit.bestBid),
      bestAsk: numOrNull(hit.bestAsk),
      spread:
        numOrNull(hit.bestAsk) !== null && numOrNull(hit.bestBid) !== null
          ? round3(Number(hit.bestAsk) - Number(hit.bestBid))
          : null,
    },
    price: priceSection,
    activity: {
      volumeUsd: numOrNull(hit.volume),
      liquidityUsd: numOrNull(hit.liquidity),
      endDate: hit.endDate,
    },
    economics: economicsSection,
    scenarios: scenariosSection,
  };
};
