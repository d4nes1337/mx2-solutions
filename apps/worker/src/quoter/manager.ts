import type { Logger } from "@mx2/observability";
import type { QuoterStore, RuleStore, RuntimeFlagStore, ConditionalRuleRow } from "@mx2/db";
import type { AuditStore } from "@mx2/db";
import {
  evaluateExpression,
  normalizeDefinition,
  conditionLeaves,
  type MarketDataView,
  type QuoteLoopAction,
  type RuleDefinition,
  type StrategyDefinition,
} from "@mx2/rules";
import {
  capBreach,
  capitalCommittedUsd,
  computeDesiredQuotes,
  diffQuotes,
  inventoryPlan,
  type DesiredQuotes,
  type RestingQuote,
} from "./engine.js";
import type { QuoterExecutor } from "./executor.js";

/**
 * Single-writer host for maker-loop quoting sessions (RFC-0003). Same D-001
 * posture as the rule evaluator: exactly one worker instance owns all
 * sessions — do NOT run multi-instance (extend the R-011 advisory-lock seam
 * before scaling out).
 *
 * The loop per armed quote_loop rule, every cycle:
 *   kill switches → gate expression → desired quotes → diff vs resting →
 *   execute cancels/places → merge accumulated pairs → cap checks → persist.
 * A breach cancels everything and HALTS the session (manual resume via the
 * API); kill switches idle the session without halting (auto-recovers when
 * the flag clears). Every action lands in quote_events with a UNIQUE
 * idempotency key — replaying a cycle can never double-book.
 */

export interface QuoterManager {
  start(): void;
  onBook(view: MarketDataView): void;
  onReconnect(): void;
  stop(): void;
}

export interface QuoterManagerOptions {
  logger: Logger;
  ruleStore: RuleStore;
  quoterStore: QuoterStore;
  auditStore: AuditStore;
  runtimeFlags: RuntimeFlagStore;
  executor: QuoterExecutor;
  subscribe: (tokenIds: string[]) => void;
  unsubscribe: (tokenIds: string[]) => void;
  reloadIntervalMs?: number;
  /** Minimum quiet period between cycles for one session. */
  cycleMinIntervalMs?: number;
}

interface ActiveLoop {
  readonly ruleId: string;
  readonly walletAddress: string;
  readonly def: StrategyDefinition;
  readonly params: QuoteLoopAction;
  sessionId: string;
  halted: boolean;
  resting: RestingQuote[];
  inventoryYes: number;
  inventoryNo: number;
  dailyLossUsd: number;
  lastCycleMs: number;
  cycling: boolean;
}

