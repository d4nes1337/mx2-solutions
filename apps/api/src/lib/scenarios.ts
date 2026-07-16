import {
  simulateTriggers,
  templateSpecById,
  validateStrategyDefinition,
  type ExprNode,
  type MarketRef,
  type StrategyDefinition,
} from "@mx2/rules";
import type { ClobClient } from "@mx2/polymarket-client";

/**
 * Per-market "entry scenarios" for the cockpit: a few concrete, honest ways a
 * user could enter THIS market, each backtested (where backtestable) against
 * the real last-30-days price series with the same shared `simulateTriggers`
 * the builder and showcases use.
 *
 * Families:
 *  - dip_buy   — buy when the price dips N¢ below now and holds 15 min
 *                (best positive-PnL delta of a small grid; dropped if none win)
 *  - breakout  — buy when the price breaks N¢ above now and holds 15 min
 *                (momentum entry; same positive-PnL bar)
 *  - limit_entry — a patient resting bid at the window's lower quartile;
 *                no PnL claim, only how often the window touched that level
 *  - trailing_dip — trailing entry (buy the rebound off the running low);
 *                backtested over an offset grid, same positive-PnL bar
 *  - rescue_exit — "save a dead bet": a trailing-stop ALERT. Deliberately
 *                alert-framed with NO PnL claim — without the user's position
 *                there is nothing defensible to project, only how often the
 *                stop would have fired
 *  - farm_rewards — shown only when the market carries a live rewards pool;
 *                deep-links the maker-efficiency template (or the farming
 *                cockpit when the maker loop is enabled)
 *
 * Honesty contract mirrors the showcases (R-023): only positive backtests are
 * shown for the trigger families, everything is labeled hypothetical, and all
 * emitted definitions are execution:"prepare" (or alert) + recurrence:"once".
 * Cost bound mirrors R-025: one CLOB history fetch per market per 15 minutes
 * (per-market cache, single-inflight, stale-on-error, LRU-capped).
 */

export interface ScenarioMarketInput {
  conditionId: string;
  tokenId: string;
  outcome: string;
  title: string;
  /** Current mid/last price in 0..1. */
  currentPrice: number;
}

export interface MarketScenario {
  id: string;
  kind: "dip_buy" | "breakout" | "limit_entry" | "trailing_dip" | "rescue_exit" | "farm_rewards";
  label: string;
  sentence: string;
  /** Chat-voice text a user could paste into the AI prompt box. */
  prompt: string;
  definition: StrategyDefinition;
  entryPriceCents: number;
  stats: {
    stakeUsd: number;
    windowDays: number;
    hypotheticalPnlUsd?: number;
    triggerCount?: number;
    /** limit_entry: number of times the 30-day series touched the entry level. */
    touches?: number;
    /** farm_rewards: the pool's daily rate (shared across makers), when known. */
    rewardsPerDayUsd?: number;
  };
  triggers: { t: number; price: number }[];
  /** Alternate destination (farming cockpit) instead of the builder deep-link. */
  link?: { label: string; href: string };
}

export interface ScenariosResponse {
  conditionId: string;
  outcome: string;
  generatedAt: string;
  scenarios: MarketScenario[];
}

export interface ScenariosDeps {
  clobClient: ClobClient;
  /**
   * Rewards-pool lookup for the farm_rewards card (5-min cached upstream in
   * the markets route). Optional: absent = the card is simply never emitted.
   */
  getRewards?: (
    conditionId: string,
  ) => Promise<{ ratePerDayUsd: number | null; minSize: number | null } | null>;
  /** Routes the farm card to the cockpit instead of the builder template. */
  makerLoopEnabled?: boolean;
}

export interface ScenarioLogger {
  warn(obj: unknown, msg?: string): void;
}

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_MARKETS = 200;
const DIP_DELTAS = [0.03, 0.05, 0.08];
const BREAKOUT_DELTAS = [0.03, 0.05];
const TRAILING_OFFSETS = [0.03, 0.05, 0.08];
const RESCUE_OFFSET = 0.08;
const HOLDS_FOR_MS = 15 * 60_000;
const STAKE_USD = 100;
const WINDOW_DAYS = 30;
const MAX_SCENARIOS = 5;

