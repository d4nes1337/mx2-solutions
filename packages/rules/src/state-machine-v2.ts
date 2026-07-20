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
import { conditionLeaves, referencedTokenIds } from "./compat.js";
import { isTerminal } from "./state-machine.js";
import type { ReasonCode, StateTransition } from "./types.js";
import type {
  EvalEventV2,
  StrategyDefinition,
  StrategyRuntime,
  TransitionResultV2,
  ViewsByToken,
  WatermarksByNode,
} from "./types-v2.js";

export const initialRuntimeV2 = (): StrategyRuntime => ({
  status: "ACTIVE_WAITING",
  trueSinceMs: null,
  lastEventTimeMs: null,
  triggerCount: 0,
  cooldownUntilMs: null,
  watermarks: {},
  staleSinceMs: null,
});

/**
 * Effective stale-grace for the hold window: how long accumulation may PAUSE
 * on stale data before resetting. 0 = strict legacy reset-on-stale (v1 rules).
 * Older stored v2 definitions lack the field — defaulted here so stored JSON
 * is never rewritten (D-020).
 */
export const staleGraceMsOf = (def: StrategyDefinition): number =>
  def.staleGraceMs ?? Math.min(2 * def.maxDataAgeMs, 60_000);

/**
 * Drop trailing-node watermarks after a repeat trigger: each repetition
 * trails from scratch (re-arms at the first fresh observation after the
 * cooldown). Non-trailing entries can't exist, but filter defensively.
 */
const clearTrailingWatermarks = (
  watermarks: WatermarksByNode,
  def: StrategyDefinition,
): WatermarksByNode => {
  const trailingIds = new Set(
    conditionLeaves(def.expr)
      .filter((n) => n.condition.kind === "trailing")
      .map((n) => n.id),
  );
  const kept = Object.entries(watermarks).filter(([id]) => !trailingIds.has(id));
  return Object.fromEntries(kept);
};

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