export const createQuoterManager = (opts: QuoterManagerOptions): QuoterManager => {
  const {
    logger,
    ruleStore,
    quoterStore,
    auditStore,
    runtimeFlags,
    executor,
    subscribe,
    unsubscribe,
  } = opts;
  const reloadIntervalMs = opts.reloadIntervalMs ?? 5_000;
  const cycleMinIntervalMs = opts.cycleMinIntervalMs ?? 2_000;

  const loops = new Map<string, ActiveLoop>();
  const latestView = new Map<string, MarketDataView>();
  const tokenLoops = new Map<string, Set<string>>();
  let reloadTimer: ReturnType<typeof setInterval> | undefined;

  const flagIsTrue = async (key: string): Promise<boolean> =>
    (await runtimeFlags.get(key))?.value === "true";

  const isQuoteLoopRow = (row: ConditionalRuleRow): QuoteLoopAction | null => {
    try {
      const def = normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition);
      return def.action.kind === "quote_loop" ? def.action : null;
    } catch {
      return null;
    }
  };

  const addLoop = async (row: ConditionalRuleRow): Promise<void> => {
    const def = normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition);
    if (def.action.kind !== "quote_loop") return;
    const session = await quoterStore.ensureSession(row.id, row.walletAddress);
    const loop: ActiveLoop = {
      ruleId: row.id,
      walletAddress: row.walletAddress,
      def,
      params: def.action,
      sessionId: session.id,
      halted: session.status === "halted",
      // Conservative restart: assume nothing rests (shadow) — the live
      // executor's open-order reconciliation replaces this before any real
      // order management (RFC-0003 checkpoint 2).
      resting: [],
      inventoryYes: Number(session.inventoryYes),
      inventoryNo: Number(session.inventoryNo),
      dailyLossUsd: Number(session.dailyLossUsd),
      lastCycleMs: 0,
      cycling: false,
    };
    loops.set(row.id, loop);
    for (const token of [def.action.market.yesTokenId, def.action.market.noTokenId]) {
      let set = tokenLoops.get(token);
      if (!set) {
        set = new Set();
        tokenLoops.set(token, set);
        subscribe([token]);
      }
      set.add(row.id);
    }
    logger.info(
      { ruleId: row.id, mode: executor.mode, conditionId: def.action.market.conditionId },
      "Maker loop attached",
    );
  };

  const removeLoop = (ruleId: string): void => {
    const loop = loops.get(ruleId);
    if (!loop) return;
    loops.delete(ruleId);
    for (const token of [loop.params.market.yesTokenId, loop.params.market.noTokenId]) {
      const set = tokenLoops.get(token);
      if (!set) continue;
      set.delete(ruleId);
      if (set.size === 0) {
        tokenLoops.delete(token);
        latestView.delete(token);
        unsubscribe([token]);
      }
    }
  };

  const reload = async (): Promise<void> => {
    const rows = await ruleStore.listEvaluable();
    const seen = new Set<string>();
    for (const row of rows) {
      if (isQuoteLoopRow(row) === null) continue;
      seen.add(row.id);
      if (!loops.has(row.id)) {
        await addLoop(row).catch((e: unknown) =>
          logger.warn({ err: e, ruleId: row.id }, "Maker loop attach failed"),
        );
      }
    }
    for (const id of [...loops.keys()]) if (!seen.has(id)) removeLoop(id);
  };

  const gateSatisfied = (loop: ActiveLoop, nowMs: number): boolean => {
    if (conditionLeaves(loop.def.expr).length === 0) return true; // always-on
    const views: Record<string, MarketDataView> = {};
    const walkTokens = new Set<string>();
    for (const { condition } of conditionLeaves(loop.def.expr)) {
      if (condition.kind !== "time_window") walkTokens.add(condition.market.tokenId);
    }
    for (const token of walkTokens) {
      const v = latestView.get(token);
      if (v) views[token] = v;
    }
    return evaluateExpression(loop.def, views, nowMs).satisfied;
  };

  const record = (
    loop: ActiveLoop,
    type: Parameters<QuoterStore["recordEvent"]>[0]["type"],
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<boolean> =>
    quoterStore.recordEvent({
      sessionId: loop.sessionId,
      ruleId: loop.ruleId,
      type,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      payload,
    });

  const cancelAll = async (loop: ActiveLoop, cycleKey: string): Promise<void> => {
    for (const quote of [...loop.resting]) {
      const key = `${cycleKey}:cancel:${quote.tokenId}:${quote.orderId ?? "virtual"}`;
      const res = await executor.cancel(quote, key);
      if (res.ok) {
        loop.resting = loop.resting.filter((r) => r !== quote);
        await record(loop, "order_cancelled", { quote }, key);
      } else {
        logger.warn({ ruleId: loop.ruleId, err: res.message }, "Quote cancel failed");
      }
    }
  };

  const halt = async (loop: ActiveLoop, reason: string, cycleKey: string): Promise<void> => {
    await cancelAll(loop, cycleKey);
    loop.halted = true;
    await quoterStore.updateSession(loop.sessionId, { status: "halted", haltedReason: reason });
    await record(loop, "halt", { reason }, `${cycleKey}:halt`);
    await auditStore.emit({
      actor: loop.walletAddress,
      action: "quoter.halted",
      subject: `rule:${loop.ruleId}`,
      metadata: { reason, mode: executor.mode },
    });
    logger.warn({ ruleId: loop.ruleId, reason }, "Maker loop halted");
  };

  const cycle = async (loop: ActiveLoop, nowMs: number): Promise<void> => {
    const cycleKey = `quoter:${loop.ruleId}:${nowMs}`;

    // 1. Session halted → only the API's resume restarts it.
    if (loop.halted) return;

    // 2. Kill switches: idle without halting (auto-recovers when cleared).
    if (
      (await flagIsTrue("trading_paused")) ||
      (await flagIsTrue("quoter_paused")) ||
      (await flagIsTrue(`rule_auto_disabled:${loop.ruleId}`))
    ) {
      if (loop.resting.length > 0) {
        await cancelAll(loop, cycleKey);
        await quoterStore.updateSession(loop.sessionId, { status: "idle" });
      }
      return;
    }

    // 3. Gate expression (fail-closed: stale gate data = quotes down).
    const yesView = latestView.get(loop.params.market.yesTokenId);
    const desired: DesiredQuotes = gateSatisfied(loop, nowMs)
      ? computeDesiredQuotes(loop.params, yesView, nowMs, loop.def.maxDataAgeMs)
      : { kind: "idle", reason: "gate_unsatisfied" };

    // 4. Cap checks BEFORE placing anything new.
    const mid = desired.kind === "quote" ? desired.mid : null;
    const committed = capitalCommittedUsd(loop.resting, loop.inventoryYes, loop.inventoryNo, mid);
    const breach = capBreach(committed, loop.dailyLossUsd, loop.params);
    if (breach) {
      await halt(loop, breach, cycleKey);
      return;
    }

    // 5. Inventory: merge accumulated pairs, halt on one-sided exposure.
    const plan = inventoryPlan(loop.inventoryYes, loop.inventoryNo, loop.params);
    if (plan.breach) {
      await halt(loop, plan.breach, cycleKey);
      return;
    }
    if (plan.mergePairs > 0) {
      const key = `${cycleKey}:merge:${plan.mergePairs}`;
      const res = await executor.mergePairs(plan.mergePairs, key);
      if (res.ok) {
        loop.inventoryYes -= plan.mergePairs;
        loop.inventoryNo -= plan.mergePairs;
        // Each merged pair returns $1 collateral; entry cost < $1 by 2·spread.
        await record(
          loop,
          "merge_submitted",
          { pairs: plan.mergePairs, transactionId: res.value.transactionId },
          key,
        );
        await auditStore.emit({
          actor: loop.walletAddress,
          action: "quoter.merge_submitted",
          subject: `rule:${loop.ruleId}`,
          metadata: { pairs: plan.mergePairs, mode: executor.mode },
        });
      }
    }

    // 6. Reconcile quotes.
    const diff = diffQuotes(loop.resting, desired, loop.params.requoteToleranceCents);
    for (const cancel of diff.cancels) {
      const key = `${cycleKey}:cancel:${cancel.tokenId}:${cancel.orderId ?? "virtual"}`;
      const res = await executor.cancel(cancel, key);
      if (res.ok) {
        loop.resting = loop.resting.filter((r) => r !== cancel);
        await record(loop, "order_cancelled", { quote: cancel }, key);
      }
    }
    for (const place of diff.places) {
      const key = `${cycleKey}:place:${place.tokenId}`;
      await record(loop, "quote_intent", { intent: place, mode: executor.mode }, key);
      const res = await executor.place(place, key);
      if (res.ok) {
        loop.resting = [...loop.resting, res.value];
        if (executor.mode === "live") {
          await record(loop, "order_placed", { quote: res.value }, `${key}:placed`);
        }
      } else {
        logger.warn({ ruleId: loop.ruleId, err: res.message }, "Quote place failed");
      }
    }

    // 7. Scoreboard.
    await quoterStore.updateSession(loop.sessionId, {
      status: loop.resting.length > 0 ? "quoting" : "idle",
      inventoryYes: loop.inventoryYes,
      inventoryNo: loop.inventoryNo,
      capitalCommittedUsd: capitalCommittedUsd(
        loop.resting,
        loop.inventoryYes,
        loop.inventoryNo,
        mid,
      ),
      lastCycleAt: new Date(nowMs),
    });
    await record(loop, "cycle", {
      desired: desired.kind,
      ...(desired.kind === "idle" ? { reason: desired.reason } : { mid: desired.mid }),
      resting: loop.resting.length,
      cancels: diff.cancels.length,
      places: diff.places.length,
    });
  };

  const maybeCycle = (loop: ActiveLoop, nowMs: number): void => {
    if (loop.cycling || nowMs - loop.lastCycleMs < cycleMinIntervalMs) return;
    loop.cycling = true;
    loop.lastCycleMs = nowMs;
    cycle(loop, nowMs)
      .catch((e: unknown) => logger.warn({ err: e, ruleId: loop.ruleId }, "Quoter cycle failed"))
      .finally(() => {
        loop.cycling = false;
      });
  };

  return {
    start() {
      reload().catch((e: unknown) => logger.warn({ err: e }, "Quoter initial reload failed"));
      reloadTimer = setInterval(() => {
        reload().catch((e: unknown) => logger.warn({ err: e }, "Quoter reload failed"));
        const now = Date.now();
        for (const loop of loops.values()) maybeCycle(loop, now);
      }, reloadIntervalMs);
      logger.info(
        { mode: executor.mode, reloadIntervalMs, cycleMinIntervalMs },
        "Maker-loop quoter started",
      );
    },

    onBook(view) {
      latestView.set(view.tokenId, view);
      const set = tokenLoops.get(view.tokenId);
      if (!set) return;
      const now = Date.now();
      for (const id of set) {
        const loop = loops.get(id);
        if (loop) maybeCycle(loop, now);
      }
    },

    onReconnect() {
      // Continuity broken: views are wiped; quotes get re-reconciled on the
      // next cycle from fresh books (fail-closed — a stale book idles quotes).
      latestView.clear();
    },

    stop() {
      clearInterval(reloadTimer);
    },
  };
};
