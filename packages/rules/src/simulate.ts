/**
 * Historical trigger simulation ("would this have fired?") against CLOB
 * trade-price history. Deliberately narrow and honestly labeled: only
 * price + time_window conditions on a SINGLE market are simulatable from a
 * price series — books, liquidity, spread and freshness rules are not.
 * Everything is a hypothetical estimate; past prices don't predict future
 * prices.
 */
import type { ActionV2, ConditionV2, ExprNode, RecurrenceV2 } from "./types-v2.js";

export interface PricePoint {
  t: number; // unix seconds or ms
  p: number;
}

export interface BacktestTrigger {
  /** Trigger time (unix ms). */
  t: number;
  /** Sample price at trigger time. */
  price: number;
}

export type BacktestResult =
  | {
      supported: false;
      reason: "unsupported_conditions" | "multi_market" | "no_price_conditions" | "no_data";
    }
  | {
      supported: true;
      triggers: BacktestTrigger[];
      /** Sum over triggers of entry→final mark-to-market (USD). */
      hypotheticalPnlUsd: number;
      finalPrice: number;
      sampleCount: number;
    };

const leavesOf = (node: ExprNode): ConditionV2[] =>
  node.type === "condition" ? [node.condition] : node.children.flatMap(leavesOf);

type Analysis =
  | { ok: true; tokenId: string }
  | { ok: false; reason: "unsupported_conditions" | "multi_market" | "no_price_conditions" };

const analyse = (expr: ExprNode): Analysis => {
  const tokenIds = new Set<string>();
  let priceLeaves = 0;
  for (const c of leavesOf(expr)) {
    if (c.kind === "time_window") continue;
    if (c.kind !== "price") return { ok: false, reason: "unsupported_conditions" };
    if (c.market.tokenId === "") return { ok: false, reason: "no_price_conditions" };
    tokenIds.add(c.market.tokenId);
    priceLeaves += 1;
  }
  if (priceLeaves === 0) return { ok: false, reason: "no_price_conditions" };
  if (tokenIds.size > 1) return { ok: false, reason: "multi_market" };
  return { ok: true, tokenId: [...tokenIds][0]! };
};

/** The single token a strategy can be backtested on, or null when it can't. */
export const backtestTokenId = (expr: ExprNode): string | null => {
  const a = analyse(expr);
  return a.ok ? a.tokenId : null;
};

const toMs = (t: number): number => (t < 1e12 ? t * 1000 : t);

/**
 * Evaluate the expression against one price sample. The trade price stands in
 * for both bid and ask (approximation — disclaimed in the UI); time_window
 * checks the sample's own timestamp.
 */
const sampleSatisfies = (node: ExprNode, price: number, tMs: number): boolean => {
  if (node.type === "condition") {
    const c = node.condition;
    if (c.kind === "time_window") {
      return (c.startMs === null || tMs >= c.startMs) && (c.endMs === null || tMs <= c.endMs);
    }
    if (c.kind === "price") {
      return c.comparator === "lte" ? price <= c.threshold : price >= c.threshold;
    }
    return false; // unreachable for supported strategies (analyse() gates)
  }
  if (node.op === "not") {
    const child = node.children[0];
    return child ? !sampleSatisfies(child, price, tMs) : false;
  }
  if (node.children.length === 0) return false;
  return node.op === "and"
    ? node.children.every((c) => sampleSatisfies(c, price, tMs))
    : node.children.some((c) => sampleSatisfies(c, price, tMs));
};

export const simulateTriggers = (opts: {
  expr: ExprNode;
  holdsForMs: number;
  recurrence: RecurrenceV2;
  action: ActionV2;
  series: readonly PricePoint[];
}): BacktestResult => {
  const a = analyse(opts.expr);
  if (!a.ok) return { supported: false, reason: a.reason };
  if (opts.series.length < 2) return { supported: false, reason: "no_data" };

  const samples = opts.series.map((s) => ({ t: toMs(s.t), p: s.p })).sort((x, y) => x.t - y.t);

  // Continuity guard: a hole in the series (median-gap outlier) breaks the
  // "held continuously" window rather than silently bridging it.
  const gaps = samples.slice(1).map((s, i) => s.t - samples[i]!.t);
  const medianGap = [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? 0;
  const maxBridgeMs = Math.max(medianGap * 4, 60_000);

  const maxRepeats = opts.recurrence.kind === "repeat" ? opts.recurrence.maxRepeats : 1;
  const cooldownMs = opts.recurrence.kind === "repeat" ? opts.recurrence.cooldownMs : 0;

  const triggers: BacktestTrigger[] = [];
  let satisfiedSince: number | null = null;
  let cooldownUntil = -Infinity;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.t < cooldownUntil) {
      satisfiedSince = null;
      continue;
    }
    const prev = samples[i - 1];
    if (prev && s.t - prev.t > maxBridgeMs) satisfiedSince = null;

    if (!sampleSatisfies(opts.expr, s.p, s.t)) {
      satisfiedSince = null;
      continue;
    }
    if (satisfiedSince === null) satisfiedSince = s.t;
    if (s.t - satisfiedSince >= opts.holdsForMs) {
      triggers.push({ t: s.t, price: s.p });
      if (triggers.length >= maxRepeats) break;
      cooldownUntil = s.t + cooldownMs;
      satisfiedSince = null;
    }
  }

  const finalPrice = samples[samples.length - 1]!.p;

  // Mark each hypothetical entry to the series' final price. Orders enter at
  // the limit price with the order's share size; alert strategies model a
  // $100 buy at the trigger-time price.
  let pnl = 0;
  const action = opts.action;
  for (const trig of triggers) {
    let entry: number;
    let shares: number;
    let side: "BUY" | "SELL";
    if (action.kind === "order") {
      entry = action.price;
      shares = action.size;
      side = action.side;
    } else {
      entry = trig.price;
      shares = entry > 0 ? 100 / entry : 0;
      side = "BUY";
    }
    pnl += side === "BUY" ? (finalPrice - entry) * shares : (entry - finalPrice) * shares;
  }

  return {
    supported: true,
    triggers,
    hypotheticalPnlUsd: pnl,
    finalPrice,
    sampleCount: samples.length,
  };
};
