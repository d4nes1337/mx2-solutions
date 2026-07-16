/**
 * Historical trigger simulation ("would this have fired?") against CLOB
 * trade-price history. Deliberately narrow and honestly labeled: only
 * price + price_move + trailing + time_window conditions on a SINGLE market
 * are simulatable from a price series — books, liquidity, spread and freshness
 * rules are not. Everything is a hypothetical estimate; past prices don't
 * predict future prices.
 */
import { conditionLeaves } from "./compat.js";
import { takerFeeUsd, type FeeSchedule } from "./fees.js";
import type {
  ActionV2,
  ConditionV2,
  ExprNode,
  PriceMoveConditionV2,
  RecurrenceV2,
} from "./types-v2.js";

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
      reason:
        | "unsupported_conditions"
        | "multi_market"
        | "no_price_conditions"
        | "no_data"
        | "window_too_fine";
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
    if (c.kind !== "price" && c.kind !== "price_move" && c.kind !== "trailing")
      return { ok: false, reason: "unsupported_conditions" };
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

/** Per-sample rolling movement for one price_move leaf (null = no coverage). */
type MoveAt = (c: PriceMoveConditionV2, sampleIdx: number) => { drop: number; rise: number } | null;

/**
 * Precompute, for one price_move condition, the trailing-window drop/rise at
 * every sample: two pointers + monotonic deques (O(n)). Coverage mirrors the
 * live predicate: a carry-in sample at/before the window start is required.
 */
const rollingMoves = (
  samples: readonly { t: number; p: number }[],
  windowMs: number,
): ({ drop: number; rise: number } | null)[] => {
  const out: ({ drop: number; rise: number } | null)[] = new Array(samples.length).fill(null);
  const maxDq: number[] = []; // indices, prices non-increasing
  const minDq: number[] = []; // indices, prices non-decreasing
  let head = 0; // first index inside the window
  let carry: number | null = null; // price of the last sample at/before start

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const start = s.t - windowMs;

    while (maxDq.length > 0 && samples[maxDq[maxDq.length - 1]!]!.p <= s.p) maxDq.pop();
    maxDq.push(i);
    while (minDq.length > 0 && samples[minDq[minDq.length - 1]!]!.p >= s.p) minDq.pop();
    minDq.push(i);

    while (head <= i && samples[head]!.t <= start) {
      carry = samples[head]!.p;
      head++;
    }
    while (maxDq.length > 0 && maxDq[0]! < head) maxDq.shift();
    while (minDq.length > 0 && minDq[0]! < head) minDq.shift();

    if (carry === null) continue; // window not fully covered yet
    const max = Math.max(carry, maxDq.length > 0 ? samples[maxDq[0]!]!.p : -Infinity);
    const min = Math.min(carry, minDq.length > 0 ? samples[minDq[0]!]!.p : Infinity);
    out[i] = { drop: max - s.p, rise: s.p - min };
  }
  return out;
};

/** Trailing watermark for one node id (undefined = not armed yet). */
type TrailingAt = (nodeId: string) => number | undefined;

/**
 * Evaluate the expression against one price sample. The trade price stands in
 * for both bid and ask (approximation — disclaimed in the UI); time_window
 * checks the sample's own timestamp; price_move reads the precomputed rolling
 * window (no coverage → unsatisfied, matching the fail-closed live engine);
 * trailing reads the watermark the caller ratcheted with THIS sample first
 * (update-then-check, so the arming sample can never satisfy).
 */
const sampleSatisfies = (
  node: ExprNode,
  price: number,
  tMs: number,
  sampleIdx: number,
  moveAt: MoveAt,
  trailingAt: TrailingAt,
): boolean => {
  if (node.type === "condition") {
    const c = node.condition;
    if (c.kind === "time_window") {
      return (c.startMs === null || tMs >= c.startMs) && (c.endMs === null || tMs <= c.endMs);
    }
    if (c.kind === "price") {
      return c.comparator === "lte" ? price <= c.threshold : price >= c.threshold;
    }
    if (c.kind === "price_move") {
      const m = moveAt(c, sampleIdx);
      if (m === null) return false;
      const actual =
        c.direction === "drop"
          ? m.drop
          : c.direction === "rise"
            ? m.rise
            : Math.max(m.drop, m.rise);
      return actual >= c.deltaThreshold;
    }
    if (c.kind === "trailing") {
      const wm = trailingAt(node.id);
      if (wm === undefined) return false; // arming
      // Same float tolerance as the live evaluator (TRAILING_EPS).
      return c.mode === "stop" ? price <= wm - c.offset + 1e-9 : price >= wm + c.offset - 1e-9;
    }
    return false; // unreachable for supported strategies (analyse() gates)
  }
  if (node.op === "not") {
    const child = node.children[0];
    return child ? !sampleSatisfies(child, price, tMs, sampleIdx, moveAt, trailingAt) : false;
  }
  if (node.children.length === 0) return false;
  return node.op === "and"
    ? node.children.every((c) => sampleSatisfies(c, price, tMs, sampleIdx, moveAt, trailingAt))
    : node.children.some((c) => sampleSatisfies(c, price, tMs, sampleIdx, moveAt, trailingAt));
};