const centsLabel = (p: number): string => `${Math.round(p * 100)}¢`;
const clampPrice = (p: number): number => Math.round(p * 100) / 100;

const priceExpr = (ref: MarketRef, comparator: "lte" | "gte", threshold: number): ExprNode => ({
  type: "group",
  id: "root",
  op: "and",
  children: [
    {
      type: "condition",
      id: "c1",
      condition: { kind: "price", market: ref, source: "ask", comparator, threshold },
    },
  ],
});

const makeDefinition = (
  name: string,
  ref: MarketRef,
  comparator: "lte" | "gte",
  threshold: number,
): StrategyDefinition => ({
  version: 2,
  name: name.slice(0, 80),
  templateId: "scenario",
  expr: priceExpr(ref, comparator, threshold),
  holdsForMs: HOLDS_FOR_MS,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: ref,
    side: "BUY",
    price: threshold,
    size: Math.round(STAKE_USD / threshold),
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
});

/** Best positive-PnL delta of a trigger family, or null when none win. */
const bestTriggerScenario = (
  input: ScenarioMarketInput,
  ref: MarketRef,
  series: readonly { t: number; p: number }[],
  family: "dip_buy" | "breakout",
): { threshold: number; pnl: number; triggers: { t: number; price: number }[] } | null => {
  const deltas = family === "dip_buy" ? DIP_DELTAS : BREAKOUT_DELTAS;
  const comparator = family === "dip_buy" ? ("lte" as const) : ("gte" as const);
  let best: { threshold: number; pnl: number; triggers: { t: number; price: number }[] } | null =
    null;
  for (const delta of deltas) {
    const threshold = clampPrice(
      family === "dip_buy" ? input.currentPrice - delta : input.currentPrice + delta,
    );
    if (threshold < 0.05 || threshold > 0.95) continue;
    const result = simulateTriggers({
      expr: priceExpr(ref, comparator, threshold),
      holdsForMs: HOLDS_FOR_MS,
      // Repeat recurrence is a simulation statistic only (as in showcases).
      recurrence: { kind: "repeat", maxRepeats: 5, cooldownMs: 6 * 3_600_000 },
      action: {
        kind: "order",
        market: ref,
        side: "BUY",
        price: threshold,
        size: Math.round(STAKE_USD / threshold),
        orderType: "GTC",
        execution: "prepare",
      },
      series,
    });
    if (!result.supported || result.triggers.length === 0) continue;
    if (result.hypotheticalPnlUsd <= 0) continue;
    if (!best || result.hypotheticalPnlUsd > best.pnl) {
      best = {
        threshold,
        pnl: result.hypotheticalPnlUsd,
        triggers: result.triggers.map((tr) => ({ t: tr.t, price: tr.price })),
      };
    }
  }
  return best;
};

/** Lower-quartile price of the window — the "value zone" for a patient bid. */
const lowerQuartile = (series: readonly { t: number; p: number }[]): number => {
  const sorted = series.map((s) => s.p).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.25)] ?? sorted[0] ?? NaN;
};

const trailingExpr = (ref: MarketRef, mode: "stop" | "entry", offset: number): ExprNode => ({
  type: "group",
  id: "root",
  op: "and",
  children: [
    {
      type: "condition",
      id: "c1",
      condition: {
        kind: "trailing",
        market: ref,
        mode,
        source: mode === "stop" ? "bid" : "ask",
        offset,
      },
    },
  ],
});

