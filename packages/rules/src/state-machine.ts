/**
 * Deterministic, pure continuous-duration state machine (L3). Given the current
 * runtime and one event, it returns the next runtime, an optional explicit state
 * transition, and (only on the single trigger) the evidence. It performs no I/O
 * and reads no clock — `nowMs` is supplied on every event — so feeding the same
 * ordered event sequence always yields the same result (the basis for replay).
 *
 * Fail-closed posture (docs/04 §3.3): during accumulation, ANY of {predicate
 * false, data stale, reconnect, market pause} resets the window; market
 * close/resolve invalidates the rule. A rule triggers at most once (recurrence
 * "once") and TRIGGERED_AWAITING_USER is terminal until an explicit re-arm.
 */
import { evaluatePredicates } from "./evaluate.js";
import { buildEvidence } from "./evidence.js";
import { dataAgeMs } from "./predicates.js";
import type {
  EvalEvent,
  MarketDataView,
  ReasonCode,
  RuleDefinition,
  RuleRuntime,
  RuleStatus,
  StateTransition,
  TransitionResult,
} from "./types.js";

const TERMINAL: ReadonlySet<RuleStatus> = new Set<RuleStatus>([
  "TRIGGERED_AWAITING_USER",
  "EXECUTED_MANUALLY",
  "EXPIRED",
  "CANCELLED",
  "INVALIDATED",
  "ERROR",
]);

export const isTerminal = (status: RuleStatus): boolean => TERMINAL.has(status);

export const initialRuntime = (): RuleRuntime => ({
  status: "ACTIVE_WAITING",
  trueSinceMs: null,
  lastEventTimeMs: null,
});

const mk = (
  prev: RuleRuntime,
  next: RuleRuntime,
  reason: ReasonCode | null,
  atMs: number,
  trigger: TransitionResult["trigger"] = null,
): TransitionResult => {
  const changed = prev.status !== next.status;
  const transition: StateTransition | null =
    changed && reason !== null ? { from: prev.status, to: next.status, reason, atMs } : null;
  return { runtime: next, transition, trigger };
};

/** Reset accumulation back to waiting (window broken), preserving lastEventTime. */
const reset = (
  prev: RuleRuntime,
  reason: ReasonCode,
  atMs: number,
  lastEventTimeMs: number | null,
): TransitionResult =>
  mk(prev, { status: "ACTIVE_WAITING", trueSinceMs: null, lastEventTimeMs }, reason, atMs);

/** Core evaluation for a fresh-or-stale view at `nowMs`. */
const observe = (
  def: RuleDefinition,
  prev: RuleRuntime,
  view: MarketDataView,
  nowMs: number,
): TransitionResult => {
  // Expiry first.
  if (def.expiresAtMs !== null && nowMs >= def.expiresAtMs) {
    return mk(
      prev,
      { status: "EXPIRED", trueSinceMs: null, lastEventTimeMs: nowMs },
      "EXPIRED",
      nowMs,
    );
  }

  // Market status gating.
  if (view.marketStatus === "closed" || view.marketStatus === "resolved") {
    const reason: ReasonCode = view.marketStatus === "closed" ? "MARKET_CLOSED" : "MARKET_RESOLVED";
    return mk(
      prev,
      { status: "INVALIDATED", trueSinceMs: null, lastEventTimeMs: nowMs },
      reason,
      nowMs,
    );
  }
  if (view.marketStatus === "paused") {
    return reset(prev, "MARKET_PAUSED", nowMs, nowMs);
  }

  // Freshness: a view older than maxDataAge cannot sustain the window.
  if (dataAgeMs(view, nowMs) > def.maxDataAgeMs) {
    if (prev.status === "ACTIVE_ACCUMULATING") return reset(prev, "DATA_STALE", nowMs, nowMs);
    return mk({ ...prev }, { ...prev, lastEventTimeMs: nowMs }, null, nowMs);
  }

  const evalResult = evaluatePredicates(def, view);
  if (!evalResult.satisfied) {
    if (prev.status === "ACTIVE_ACCUMULATING") {
      return reset(
        prev,
        evalResult.reasonCodes.find((r) => r.endsWith("FAIL")) ?? "PRICE_FAIL",
        nowMs,
        nowMs,
      );
    }
    return mk(prev, { ...prev, trueSinceMs: null, lastEventTimeMs: nowMs }, null, nowMs);
  }

  // Predicate is satisfied and data is fresh — accumulate.
  const trueSinceMs = prev.trueSinceMs ?? nowMs;
  const elapsed = nowMs - trueSinceMs;

  if (elapsed >= def.continuousWindowMs) {
    const trigger = buildEvidence({
      def,
      view,
      windowStartMs: trueSinceMs,
      triggeredAtMs: nowMs,
      reasonCodes: [...evalResult.reasonCodes, "WINDOW_COMPLETE"],
    });
    return mk(
      prev,
      { status: "TRIGGERED_AWAITING_USER", trueSinceMs, lastEventTimeMs: nowMs },
      "WINDOW_COMPLETE",
      nowMs,
      trigger,
    );
  }

  const next: RuleRuntime = {
    status: "ACTIVE_ACCUMULATING",
    trueSinceMs,
    lastEventTimeMs: nowMs,
  };
  const reason: ReasonCode | null = prev.status !== "ACTIVE_ACCUMULATING" ? "WINDOW_STARTED" : null;
  return mk(prev, next, reason, nowMs);
};

