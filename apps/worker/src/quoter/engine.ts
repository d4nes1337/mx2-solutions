import { createHash } from "node:crypto";
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
  /** Cumulative filled size last seen from the venue (fill-delta baseline). */
  readonly sizeMatched?: number;
}

export type IdleReason = "gate_unsatisfied" | "no_book" | "stale_book" | "mid_out_of_range";

export type DesiredQuotes =
  | {
      readonly kind: "quote";
      readonly yesBid: QuoteIntent;
      readonly noBid: QuoteIntent;
      readonly mid: number;
    }
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
    yesBid: {
      tokenId: params.market.yesTokenId,
      side: "BUY",
      price: yesPrice,
      size: params.sizeShares,
    },
    noBid: {
      tokenId: params.market.noTokenId,
      side: "BUY",
      price: noPrice,
      size: params.sizeShares,
    },
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

// ── Confirm-mode batch protocol (RFC-0003 checkpoint 3) ─────────────────────

/** One cycle's worth of side effects, as data — what confirm mode approves. */
export interface ProposedBatch {
  readonly cancels: readonly RestingQuote[];
  readonly places: readonly QuoteIntent[];
  readonly mergePairs: number;
}

/** JSON with recursively sorted object keys — a canonical byte encoding. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * Deterministic identity of a proposed batch: sha256 over canonical JSON.
 * The worker executes an approved batch ONLY when the hash it recomputes from
 * the CURRENT book still equals the approved hash — a moved market changes
 * the batch, changes the hash, and structurally voids the stale approval.
 */
export const computeBatchHash = (batch: ProposedBatch): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        cancels: batch.cancels.map((c) => ({
          tokenId: c.tokenId,
          orderId: c.orderId,
          price: c.price,
          size: c.size,
        })),
        places: batch.places.map((p) => ({ tokenId: p.tokenId, price: p.price, size: p.size })),
        mergePairs: batch.mergePairs,
      }),
    )
    .digest("hex");

// ── Fill detection from open-order polling (R-032) ──────────────────────────

export interface Fill {
  readonly orderId: string;
  readonly tokenId: string;
  readonly price: number;
  /** Newly-filled size since the last poll (the delta, not the cumulative). */
  readonly sizeFilled: number;
  /** Venue-cumulative matched size after this fill (idempotency key input). */
  readonly cumulativeMatched: number;
}

export interface VenueOpenOrder {
  readonly orderId: string;
  readonly tokenId: string;
  readonly price: number;
  readonly originalSize: number;
  readonly sizeMatched: number;
}

export interface OpenOrderDiff {
  readonly fills: readonly Fill[];
  /** The reconciled resting set (updated baselines; vanished orders removed). */
  readonly resting: readonly RestingQuote[];
  /** Venue orders on loop tokens we didn't know about (restart) — adopted. */
  readonly adopted: readonly RestingQuote[];
}

/**
 * Reconcile our resting view against the venue's open orders (no user WS in
 * MVP — this is the polling fallback):
 *  - matched order with a higher size_matched → a fill for the delta;
 *  - VANISHED order → approximated as filled for the remainder (could also be
 *    an external cancel — the over-count errs toward the inventory cap, i.e.
 *    fail-closed; logged as R-032);
 *  - venue order we don't know (worker restart) → adopted with its current
 *    size_matched as the fill baseline, so pre-restart fills are not
 *    double-counted.
 */
export const diffOpenOrders = (
  resting: readonly RestingQuote[],
  venueOrders: readonly VenueOpenOrder[],
  loopTokenIds: readonly string[],
): OpenOrderDiff => {
  const fills: Fill[] = [];
  const next: RestingQuote[] = [];
  const byId = new Map(venueOrders.map((o) => [o.orderId, o]));
  const known = new Set<string>();

  for (const quote of resting) {
    if (quote.orderId === null) {
      next.push(quote); // shadow/virtual — nothing to reconcile
      continue;
    }
    known.add(quote.orderId);
    const venue = byId.get(quote.orderId);
    const baseline = quote.sizeMatched ?? 0;
    if (!venue) {
      // Vanished: treat the remainder as filled (R-032 approximation).
      const remainder = quote.size - baseline;
      if (remainder > 1e-9) {
        fills.push({
          orderId: quote.orderId,
          tokenId: quote.tokenId,
          price: quote.price,
          sizeFilled: remainder,
          cumulativeMatched: quote.size,
        });
      }
      continue; // no longer resting
    }
    if (venue.sizeMatched > baseline + 1e-9) {
      fills.push({
        orderId: quote.orderId,
        tokenId: quote.tokenId,
        price: quote.price,
        sizeFilled: venue.sizeMatched - baseline,
        cumulativeMatched: venue.sizeMatched,
      });
    }
    if (venue.sizeMatched >= venue.originalSize - 1e-9) continue; // fully filled
    next.push({ ...quote, sizeMatched: venue.sizeMatched });
  }

  const adopted: RestingQuote[] = [];
  for (const venue of venueOrders) {
    if (known.has(venue.orderId)) continue;
    if (!loopTokenIds.includes(venue.tokenId)) continue;
    if (venue.sizeMatched >= venue.originalSize - 1e-9) continue;
    const quote: RestingQuote = {
      tokenId: venue.tokenId,
      side: "BUY",
      price: venue.price,
      size: venue.originalSize,
      orderId: venue.orderId,
      sizeMatched: venue.sizeMatched,
    };
    adopted.push(quote);
    next.push(quote);
  }

  return { fills, resting: next, adopted };
};