/** Best positive-PnL trailing-entry offset, or null when none win. */
const bestTrailingEntry = (
  input: ScenarioMarketInput,
  ref: MarketRef,
  series: readonly { t: number; p: number }[],
): { offset: number; pnl: number; triggers: { t: number; price: number }[] } | null => {
  let best: { offset: number; pnl: number; triggers: { t: number; price: number }[] } | null = null;
  const entryPrice = clampPrice(input.currentPrice);
  for (const offset of TRAILING_OFFSETS) {
    const result = simulateTriggers({
      expr: trailingExpr(ref, "entry", offset),
      holdsForMs: 0, // the rebound IS the signal
      recurrence: { kind: "repeat", maxRepeats: 5, cooldownMs: 6 * 3_600_000 },
      action: {
        kind: "order",
        market: ref,
        side: "BUY",
        price: entryPrice,
        size: Math.round(STAKE_USD / entryPrice),
        orderType: "GTD",
        expiresAfterMs: 300_000,
        execution: "prepare",
      },
      series,
    });
    if (!result.supported || result.triggers.length === 0) continue;
    if (result.hypotheticalPnlUsd <= 0) continue;
    if (!best || result.hypotheticalPnlUsd > best.pnl) {
      best = {
        offset,
        pnl: result.hypotheticalPnlUsd,
        triggers: result.triggers.map((tr) => ({ t: tr.t, price: tr.price })),
      };
    }
  }
  return best;
};

