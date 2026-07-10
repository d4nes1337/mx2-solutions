import {
  simulateTriggers,
  validateStrategyDefinition,
  type ExprNode,
  type MarketRef,
  type OrderActionV2,
  type StrategyDefinition,
} from "@mx2/rules";
import type { ClobClient, GammaClient, GammaEvent } from "@mx2/polymarket-client";

/**
 * Backtested showcase engine: "strategies that would have paid off".
 *
 * Takes today's trending liquid markets, backtests a small dip-buy family
 * over the real last-30-days price series (shared `simulateTriggers` — the
 * exact code the builder's ProjectionCard runs), and keeps the winners.
 *
 * Honesty contract (R-023): only positive results are shown by design
 * (selection bias) — every consumer labels them "hypothetical, past ≠ future".
 * The trigger COUNT is simulated with repeat recurrence (max 5, 6 h cooldown)
 * so "would have fired 3×" is meaningful, but the emitted ready-to-open
 * definition uses recurrence `once` — repeat + prepared orders is invalid by
 * design (REPEAT_REQUIRES_ALERT_OR_AUTO).
 *
 * Cost bound (R-025): one Gamma listEvents + ≤ MAX_CANDIDATES CLOB history
 * fetches per refresh; 15-minute in-memory cache with a single-inflight
 * guard; stale data served if a refresh fails.
 */

export interface ShowcaseMarket {
  title: string;
  image: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  currentPriceCents: number;
}

export interface Showcase {
  id: string;
  market: ShowcaseMarket;
  sentence: string;
  definition: StrategyDefinition;
  stats: {
    stakeUsd: number;
    hypotheticalPnlUsd: number;
    triggerCount: number;
    windowDays: number;
  };
  series: { t: number; p: number }[];
  triggers: { t: number; price: number }[];
}

export interface ShowcasesResponse {
  generatedAt: string;
  showcases: Showcase[];
}

export interface ShowcasesDeps {
  gammaClient: GammaClient;
  clobClient: ClobClient;
}

export interface ShowcaseLogger {
  warn(obj: unknown, msg?: string): void;
}

const CACHE_TTL_MS = 15 * 60_000;
const MAX_CANDIDATES = 10;
const MAX_SHOWCASES = 6;
const MIN_LIQUIDITY_USD = 5_000;
const DIP_DELTAS = [0.03, 0.05, 0.08];
const HOLDS_FOR_MS = 15 * 60_000;
const STAKE_USD = 100;
const WINDOW_DAYS = 30;
const MAX_SERIES_POINTS = 80;

const parseJsonArray = (raw: string): string[] => {
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
};

const centsLabel = (p: number): string => `${Math.round(p * 100)}¢`;

interface Candidate {
  title: string;
  image: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  mid: number;
  liquidity: number;
}

const collectCandidates = (events: readonly GammaEvent[], nowMs: number): Candidate[] => {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const event of events) {
    for (const market of event.markets) {
      if (!market.active || market.closed) continue;
      if (seen.has(market.conditionId)) continue;
      const liquidity = Number(market.liquidity);
      if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) continue;
      const prices = parseJsonArray(market.outcomePrices).map(Number);
      const bid = Number(market.bestBid);
      const ask = Number(market.bestAsk);
      const mid =
        Number.isFinite(prices[0]) && prices[0]! > 0
          ? prices[0]!
          : bid > 0 && ask > 0
            ? (bid + ask) / 2
            : NaN;
      if (!Number.isFinite(mid) || mid < 0.1 || mid > 0.9) continue;
      const endRaw = market.endDate ?? event.endDate ?? null;
      const endMs = endRaw ? Date.parse(endRaw) : NaN;
      if (!Number.isFinite(endMs) || endMs < nowMs + 3 * 86_400_000) continue;
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const outcomes = parseJsonArray(market.outcomes);
      const tokenId = tokenIds[0];
      if (!tokenId) continue;
      seen.add(market.conditionId);
      const title = event.markets.length > 1 ? market.question : event.title;
      out.push({
        title: title.slice(0, 120),
        image: market.image || event.image,
        conditionId: market.conditionId,
        tokenId,
        outcome: outcomes[0] ?? "Yes",
        mid,
        liquidity,
      });
      break; // one market per event keeps the gallery varied
    }
  }
  return out.sort((a, b) => b.liquidity - a.liquidity).slice(0, MAX_CANDIDATES);
};

const downsample = (series: readonly { t: number; p: number }[]): { t: number; p: number }[] => {
  if (series.length <= MAX_SERIES_POINTS) return series.map((s) => ({ t: s.t, p: s.p }));
  const stride = Math.ceil(series.length / MAX_SERIES_POINTS);
  const out: { t: number; p: number }[] = [];
  for (let i = 0; i < series.length; i += stride) out.push({ t: series[i]!.t, p: series[i]!.p });
  const last = series[series.length - 1]!;
  if (out[out.length - 1]!.t !== last.t) out.push({ t: last.t, p: last.p });
  return out;
};

