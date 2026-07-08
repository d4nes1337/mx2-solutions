/**
 * Deterministic v2 state machine (ADR-0010). Same fail-closed posture as v1
 * (state-machine.ts) generalized to multi-market views, plus repeat recurrence
 * with cooldown.
 *
 * Trigger semantics by action / recurrence:
 *  - repeats remaining      → emit trigger, return to ACTIVE_WAITING with a
 *                             cooldown gate (accumulation blocked until it ends).
 *  - final trigger, alert   → COMPLETED (nothing left to confirm).
 *  - final trigger, order   → TRIGGERED_AWAITING_USER (prepare: user confirms;
 *                             auto: the worker claims EXECUTING — v1-compatible).
 *  - final trigger, stop    → COMPLETED (the stop side effect is worker-managed).
 *
 * Multi-market gating: ANY referenced market closed/resolved → INVALIDATED;
 * ANY paused → window reset; ANY missing/stale view → unsatisfied (fail-closed,
 * enforced inside evaluateExpression).
 */
import { evaluateExpression } from "./evaluate-v2.js";
import { buildEvidenceV2 } from "./evidence-v2.js";
import { referencedTokenIds } from "./compat.js";
import { isTerminal } from "./state-machine.js";
import type { ReasonCode, StateTransition } from "./types.js";
import type {
  EvalEventV2,
  StrategyDefinition,
  StrategyRuntime,
  TransitionResultV2,
  ViewsByToken,
} from "./types-v2.js";

export const initialRuntimeV2 = (): StrategyRuntime => ({
  status: "ACTIVE_WAITING",
  trueSinceMs: null,
  lastEventTimeMs: null,
  triggerCount: 0,
  cooldownUntilMs: null,
});

const mk = (
  prev: StrategyRuntime,
  next: StrategyRuntime,
  reason: ReasonCode | null,
  atMs: number,
  trigger: TransitionResultV2["trigger"] = null,
): TransitionResultV2 => {
  const changed = prev.status !== next.status;
  const transition: StateTransition | null =
    changed && reason !== null ? { from: prev.status, to: next.status, reason, atMs } : null;
  return { runtime: next, transition, trigger };
};

const reset = (prev: StrategyRuntime, reason: ReasonCode, atMs: number): TransitionResultV2 =>
  mk(
    prev,
    { ...prev, status: "ACTIVE_WAITING", trueSinceMs: null, lastEventTimeMs: atMs },
    reason,
    atMs,
  );

const terminal = (
  prev: StrategyRuntime,
  status: StrategyRuntime["status"],
  reason: ReasonCode,
  atMs: number,
  trigger: TransitionResultV2["trigger"] = null,
): TransitionResultV2 =>
  mk(prev, { ...prev, status, trueSinceMs: null, lastEventTimeMs: atMs }, reason, atMs, trigger);

/** Core observation of the full view set at `nowMs`. */
const observe = (
  def: StrategyDefinition,
  definitionHash: string,
  prev: StrategyRuntime,
  views: ViewsByToken,
  nowMs: number,
): TransitionResultV2 => {
  if (def.expiresAtMs !== null && nowMs >= def.expiresAtMs) {
    return terminal(prev, "EXPIRED", "EXPIRED", nowMs);
  }

  // Market-status gating across every referenced market (fail-closed).
  // Terminal statuses win over pause regardless of token iteration order.
  const statuses = referencedTokenIds(def).map((t) => views[t]?.marketStatus);
  if (statuses.includes("closed")) return terminal(prev, "INVALIDATED", "MARKET_CLOSED", nowMs);
  if (statuses.includes("resolved")) return terminal(prev, "INVALIDATED", "MARKET_RESOLVED", nowMs);
  if (statuses.includes("paused")) {
    if (prev.status === "ACTIVE_ACCUMULATING") return reset(prev, "MARKET_PAUSED", nowMs);
    return mk(prev, { ...prev, lastEventTimeMs: nowMs }, null, nowMs);
  }

  // Post-trigger cooldown gates accumulation entirely.
  if (prev.cooldownUntilMs !== null && nowMs < prev.cooldownUntilMs) {
    return mk(prev, { ...prev, trueSinceMs: null, lastEventTimeMs: nowMs }, null, nowMs);
  }
  const cleared: StrategyRuntime =
    prev.cooldownUntilMs !== null ? { ...prev, cooldownUntilMs: null } : prev;

  const evalResult = evaluateExpression(def, views, nowMs);
  if (!evalResult.satisfied) {
    const isStale = evalResult.staleTokenIds.length > 0;
    if (cleared.status === "ACTIVE_ACCUMULATING") {
      const reason: ReasonCode = isStale
        ? "DATA_STALE"
        : (evalResult.reasonCodes.find((r) => r.endsWith("FAIL")) ?? "PRICE_FAIL");
      return reset(cleared, reason, nowMs);
    }
    return mk(prev, { ...cleared, trueSinceMs: null, lastEventTimeMs: nowMs }, null, nowMs);
  }

  // Expression satisfied on fresh data — accumulate toward the hold window.
  const trueSinceMs = cleared.trueSinceMs ?? nowMs;
  const elapsed = nowMs - trueSinceMs;

  if (elapsed >= def.holdsForMs) {
    const triggerNumber = cleared.triggerCount + 1;
    const trigger = buildEvidenceV2({
      def,
      definitionHash,
      views,
      resultTree: evalResult.root,
      windowStartMs: trueSinceMs,
      triggeredAtMs: nowMs,
      reasonCodes: [...evalResult.reasonCodes, "WINDOW_COMPLETE"],
      triggerNumber,
    });

    const repeatsRemaining =
      def.recurrence.kind === "repeat" && triggerNumber < def.recurrence.maxRepeats;

    if (repeatsRemaining) {
      const cooldownUntilMs =
        def.recurrence.kind === "repeat" ? nowMs + def.recurrence.cooldownMs : null;
      return mk(
        cleared,
        {
          status: "ACTIVE_WAITING",
          trueSinceMs: null,
          lastEventTimeMs: nowMs,
          triggerCount: triggerNumber,
          cooldownUntilMs,
        },
        "WINDOW_COMPLETE",
        nowMs,
        trigger,
      );
    }

    // Final (or only) trigger.
    const finalStatus = def.action.kind === "order" ? "TRIGGERED_AWAITING_USER" : "COMPLETED";
    const finalReason: ReasonCode =
      def.action.kind === "order" ? "WINDOW_COMPLETE" : "STRATEGY_COMPLETED";
    return mk(
      cleared,
      {
        status: finalStatus,
        trueSinceMs,
        lastEventTimeMs: nowMs,
        triggerCount: triggerNumber,
        cooldownUntilMs: null,
      },
      finalReason,
      nowMs,
      trigger,
    );
  }

  const next: StrategyRuntime = {
    ...cleared,
    status: "ACTIVE_ACCUMULATING",
    trueSinceMs,
    lastEventTimeMs: nowMs,
  };
  const reason: ReasonCode | null =
    cleared.status !== "ACTIVE_ACCUMULATING" ? "WINDOW_STARTED" : null;
  return mk(prev, next, reason, nowMs);
};