export const buildScenariosFor = (
  input: ScenarioMarketInput,
  series: readonly { t: number; p: number }[],
  logger: ScenarioLogger,
  extras?: {
    rewards?: { ratePerDayUsd: number | null; minSize: number | null } | null;
    makerLoopEnabled?: boolean;
  },
): MarketScenario[] => {
  const ref: MarketRef = {
    conditionId: input.conditionId,
    tokenId: input.tokenId,
    outcome: input.outcome,
    title: input.title,
  };
  const out: MarketScenario[] = [];
  const shortTitle = input.title.slice(0, 80);

  const push = (scenario: MarketScenario): void => {
    const issues = validateStrategyDefinition(scenario.definition);
    if (issues.length > 0) {
      logger.warn(
        { conditionId: input.conditionId, kind: scenario.kind, issues: issues.map((i) => i.code) },
        "scenarios: dropped invalid definition",
      );
      return;
    }
    out.push(scenario);
  };

  const dip = bestTriggerScenario(input, ref, series, "dip_buy");
  if (dip) {
    push({
      id: `${input.conditionId}:dip:${Math.round(dip.threshold * 100)}`,
      kind: "dip_buy",
      label: "Buy the dip",
      sentence: `If ${input.outcome} dips below ${centsLabel(dip.threshold)} and holds 15 min → buy $${STAKE_USD} at ${centsLabel(dip.threshold)}`,
      prompt: `Buy $${STAKE_USD} of ${input.outcome} on "${shortTitle}" if the price dips to ${centsLabel(dip.threshold)} and holds for 15 minutes`,
      definition: makeDefinition(`Dip-buy: ${shortTitle}`, ref, "lte", dip.threshold),
      entryPriceCents: Math.round(dip.threshold * 100),
      stats: {
        stakeUsd: STAKE_USD,
        windowDays: WINDOW_DAYS,
        hypotheticalPnlUsd: Math.round(dip.pnl * 100) / 100,
        triggerCount: dip.triggers.length,
      },
      triggers: dip.triggers,
    });
  }

  const brk = bestTriggerScenario(input, ref, series, "breakout");
  if (brk) {
    push({
      id: `${input.conditionId}:brk:${Math.round(brk.threshold * 100)}`,
      kind: "breakout",
      label: "Ride the breakout",
      sentence: `If ${input.outcome} breaks above ${centsLabel(brk.threshold)} and holds 15 min → buy $${STAKE_USD} at ${centsLabel(brk.threshold)}`,
      prompt: `Buy $${STAKE_USD} of ${input.outcome} on "${shortTitle}" if the price breaks above ${centsLabel(brk.threshold)} and holds for 15 minutes`,
      definition: makeDefinition(`Breakout: ${shortTitle}`, ref, "gte", brk.threshold),
      entryPriceCents: Math.round(brk.threshold * 100),
      stats: {
        stakeUsd: STAKE_USD,
        windowDays: WINDOW_DAYS,
        hypotheticalPnlUsd: Math.round(brk.pnl * 100) / 100,
        triggerCount: brk.triggers.length,
      },
      triggers: brk.triggers,
    });
  }

  const trail = bestTrailingEntry(input, ref, series);
  if (trail) {
    const offsetCents = Math.round(trail.offset * 100);
    push({
      id: `${input.conditionId}:trail:${offsetCents}`,
      kind: "trailing_dip",
      label: "Trailing dip entry",
      sentence: `If ${input.outcome} rebounds ${offsetCents}¢ off any low → buy $${STAKE_USD} (armed from now)`,
      prompt: `Buy $${STAKE_USD} of ${input.outcome} on "${shortTitle}" when the price bounces ${offsetCents} cents off whatever low it hits`,
      definition: {
        version: 2,
        name: `Trailing dip: ${shortTitle}`.slice(0, 80),
        templateId: "scenario",
        expr: trailingExpr(ref, "entry", trail.offset),
        holdsForMs: 0,
        maxDataAgeMs: 5_000,
        action: {
          kind: "order",
          market: ref,
          side: "BUY",
          price: clampPrice(input.currentPrice),
          size: Math.round(STAKE_USD / clampPrice(input.currentPrice)),
          orderType: "GTD",
          expiresAfterMs: 300_000,
          execution: "prepare",
        },
        recurrence: { kind: "once" },
        limits: null,
        expiresAtMs: null,
      },
      entryPriceCents: Math.round(clampPrice(input.currentPrice) * 100),
      stats: {
        stakeUsd: STAKE_USD,
        windowDays: WINDOW_DAYS,
        hypotheticalPnlUsd: Math.round(trail.pnl * 100) / 100,
        triggerCount: trail.triggers.length,
      },
      triggers: trail.triggers,
    });
  }

  // "Save a dead bet": alert-framed by design — with no position context there
  // is no defensible PnL claim, only how often the stop would have spoken up.
  {
    const rescueSim = simulateTriggers({
      expr: trailingExpr(ref, "stop", RESCUE_OFFSET),
      holdsForMs: 0,
      recurrence: { kind: "repeat", maxRepeats: 5, cooldownMs: 6 * 3_600_000 },
      action: { kind: "alert" },
      series,
    });
    const offsetCents = Math.round(RESCUE_OFFSET * 100);
    push({
      id: `${input.conditionId}:rescue:${offsetCents}`,
      kind: "rescue_exit",
      label: "Save a dead bet",
      sentence: `Alert when ${input.outcome} slips ${offsetCents}¢ from its peak — then decide`,
      prompt: `Alert me if ${input.outcome} on "${shortTitle}" drops ${offsetCents} cents from its high, so I can rescue what's left of my position`,
      definition: {
        version: 2,
        name: `Trailing stop alert: ${shortTitle}`.slice(0, 80),
        templateId: "scenario",
        expr: trailingExpr(ref, "stop", RESCUE_OFFSET),
        holdsForMs: 0,
        maxDataAgeMs: 5_000,
        action: { kind: "alert" },
        recurrence: { kind: "once" },
        limits: null,
        expiresAtMs: null,
      },
      entryPriceCents: Math.round(clampPrice(input.currentPrice) * 100),
      stats: {
        stakeUsd: 0,
        windowDays: WINDOW_DAYS,
        ...(rescueSim.supported ? { triggerCount: rescueSim.triggers.length } : {}),
      },
      triggers: rescueSim.supported
        ? rescueSim.triggers.map((tr) => ({ t: tr.t, price: tr.price }))
        : [],
    });
  }

  // Rewards farming — only when this market carries a live rewards pool.
  const rewards = extras?.rewards;
  if (rewards && rewards.ratePerDayUsd !== null && rewards.ratePerDayUsd > 0) {
    const makerSpec = templateSpecById("maker-reward");
    if (makerSpec) {
      push({
        id: `${input.conditionId}:farm`,
        kind: "farm_rewards",
        label: "Farm the rewards pool",
        sentence: `This market pays ≈$${Math.round(rewards.ratePerDayUsd)}/day to makers — rest a qualifying quote to earn a share`,
        prompt: `When the spread on "${shortTitle}" tightens, prepare a maker quote that qualifies for the rewards pool`,
        definition: makerSpec.buildDefinition(ref),
        entryPriceCents: Math.round(clampPrice(input.currentPrice) * 100),
        stats: {
          stakeUsd: 0,
          windowDays: WINDOW_DAYS,
          rewardsPerDayUsd: Math.round(rewards.ratePerDayUsd * 100) / 100,
        },
        triggers: [],
        ...(extras?.makerLoopEnabled
          ? {
              link: {
                label: "Set up in the farming cockpit",
                href: `/farming?conditionId=${encodeURIComponent(input.conditionId)}`,
              },
            }
          : {}),
      });
    }
  }

  const quartile = clampPrice(lowerQuartile(series));
  if (Number.isFinite(quartile) && quartile >= 0.05 && quartile < clampPrice(input.currentPrice)) {
    const touches = series.filter((s) => s.p <= quartile).length;
    push({
      id: `${input.conditionId}:lim:${Math.round(quartile * 100)}`,
      kind: "limit_entry",
      label: "Patient limit entry",
      sentence: `Rest a buy at ${centsLabel(quartile)} (30-day value zone) → buy $${STAKE_USD} if it fills`,
      prompt: `Set a patient buy of $${STAKE_USD} ${input.outcome} on "${shortTitle}" at ${centsLabel(quartile)} in case the price comes back down`,
      definition: makeDefinition(`Patient entry: ${shortTitle}`, ref, "lte", quartile),
      entryPriceCents: Math.round(quartile * 100),
      stats: { stakeUsd: STAKE_USD, windowDays: WINDOW_DAYS, touches },
      triggers: [],
    });
  }

  // Winners first (by hypothetical PnL); the position-protection and farming
  // cards keep a stable late position rather than competing on PnL claims.
  const rank = (s: MarketScenario): number =>
    s.stats.hypotheticalPnlUsd !== undefined
      ? s.stats.hypotheticalPnlUsd
      : s.kind === "rescue_exit"
        ? -1
        : s.kind === "farm_rewards"
          ? -2
          : -3;
  out.sort((a, b) => rank(b) - rank(a));
  return out.slice(0, MAX_SCENARIOS);
};

