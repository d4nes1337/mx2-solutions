/**
 * Forward payoff projection (estimator-first, same stance as the maker
 * estimator): deterministic binary-outcome math from the strategy's order —
 * or from a hypothetical $100 stake when the strategy only alerts. Estimates
 * only: fees and partial fills are not modeled, and nothing here predicts
 * how likely an outcome is.
 */
import { conditionLeavesOf, isBound, type StrategyDoc } from "./doc";
import type { MarketFreshness } from "./queries";

export const HYPOTHETICAL_STAKE_USD = 100;

export interface PayoffInput {
  side: "BUY" | "SELL";
  /** Entry (limit) price as a probability 0–1. */
  price: number;
  /** Share count — Polymarket order size is shares, not USD. */
  size: number;
  tokenId: string;
  /** Display label of the held outcome (e.g. "Yes"). */
  outcome: string;
  /** Live mid price when known (mark-to-market), else null. */
  currentPrice: number | null;
  /** True when derived from a $100 stake on an alert-only strategy. */
  hypothetical: boolean;
}

export interface PayoffProjection {
  /** Capital committed: BUY price·size; SELL locks (1−price)·size collateral. */
  costUsd: number;
  shares: number;
  /** PnL if the held outcome token resolves to $1. */
  payoffIfWinUsd: number;
  /** PnL if it resolves to $0. */
  payoffIfLoseUsd: number;
  breakevenPrice: number;
  /** PnL marked at the current price, when known. */
  markToMarketUsd: number | null;
  /** Exit-value curve: t = market price (0–1), v = PnL in USD. */
  curve: { t: number; v: number }[];
  notes: string[];
}

const pnlAt = (input: PayoffInput, p: number): number =>
  input.side === "BUY" ? (p - input.price) * input.size : (input.price - p) * input.size;

export const computePayoff = (input: PayoffInput): PayoffProjection => {
  const { side, price, size } = input;
  const costUsd = side === "BUY" ? price * size : (1 - price) * size;

  const curve: { t: number; v: number }[] = [];
  for (let cents = 1; cents <= 99; cents += 2) {
    const p = cents / 100;
    curve.push({ t: p, v: pnlAt(input, p) });
  }

  const notes: string[] = [
    "Assumes the order fills completely at your limit price; fees and slippage are not modeled.",
    "An estimate, not a promise — nothing here predicts how likely an outcome is.",
  ];
  if (input.hypothetical) {
    notes.unshift(
      `This strategy only alerts — numbers model a hypothetical $${HYPOTHETICAL_STAKE_USD} buy at the trigger price.`,
    );
  }

  return {
    costUsd,
    shares: size,
    payoffIfWinUsd: pnlAt(input, 1),
    payoffIfLoseUsd: pnlAt(input, 0),
    breakevenPrice: price,
    markToMarketUsd: input.currentPrice === null ? null : pnlAt(input, input.currentPrice),
    curve,
    notes,
  };
};

const midOf = (m: MarketFreshness | undefined): number | null => {
  if (!m) return null;
  if (m.bestBid !== null && m.bestAsk !== null) return (m.bestBid + m.bestAsk) / 2;
  return m.bestBid ?? m.bestAsk ?? null;
};

/**
 * Derive what to project from the doc: the order action when there is one,
 * else a hypothetical $100 buy at the first bound price condition's threshold.
 * Null = nothing projectable (the card hides itself).
 */
export const payoffInputFromDoc = (
  doc: StrategyDoc,
  markets: readonly MarketFreshness[],
): PayoffInput | null => {
  if (doc.action.kind === "order" && isBound(doc.action.market)) {
    const a = doc.action;
    if (!(a.price > 0 && a.price < 1) || !(a.size > 0)) return null;
    return {
      side: a.side,
      price: a.price,
      size: a.size,
      tokenId: a.market.tokenId,
      outcome: a.market.outcome,
      currentPrice: midOf(markets.find((m) => m.tokenId === a.market.tokenId)),
      hypothetical: false,
    };
  }

  for (const { condition } of conditionLeavesOf(doc.expr)) {
    if (condition.kind !== "price") continue;
    if (!isBound(condition.market)) continue;
    const threshold = condition.threshold;
    if (!(threshold > 0.01 && threshold < 1)) continue;
    return {
      side: "BUY",
      price: threshold,
      size: HYPOTHETICAL_STAKE_USD / threshold,
      tokenId: condition.market.tokenId,
      outcome: condition.market.outcome,
      currentPrice: midOf(markets.find((m) => m.tokenId === condition.market.tokenId)),
      hypothetical: true,
    };
  }

  return null;
};