export const transitionV2 = (
  def: StrategyDefinition,
  definitionHash: string,
  prev: StrategyRuntime,
  event: EvalEventV2,
): TransitionResultV2 => {
  if (isTerminal(prev.status)) return { runtime: prev, transition: null, trigger: null };

  switch (event.type) {
    case "cancel":
      return terminal(prev, "CANCELLED", "CANCELLED", event.nowMs);
    case "expire":
      return terminal(prev, "EXPIRED", "EXPIRED", event.nowMs);
    case "pause":
      if (prev.status === "PAUSED") return { runtime: prev, transition: null, trigger: null };
      return mk(
        prev,
        { ...prev, status: "PAUSED", trueSinceMs: null, lastEventTimeMs: event.nowMs },
        "PAUSED",
        event.nowMs,
      );
    case "resume":
      if (prev.status !== "PAUSED") return { runtime: prev, transition: null, trigger: null };
      return mk(
        prev,
        { ...prev, status: "ACTIVE_WAITING", trueSinceMs: null, lastEventTimeMs: event.nowMs },
        "RESUMED",
        event.nowMs,
      );
    case "reconnect":
      if (prev.status === "ACTIVE_ACCUMULATING") return reset(prev, "RECONNECT_RESET", event.nowMs);
      return { runtime: prev, transition: null, trigger: null };
    case "tick_size_change":
      if (prev.status === "ACTIVE_ACCUMULATING")
        return reset(prev, "TICK_SIZE_CHANGED", event.nowMs);
      return { runtime: prev, transition: null, trigger: null };
    case "market_status": {
      if (event.status === "closed" || event.status === "resolved") {
        const reason: ReasonCode = event.status === "closed" ? "MARKET_CLOSED" : "MARKET_RESOLVED";
        return terminal(prev, "INVALIDATED", reason, event.nowMs);
      }
      if (event.status === "paused" && prev.status === "ACTIVE_ACCUMULATING")
        return reset(prev, "MARKET_PAUSED", event.nowMs);
      return { runtime: prev, transition: null, trigger: null };
    }
    case "book":
      if (prev.status === "PAUSED") return { runtime: prev, transition: null, trigger: null };
      return observe(def, definitionHash, prev, event.views, event.nowMs);
    case "tick": {
      if (prev.status === "PAUSED") return { runtime: prev, transition: null, trigger: null };
      if (def.expiresAtMs !== null && event.nowMs >= def.expiresAtMs) {
        return terminal(prev, "EXPIRED", "EXPIRED", event.nowMs);
      }
      if (event.views === null) {
        if (prev.status === "ACTIVE_ACCUMULATING") return reset(prev, "DATA_STALE", event.nowMs);
        return { runtime: prev, transition: null, trigger: null };
      }
      return observe(def, definitionHash, prev, event.views, event.nowMs);
    }
  }
};