const reset = (
  prev: StrategyRuntime,
  reason: ReasonCode,
  atMs: number,
  watermarks?: WatermarksByNode,
): TransitionResultV2 =>
  mk(
    prev,
    {
      ...prev,
      status: "ACTIVE_WAITING",
      trueSinceMs: null,
      staleSinceMs: null,
      lastEventTimeMs: atMs,
      // Hold-window resets never reset trailing state: the watermark is a
      // high-water mark, not continuity-dependent data. Callers that just
      // evaluated pass the updated map; event-driven resets keep prev's.
      ...(watermarks !== undefined ? { watermarks } : {}),
    },
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
  mk(
    prev,
    { ...prev, status, trueSinceMs: null, staleSinceMs: null, lastEventTimeMs: atMs },
    reason,
    atMs,
    trigger,
  );

/**
 * A same-status runtime change still worth auditing (window paused/resumed).
 * `mk` suppresses transitions when the status didn't move; pause/resume flags
 * are exactly that case.
 */
const flag = (
  prev: StrategyRuntime,
  next: StrategyRuntime,
  reason: ReasonCode,
  atMs: number,
): TransitionResultV2 => ({
  runtime: next,
  transition: { from: prev.status, to: next.status, reason, atMs },
  trigger: null,
});

/**
 * Stale data while accumulating. With a grace (v2 default), the hold window
 * PAUSES instead of resetting: `staleSinceMs` marks the onset, the stale
 * interval never counts toward holdsForMs, and the reset only lands when the
 * grace is exhausted. Grace 0 keeps the strict legacy reset (v1 parity).
 */
const observeStale = (
  def: StrategyDefinition,
  prev: StrategyRuntime,
  nowMs: number,
  resetReason: ReasonCode,
  watermarks?: WatermarksByNode,
): TransitionResultV2 => {
  const grace = staleGraceMsOf(def);
  if (grace === 0) return reset(prev, resetReason, nowMs, watermarks);
  const staleSince = prev.staleSinceMs ?? null;
  if (staleSince === null) {
    return flag(
      prev,
      {
        ...prev,
        staleSinceMs: nowMs,
        lastEventTimeMs: nowMs,
        ...(watermarks !== undefined ? { watermarks } : {}),
      },
      "STALE_PAUSED",
      nowMs,
    );
  }
  if (nowMs - staleSince > grace) return reset(prev, resetReason, nowMs, watermarks);
  // Still inside the grace — hold position without transition churn.
  return mk(
    prev,
    { ...prev, lastEventTimeMs: nowMs, ...(watermarks !== undefined ? { watermarks } : {}) },
    null,
    nowMs,
  );
};

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
    return mk(
      prev,
      { ...prev, trueSinceMs: null, staleSinceMs: null, lastEventTimeMs: nowMs },
      null,
      nowMs,
    );
  }
  const cleared: StrategyRuntime =
    prev.cooldownUntilMs !== null ? { ...prev, cooldownUntilMs: null } : prev;

  const evalResult = evaluateExpression(def, views, nowMs, prev.watermarks ?? {});
  if (!evalResult.satisfied) {
    const isStale = evalResult.staleTokenIds.length > 0;
    if (cleared.status === "ACTIVE_ACCUMULATING") {
      // Stale takes priority over fresh FAIL codes, mirroring the evaluator:
      // any stale leaf forces the whole expression unsatisfied regardless of
      // fresh branches, so "unsatisfied while stale" cannot be attributed to
      // the market having actually moved away.
      if (isStale) return observeStale(def, cleared, nowMs, "DATA_STALE", evalResult.watermarks);
      const reason: ReasonCode =
        evalResult.reasonCodes.find((r) => r.endsWith("FAIL")) ?? "PRICE_FAIL";
      return reset(cleared, reason, nowMs, evalResult.watermarks);
    }
    // Watermark updates while unsatisfied are the whole point of trailing —
    // the peak ratchets long before the drop that satisfies the condition.
    return mk(
      prev,
      {
        ...cleared,
        trueSinceMs: null,
        staleSinceMs: null,
        lastEventTimeMs: nowMs,
        watermarks: evalResult.watermarks,
      },
      null,
      nowMs,
    );
  }

  // Expression satisfied on fresh data (satisfied ⇒ every leaf fresh).
  // A pending stale-pause resolves here: within the grace the window RESUMES
  // with the stale interval excised (trueSince shifts forward by the gap);
  // past the grace continuity can't be attested — restart the window from now.
  let base = cleared;
  let resumedReason: ReasonCode | null = null;
  if (base.staleSinceMs != null) {
    const gap = nowMs - base.staleSinceMs;
    if (gap > staleGraceMsOf(def)) {
      base = { ...base, trueSinceMs: null, staleSinceMs: null };
      resumedReason = "DATA_STALE";
    } else {
      base = {
        ...base,
        trueSinceMs: base.trueSinceMs === null ? null : base.trueSinceMs + gap,
        staleSinceMs: null,
      };
      resumedReason = "STALE_RESUMED";
    }
  }

  const trueSinceMs = base.trueSinceMs ?? nowMs;
  const elapsed = nowMs - trueSinceMs;

  if (elapsed >= def.holdsForMs) {
    const triggerNumber = base.triggerCount + 1;
    const trigger = buildEvidenceV2({
      def,
      definitionHash,
      views,
      resultTree: evalResult.root,
      windowStartMs: trueSinceMs,
      triggeredAtMs: nowMs,
      reasonCodes: [...evalResult.reasonCodes, "WINDOW_COMPLETE"],
      triggerNumber,
      watermarks: evalResult.watermarks,
    });

    const repeatsRemaining =
      def.recurrence.kind === "repeat" && triggerNumber < def.recurrence.maxRepeats;

    if (repeatsRemaining) {
      const cooldownUntilMs =
        def.recurrence.kind === "repeat" ? nowMs + def.recurrence.cooldownMs : null;
      return mk(
        base,
        {
          status: "ACTIVE_WAITING",
          trueSinceMs: null,
          staleSinceMs: null,
          lastEventTimeMs: nowMs,
          triggerCount: triggerNumber,
          cooldownUntilMs,
          // Each repetition trails from scratch: re-arm after the cooldown.
          watermarks: clearTrailingWatermarks(evalResult.watermarks, def),
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
      base,
      {
        status: finalStatus,
        trueSinceMs,
        staleSinceMs: null,
        lastEventTimeMs: nowMs,
        triggerCount: triggerNumber,
        cooldownUntilMs: null,
        watermarks: evalResult.watermarks,
      },
      finalReason,
      nowMs,
      trigger,
    );
  }

  const next: StrategyRuntime = {
    ...base,
    status: "ACTIVE_ACCUMULATING",
    trueSinceMs,
    staleSinceMs: null,
    lastEventTimeMs: nowMs,
    watermarks: evalResult.watermarks,
  };
  // A resolved stale-pause outranks the ordinary start/continue reasons:
  // STALE_RESUMED (window continued, gap excised) or DATA_STALE (grace
  // exhausted while dark — window restarted from this fresh observation).
  if (resumedReason !== null) return flag(prev, next, resumedReason, nowMs);
  const reason: ReasonCode | null = base.status !== "ACTIVE_ACCUMULATING" ? "WINDOW_STARTED" : null;
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
      // Reconnect is a staleness ONSET, not proof the market moved: pause the
      // window (grace 0 keeps the legacy immediate RECONNECT_RESET).
      if (prev.status === "ACTIVE_ACCUMULATING")
        return observeStale(def, prev, event.nowMs, "RECONNECT_RESET");
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
        if (prev.status === "ACTIVE_ACCUMULATING")
          return observeStale(def, prev, event.nowMs, "DATA_STALE");
        return { runtime: prev, transition: null, trigger: null };
      }
      return observe(def, definitionHash, prev, event.views, event.nowMs);
    }
  }
};