// ── Per-market cache (single process per D-001) ──────────────────────────────

interface CacheEntry {
  data: ScenariosResponse;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ScenariosResponse>>();

/** Test hook. */
export const resetScenarioCache = (): void => {
  cache.clear();
  inflight.clear();
};

const evictIfNeeded = (): void => {
  if (cache.size <= CACHE_MAX_MARKETS) return;
  // Drop the oldest entries (Map preserves insertion order; re-inserts refresh it).
  const excess = cache.size - CACHE_MAX_MARKETS;
  let dropped = 0;
  for (const key of cache.keys()) {
    if (dropped >= excess) break;
    cache.delete(key);
    dropped++;
  }
};

const refresh = async (
  deps: ScenariosDeps,
  input: ScenarioMarketInput,
  logger: ScenarioLogger,
): Promise<ScenariosResponse> => {
  const history = await deps.clobClient.getPricesHistory({
    tokenId: input.tokenId,
    interval: "1m",
  });
  if (!history.ok) throw new Error(`scenarios: history fetch failed (${history.error.code})`);
  // Rewards lookup is best-effort: a failure only drops the farm card.
  const rewards = deps.getRewards
    ? await deps.getRewards(input.conditionId).catch(() => null)
    : null;
  const scenarios =
    history.value.length < 2
      ? []
      : buildScenariosFor(input, history.value, logger, {
          rewards,
          makerLoopEnabled: deps.makerLoopEnabled ?? false,
        });
  return {
    conditionId: input.conditionId,
    outcome: input.outcome,
    generatedAt: new Date().toISOString(),
    scenarios,
  };
};

export const getMarketScenarios = async (
  deps: ScenariosDeps,
  input: ScenarioMarketInput,
  logger: ScenarioLogger,
): Promise<ScenariosResponse> => {
  const key = `${input.conditionId}:${input.tokenId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  let pending = inflight.get(key);
  if (!pending) {
    pending = refresh(deps, input, logger)
      .then((data) => {
        cache.delete(key); // refresh insertion order for the LRU-ish eviction
        cache.set(key, { data, fetchedAt: Date.now() });
        evictIfNeeded();
        return data;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
  }
  try {
    return await pending;
  } catch (err) {
    if (cached) {
      logger.warn({ err }, "scenarios: refresh failed, serving stale cache");
      return cached.data;
    }
    throw err;
  }
};