export const simulateTriggers = (opts: {
  expr: ExprNode;
  holdsForMs: number;
  recurrence: RecurrenceV2;
  action: ActionV2;
  series: readonly PricePoint[];
  /**
   * Market fee schedule: taker entries (FOK/FAK orders) pay the taker fee per
   * hypothetical fill. Omitted/null = fees unknown and NOT modeled (the UI
   * discloses this) — maker entries pay nothing either way.
   */
  feeSchedule?: FeeSchedule | null;
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

  // price_move honesty guard: a lookback finer than ~2 samples can't be
  // simulated from this series' resolution — refuse rather than fake it.
  const moveLeaves = leavesOf(opts.expr).filter(
    (c): c is PriceMoveConditionV2 => c.kind === "price_move",
  );
  if (moveLeaves.some((c) => medianGap > c.windowMs / 2)) {
    return { supported: false, reason: "window_too_fine" };
  }
  const movesByWindow = new Map<number, ({ drop: number; rise: number } | null)[]>();
  for (const c of moveLeaves) {
    if (!movesByWindow.has(c.windowMs))
      movesByWindow.set(c.windowMs, rollingMoves(samples, c.windowMs));
  }
  const moveAt: MoveAt = (c, i) => movesByWindow.get(c.windowMs)?.[i] ?? null;

  const maxRepeats = opts.recurrence.kind === "repeat" ? opts.recurrence.maxRepeats : 1;
  const cooldownMs = opts.recurrence.kind === "repeat" ? opts.recurrence.cooldownMs : 0;

  // Trailing watermarks, keyed by node id. Live-parity semantics: arm at the
  // first evaluated sample (disclosed as "armed at the window start" in UI
  // copy), ratchet before checking, freeze through gaps and cooldowns, clear
  // on trigger so each repetition trails from scratch.
  const trailingLeaves = conditionLeaves(opts.expr).filter(
    (l) => l.condition.kind === "trailing",
  ) as readonly { id: string; condition: Extract<ConditionV2, { kind: "trailing" }> }[];
  const trailingWm = new Map<string, number>();
  const trailingAt: TrailingAt = (nodeId) => trailingWm.get(nodeId);

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

    for (const { id, condition } of trailingLeaves) {
      const wm = trailingWm.get(id);
      trailingWm.set(
        id,
        wm === undefined ? s.p : condition.mode === "stop" ? Math.max(wm, s.p) : Math.min(wm, s.p),
      );
    }

    if (!sampleSatisfies(opts.expr, s.p, s.t, i, moveAt, trailingAt)) {
      satisfiedSince = null;
      continue;
    }
    if (satisfiedSince === null) satisfiedSince = s.t;
    if (s.t - satisfiedSince >= opts.holdsForMs) {
      triggers.push({ t: s.t, price: s.p });
      if (triggers.length >= maxRepeats) break;
      cooldownUntil = s.t + cooldownMs;
      satisfiedSince = null;
      trailingWm.clear();
    }
  }

  const finalPrice = samples[samples.length - 1]!.p;

  // Mark each hypothetical entry to the series' final price. Orders enter at
  // the limit price with the order's share size; alert strategies model a
  // $100 buy at the trigger-time price. Taker-style orders (FOK/FAK) also pay
  // the market's taker fee per entry when the schedule is known.
  let pnl = 0;
  const action = opts.action;
  const takerEntry =
    action.kind === "order" && (action.orderType === "FOK" || action.orderType === "FAK");
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
    if (takerEntry && opts.feeSchedule) pnl -= takerFeeUsd(shares, entry, opts.feeSchedule);
  }

  return {
    supported: true,
    triggers,
    hypotheticalPnlUsd: pnl,
    finalPrice,
    sampleCount: samples.length,
  };
};
