/**
 * Rolling series bindings (ADR-0028) — the pure half.
 *
 * A rolling order re-targets a recurring market ("BTC Up or Down 5m") every
 * time it fires. Everything I/O-shaped (resolving which window is live) lives
 * in the worker; this module holds the decisions, so they stay deterministic
 * and testable: does the resolved window pass the guards, what concrete order
 * do we prepare, and what happens to the repeat budget when we skip.
 */
import { takerFeeUsd, type FeeSchedule } from "./fees.js";
import { SERIES_DEFAULT_MIN_REMAINING_MS } from "./types-v2.js";
import type { MarketRef, OrderActionV2, SeriesRef, StrategyRuntime } from "./types-v2.js";

/** A window resolved from upstream, reduced to what the guards actually read. */
export interface ResolvedSeriesWindow {
  readonly market: MarketRef;
  /** Unix ms the window opens (trading is live from here). */
  readonly windowStartMs: number;
  /** Unix ms the window closes and the market resolves. */
  readonly windowEndMs: number;
  /** Best ask on the entry side — what a buyer pays right now (null = no book). */
  readonly bestAsk: number | null;
  /** Instance slug, for audit trails ("btc-updown-5m-1785158400"). */
  readonly slug: string;
}

export type SeriesSkipReason =
  | "series_unresolved"
  | "series_no_book"
  | "series_price_above_ceiling"
  | "series_window_too_short"
  | "series_window_already_traded";

export type SeriesGuardDecision =
  | { readonly ok: true; readonly entryPrice: number }
  | {
      readonly ok: false;
      readonly reason: SeriesSkipReason;
      /** Human-facing specifics for the audit trail / timeline. */
      readonly detail: Record<string, number | string | null>;
    };

/**
 * The price ceiling for a rolling entry. `maxEntryPrice` is authoritative when
 * set; otherwise the order's own limit price acts as the ceiling, so a rolling
 * order can never quietly pay more than a fixed one would have.
 */
export const entryCeilingOf = (action: OrderActionV2): number =>
  action.rollingSeries?.maxEntryPrice ?? action.price;

export const minRemainingMsOf = (ref: SeriesRef): number =>
  ref.minRemainingMs ?? SERIES_DEFAULT_MIN_REMAINING_MS;

/**
 * Should we enter this window? Fail-closed: a missing window or an empty book
 * is a skip, never a guess.
 */
export const seriesGuardDecision = (args: {
  readonly action: OrderActionV2;
  readonly window: ResolvedSeriesWindow | null;
  readonly nowMs: number;
  /** Window start of the last window this strategy already traded, if any. */
  readonly lastTradedWindowStartMs: number | null;
}): SeriesGuardDecision => {
  const ref = args.action.rollingSeries;
  if (ref === undefined) return { ok: false, reason: "series_unresolved", detail: {} };
  if (args.window === null)
    return { ok: false, reason: "series_unresolved", detail: { seriesSlug: ref.seriesSlug } };

  const w = args.window;
  if (w.windowStartMs === args.lastTradedWindowStartMs)
    return {
      ok: false,
      reason: "series_window_already_traded",
      detail: { slug: w.slug, windowStartMs: w.windowStartMs },
    };

  const remainingMs = w.windowEndMs - args.nowMs;
  const floorMs = minRemainingMsOf(ref);
  if (remainingMs < floorMs)
    return {
      ok: false,
      reason: "series_window_too_short",
      detail: { slug: w.slug, remainingMs, requiredMs: floorMs },
    };

  if (w.bestAsk === null || !(w.bestAsk > 0))
    return { ok: false, reason: "series_no_book", detail: { slug: w.slug } };

  const ceiling = entryCeilingOf(args.action);
  if (w.bestAsk > ceiling)
    return {
      ok: false,
      reason: "series_price_above_ceiling",
      detail: { slug: w.slug, bestAsk: w.bestAsk, ceiling },
    };

  // Marketable limit at the ceiling: an immediate order fills at the best
  // available price up to it, so the user never pays above their own guard.
  return { ok: true, entryPrice: ceiling };
};