const buildShowcaseFor = (
  candidate: Candidate,
  series: readonly { t: number; p: number }[],
  logger: ShowcaseLogger,
): Showcase | null => {
  const ref: MarketRef = {
    conditionId: candidate.conditionId,
    tokenId: candidate.tokenId,
    outcome: candidate.outcome,
    title: candidate.title,
  };

  let best: {
    delta: number;
    threshold: number;
    pnl: number;
    triggers: { t: number; price: number }[];
  } | null = null;

  for (const delta of DIP_DELTAS) {
    const threshold = Math.round((candidate.mid - delta) * 100) / 100;
    if (threshold < 0.05 || threshold > 0.95) continue;
    const expr: ExprNode = {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          condition: { kind: "price", market: ref, source: "ask", comparator: "lte", threshold },
        },
      ],
    };
    const action: OrderActionV2 = {
      kind: "order",
      market: ref,
      side: "BUY",
      price: threshold,
      size: Math.round(STAKE_USD / threshold),
      orderType: "GTC",
      execution: "prepare",
    };
    const result = simulateTriggers({
      expr,
      holdsForMs: HOLDS_FOR_MS,
      // Repeat recurrence here is a SIMULATION statistic only (see header).
      recurrence: { kind: "repeat", maxRepeats: 5, cooldownMs: 6 * 3_600_000 },
      action,
      series,
    });
    if (!result.supported || result.triggers.length === 0) continue;
    if (result.hypotheticalPnlUsd <= 0) continue;
    if (!best || result.hypotheticalPnlUsd > best.pnl) {
      best = {
        delta,
        threshold,
        pnl: result.hypotheticalPnlUsd,
        triggers: result.triggers.map((tr) => ({ t: tr.t, price: tr.price })),
      };
    }
  }

  if (!best) return null;

  const definition: StrategyDefinition = {
    version: 2,
    name: `Dip-buy: ${candidate.title.slice(0, 60)}`,
    templateId: "showcase",
    expr: {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          condition: {
            kind: "price",
            market: ref,
            source: "ask",
            comparator: "lte",
            threshold: best.threshold,
          },
        },
      ],
    },
    holdsForMs: HOLDS_FOR_MS,
    maxDataAgeMs: 5_000,
    action: {
      kind: "order",
      market: ref,
      side: "BUY",
      price: best.threshold,
      size: Math.round(STAKE_USD / best.threshold),
      orderType: "GTC",
      execution: "prepare",
    },
    recurrence: { kind: "once" },
    limits: null,
    expiresAtMs: null,
  };

  const issues = validateStrategyDefinition(definition);
  if (issues.length > 0) {
    logger.warn(
      { conditionId: candidate.conditionId, issues: issues.map((i) => i.code) },
      "showcases: dropped invalid definition",
    );
    return null;
  }

  return {
    id: `${candidate.conditionId}:${Math.round(best.delta * 100)}`,
    market: {
      title: candidate.title,
      image: candidate.image,
      conditionId: candidate.conditionId,
      tokenId: candidate.tokenId,
      outcome: candidate.outcome,
      currentPriceCents: Math.round(candidate.mid * 100),
    },
    sentence: `If ${candidate.outcome} dips below ${centsLabel(best.threshold)} and holds 15 min → buy $${STAKE_USD} at ${centsLabel(best.threshold)}`,
    definition,
    stats: {
      stakeUsd: STAKE_USD,
      hypotheticalPnlUsd: Math.round(best.pnl * 100) / 100,
      triggerCount: best.triggers.length,
      windowDays: WINDOW_DAYS,
    },
    series: downsample(series),
    triggers: best.triggers,
  };
};

const refreshShowcases = async (
  deps: ShowcasesDeps,
  logger: ShowcaseLogger,
): Promise<ShowcasesResponse> => {
  const nowMs = Date.now();
  const events = await deps.gammaClient.listEvents({
    limit: 50,
    active: true,
    closed: false,
    order: "volume_24hr",
    ascending: false,
  });
  if (!events.ok) throw new Error(`showcases: listEvents failed (${events.error.code})`);

  const candidates = collectCandidates(events.value, nowMs);
  const showcases: Showcase[] = [];
  for (const candidate of candidates) {
    const history = await deps.clobClient.getPricesHistory({
      tokenId: candidate.tokenId,
      interval: "1m",
    });
    if (!history.ok) {
      logger.warn(
        { conditionId: candidate.conditionId, code: history.error.code },
        "showcases: history fetch failed",
      );
      continue;
    }
    if (history.value.length < 2) continue;
    const showcase = buildShowcaseFor(candidate, history.value, logger);
    if (showcase) showcases.push(showcase);
  }

  showcases.sort((a, b) => b.stats.hypotheticalPnlUsd - a.stats.hypotheticalPnlUsd);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    showcases: showcases.slice(0, MAX_SHOWCASES),
  };
};

// ── Module cache (single process per D-001) ─────────────────────────────────

let cache: { data: ShowcasesResponse; fetchedAt: number } | null = null;
let inflight: Promise<ShowcasesResponse> | null = null;

/** Test hook. */
export const resetShowcaseCache = (): void => {
  cache = null;
  inflight = null;
};

export const getShowcases = async (
  deps: ShowcasesDeps,
  logger: ShowcaseLogger,
): Promise<ShowcasesResponse> => {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.data;
  if (!inflight) {
    inflight = refreshShowcases(deps, logger)
      .then((data) => {
        cache = { data, fetchedAt: Date.now() };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    // Refresh failed: serve stale data when we have it (better a slightly old
    // showcase than an empty homepage).
    if (cache) {
      logger.warn({ err }, "showcases: refresh failed, serving stale cache");
      return cache.data;
    }
    throw err;
  }
};
