import type { MarketDataView, QuoteLoopAction, TickSize } from "@mx2/rules";

/**
 * Pure maker-loop quoting math (RFC-0003, ADR-0014). No I/O, no clocks, no
 * randomness: every function is a deterministic map from (book, params,
 * state) → intents, so the whole anti-runaway story is testable as data.
 *
 * The core invariant (property-tested): diffQuotes(desired-as-resting,
 * desired) = no-ops. If that ever breaks the loop would cancel/replace
 * forever — the classic quoting-bot failure mode.
 */

export interface QuoteIntent {
  readonly tokenId: string;
  /** Both sides are BIDS: a NO bid is a YES ask in the unified book. */
  readonly side: "BUY";
  /** Probability price, tick-rounded down (passive). */
  readonly price: number;
  readonly size: number;
}

export interface RestingQuote extends QuoteIntent {
  /** CLOB order id (null for shadow-mode virtual quotes). */
  readonly orderId: string | null;
}

export type IdleReason = "gate_unsatisfied" | "no_book" | "stale_book" | "mid_out_of_range";

export type DesiredQuotes =
  | { readonly kind: "quote"; readonly yesBid: QuoteIntent; readonly noBid: QuoteIntent; readonly mid: number }
  | { readonly kind: "idle"; readonly reason: IdleReason };

const tickOf = (tickSize: TickSize | undefined): number => Number(tickSize ?? "0.01");

/** Round DOWN to the tick (bids stay passive; never round toward the mid). */
export const roundDownToTick = (price: number, tickSize: TickSize | undefined): number => {
  const tick = tickOf(tickSize);
  return Math.max(tick, Math.floor(price / tick + 1e-9) * tick);
};

/**
 * The two-sided quote set for the current YES book: a YES bid at mid − s and
 * a NO bid at (1 − mid) − s. Pair cost = 1 − 2s < 1, so simultaneous fills
 * merge back to $1 of collateral at a profit of 2s per pair (minus nothing —
 * makers pay no fee).
 */
export const computeDesiredQuotes = (
  params: QuoteLoopAction,
  yesView: MarketDataView | undefined,
  nowMs: number,
  maxDataAgeMs: number,
): DesiredQuotes => {
  if (!yesView) return { kind: "idle", reason: "no_book" };
  if (nowMs - yesView.sourceTimeMs > maxDataAgeMs) return { kind: "idle", reason: "stale_book" };
  const bestBid = yesView.bids[0]?.price;
  const bestAsk = yesView.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) return { kind: "idle", reason: "no_book" };

  const mid = (bestBid + bestAsk) / 2;
  const s = params.targetSpreadCents / 100;
  const tick = params.market.tickSize;
  const yesPrice = roundDownToTick(mid - s, tick);
  const noPrice = roundDownToTick(1 - mid - s, tick);
  // Both quotes must be sane resting bids; near the extremes one side would
  // pin at the tick floor and the pair would stop being delta-neutral.
  if (yesPrice <= 0.01 || noPrice <= 0.01 || yesPrice >= 0.99 || noPrice >= 0.99) {
    return { kind: "idle", reason: "mid_out_of_range" };
  }
  return {
    kind: "quote",
    mid,
    yesBid: { tokenId: params.market.yesTokenId, side: "BUY", price: yesPrice, size: params.sizeShares },
    noBid: { tokenId: params.market.noTokenId, side: "BUY", price: noPrice, size: params.sizeShares },
  };
};

export interface QuoteDiff {
  readonly cancels: readonly RestingQuote[];
  readonly places: readonly QuoteIntent[];
}

/**
 * Reconcile resting quotes toward the desired set. A resting quote survives
 * only if it is on the right token, within tolerance of the desired price and
 * exactly the desired size; anything else is cancelled (and re-placed when a
 * desired quote exists for that token). Duplicate quotes on one token keep
 * the best match and cancel the rest.
 */
export const diffQuotes = (
  resting: readonly RestingQuote[],
  desired: DesiredQuotes,
  requoteToleranceCents: number,
): QuoteDiff => {
  if (desired.kind === "idle") {
    return { cancels: resting, places: [] };
  }
  const tolerance = requoteToleranceCents / 100 + 1e-9;
  const cancels: RestingQuote[] = [];
  const places: QuoteIntent[] = [];

  for (const want of [desired.yesBid, desired.noBid]) {
    const candidates = resting.filter((r) => r.tokenId === want.tokenId);
    const keeper = candidates.find(
      (r) => Math.abs(r.price - want.price) <= tolerance && Math.abs(r.size - want.size) < 1e-9,
    );
    for (const r of candidates) if (r !== keeper) cancels.push(r);
    if (!keeper) places.push(want);
  }
  // Quotes on tokens we no longer want at all.
  for (const r of resting) {
    if (r.tokenId !== desired.yesBid.tokenId && r.tokenId !== desired.noBid.tokenId) {
      cancels.push(r);
    }
  }
  return { cancels, places };
};

export type Breach = "inventory" | "capital" | "daily_loss";

export interface InventoryPlan {
  /** Whole YES+NO pairs ready to merge back to collateral. */
  readonly mergePairs: number;
  /** |YES − NO| exposure after merging. */
  readonly netInventoryShares: number;
  readonly breach: Breach | null;
}

/**
 * Inventory management: merge whole pairs once at least a quarter-quote of
 * pairs accumulated (avoids spamming the relayer with dust), and flag a
 * breach when one-sided exposure exceeds the cap.
 */
export const inventoryPlan = (
  inventoryYes: number,
  inventoryNo: number,
  params: QuoteLoopAction,
): InventoryPlan => {
  const pairs = Math.floor(Math.min(inventoryYes, inventoryNo));
  const mergeThreshold = Math.max(1, Math.floor(params.sizeShares / 4));
  const mergePairs = pairs >= mergeThreshold ? pairs : 0;
  const net = Math.abs(inventoryYes - inventoryNo);
  return {
    mergePairs,
    netInventoryShares: net,
    breach: net > params.maxInventoryShares ? "inventory" : null,
  };
};

/**
 * Capital committed right now: resting bid notional plus inventory marked at
 * the mid (NO inventory marks at 1 − mid).
 */
export const capitalCommittedUsd = (
  resting: readonly RestingQuote[],
  inventoryYes: number,
  inventoryNo: number,
  mid: number | null,
): number => {
  const restingUsd = resting.reduce((sum, r) => sum + r.price * r.size, 0);
  const m = mid ?? 0.5;
  return restingUsd + inventoryYes * m + inventoryNo * (1 - m);
};

/** Hard-cap check, evaluated every cycle BEFORE placing anything new. */
export const capBreach = (
  committedUsd: number,
  dailyLossUsd: number,
  params: QuoteLoopAction,
): Breach | null => {
  if (dailyLossUsd > params.maxDailyLossUsd) return "daily_loss";
  if (committedUsd > params.maxCapitalUsd) return "capital";
  return null;
};