/**
 * The concrete, executable order for a resolved window. `rollingSeries` is
 * deliberately dropped: a prepared action must be unambiguously tradable, and
 * every downstream consumer (preview, signing, submission) reads `market`.
 */
export const resolvedOrderAction = (
  action: OrderActionV2,
  window: ResolvedSeriesWindow,
  entryPrice: number,
): OrderActionV2 => {
  const { rollingSeries: _dropped, ...rest } = action;
  return { ...rest, market: window.market, price: entryPrice };
};

/**
 * Give back the repeat the state machine just spent when a guard skipped the
 * window. A skip costs no money and enters no market, so it must not consume
 * a user's "trade at most N windows" budget — but we still hold a short
 * cooldown so a hot condition can't re-fire against the same book every tick.
 */
export const SERIES_SKIP_REARM_MS = 15_000;

// ── Modeled outcomes (owner decision, 2026-07-28) ───────────────────────────

export interface RollingOutcomeModel {
  /** Shares bought per window at the ceiling price. */
  readonly shares: number;
  readonly entryPrice: number;
  /** Windows the strategy may trade (recurrence cap). */
  readonly windows: number;
  /** Cash out the door for ONE window, fee included. */
  readonly costPerWindowUsd: number;
  /** Profit if that window resolves in your favour (payout $1/share, less cost). */
  readonly winPerWindowUsd: number;
  /** Loss if it resolves against you — the whole stake, fee included. */
  readonly lossPerWindowUsd: number;
  /** Most that can ever leave the account across every window. */
  readonly maxSpendUsd: number;
  /** Every window wins. */
  readonly bestCaseUsd: number;
  /** Every window loses (equals −maxSpendUsd). */
  readonly worstCaseUsd: number;
  /**
   * Share of windows that must resolve in your favour just to break even —
   * the entry price plus the per-share fee. Below this, the strategy loses
   * money however many times it fires.
   */
  readonly breakEvenWinRate: number;
}

/**
 * What a rolling strategy can win or lose, at the ceiling price it is allowed
 * to pay. These markets are all-or-nothing: a window resolves to $1 or $0 a
 * share with no exit in between, so the arithmetic is exact rather than a
 * backtest — the only unknown is how often you are right.
 */
export const modelRollingOutcomes = (args: {
  readonly shares: number;
  readonly entryPrice: number;
  readonly windows: number;
  readonly feeSchedule: FeeSchedule | null;
}): RollingOutcomeModel => {
  const shares = Math.max(0, args.shares);
  const price = args.entryPrice;
  const windows = Math.max(1, Math.floor(args.windows));
  const fee = args.feeSchedule ? takerFeeUsd(shares, price, args.feeSchedule) : 0;

  const stake = shares * price;
  const costPerWindowUsd = stake + fee;
  const winPerWindowUsd = shares * (1 - price) - fee;
  const lossPerWindowUsd = costPerWindowUsd;
  const feePerShare = shares > 0 ? fee / shares : 0;

  return {
    shares,
    entryPrice: price,
    windows,
    costPerWindowUsd,
    winPerWindowUsd,
    lossPerWindowUsd,
    maxSpendUsd: costPerWindowUsd * windows,
    bestCaseUsd: winPerWindowUsd * windows,
    worstCaseUsd: -costPerWindowUsd * windows,
    breakEvenWinRate: Math.min(1, price + feePerShare),
  };
};

export const revertRepeatForSkip = (
  afterTrigger: StrategyRuntime,
  previousTriggerCount: number,
  nowMs: number,
): StrategyRuntime => ({
  ...afterTrigger,
  // A skipped window never became a trigger, so the strategy is simply back to
  // waiting — including for a `prepare` order, which the state machine would
  // otherwise have parked in TRIGGERED_AWAITING_USER.
  status: "ACTIVE_WAITING",
  trueSinceMs: null,
  triggerCount: previousTriggerCount,
  cooldownUntilMs: nowMs + SERIES_SKIP_REARM_MS,
});