export const transition = (
  def: RuleDefinition,
  prev: RuleRuntime,
  event: EvalEvent,
): TransitionResult => {
  // Terminal states are absorbing here; re-arm is an explicit external action.
  if (isTerminal(prev.status)) return { runtime: prev, transition: null, trigger: null };

  switch (event.type) {
    case "cancel":
      return mk(
        prev,
        { status: "CANCELLED", trueSinceMs: null, lastEventTimeMs: event.nowMs },
        "CANCELLED",
        event.nowMs,
      );
    case "expire":
      return mk(
        prev,
        { status: "EXPIRED", trueSinceMs: null, lastEventTimeMs: event.nowMs },
        "EXPIRED",
        event.nowMs,
      );
    case "pause":
      if (prev.status === "PAUSED") return { runtime: prev, transition: null, trigger: null };
      return mk(
        prev,
        { status: "PAUSED", trueSinceMs: null, lastEventTimeMs: event.nowMs },
        "PAUSED",
        event.nowMs,
      );
    case "resume":
      if (prev.status !== "PAUSED") return { runtime: prev, transition: null, trigger: null };
      return mk(
        prev,
        { status: "ACTIVE_WAITING", trueSinceMs: null, lastEventTimeMs: event.nowMs },
        "RESUMED",
        event.nowMs,
      );
    case "reconnect":
      // Any reconnect during accumulation breaks continuity (fail-closed).
      if (prev.status === "ACTIVE_ACCUMULATING")
        return reset(prev, "RECONNECT_RESET", event.nowMs, event.nowMs);
      return { runtime: prev, transition: null, trigger: null };
    case "tick_size_change":
      // The price grid changed mid-window — a prepared price may no longer be
      // valid, so the continuous window is broken (fail-closed).
      if (prev.status === "ACTIVE_ACCUMULATING")
        return reset(prev, "TICK_SIZE_CHANGED", event.nowMs, event.nowMs);
      return { runtime: prev, transition: null, trigger: null };
    case "market_status":
      if (event.status === "closed" || event.status === "resolved") {
        const reason: ReasonCode = event.status === "closed" ? "MARKET_CLOSED" : "MARKET_RESOLVED";
        return mk(
          prev,
          { status: "INVALIDATED", trueSinceMs: null, lastEventTimeMs: event.nowMs },
          reason,
          event.nowMs,
        );
      }
      if (event.status === "paused" && prev.status === "ACTIVE_ACCUMULATING")
        return reset(prev, "MARKET_PAUSED", event.nowMs, event.nowMs);
      return { runtime: prev, transition: null, trigger: null };
    case "book":
      // PAUSED rules ignore market data until resumed.
      if (prev.status === "PAUSED") return { runtime: prev, transition: null, trigger: null };
      return observe(def, prev, event.view, event.nowMs);
    case "tick": {
      if (prev.status === "PAUSED") return { runtime: prev, transition: null, trigger: null };
      // Expiry can fire on a tick even with no fresh data.
      if (def.expiresAtMs !== null && event.nowMs >= def.expiresAtMs) {
        return mk(
          prev,
          { status: "EXPIRED", trueSinceMs: null, lastEventTimeMs: event.nowMs },
          "EXPIRED",
          event.nowMs,
        );
      }
      if (event.latestView === null) {
        // No data at all: if accumulating, the window can't be sustained.
        if (prev.status === "ACTIVE_ACCUMULATING")
          return reset(prev, "DATA_STALE", event.nowMs, event.nowMs);
        return { runtime: prev, transition: null, trigger: null };
      }
      return observe(def, prev, event.latestView, event.nowMs);
    }
  }
};
