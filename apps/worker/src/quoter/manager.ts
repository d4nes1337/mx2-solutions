import type { Logger } from "@mx2/observability";
import type {
  QuoterStore,
  RuleStore,
  RuntimeFlagStore,
  ConditionalRuleRow,
  QuoteSessionMode,
} from "@mx2/db";
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
  computeBatchHash,
  computeDesiredQuotes,
  diffOpenOrders,
  diffQuotes,
  inventoryPlan,
  type DesiredQuotes,
  type ProposedBatch,
  type QuoteIntent,
  type RestingQuote,
} from "./engine.js";
import type { QuoterExecutor, QuoterExecutorProvider, QuoterLoopContext } from "./executor.js";

/**
 * Single-writer host for maker-loop quoting sessions (RFC-0003). Same D-001
 * posture as the rule evaluator: exactly one worker instance owns all
 * sessions — do NOT run multi-instance (extend the R-011 advisory-lock seam
 * before scaling out).
 *
 * The loop per armed quote_loop rule, every cycle:
 *   session re-read (mode/status/approval — the API's writes take effect
 *   within one cycle) → kill switches → executor resolution (an unavailable
 *   live prerequisite HALTS, never silently shadows) → merge confirmations →
 *   fill sync (venue open orders vs our resting view) → daily-loss rollover →
 *   gate expression → desired quotes → cap checks → merge plan → EXECUTE:
 *     shadow/live: cancels + places + merges directly;
 *     confirm:     cancels immediately (risk-reducing), places/merges only
 *                  when the approved batch hash matches the recomputed one —
 *                  a moved book re-proposes and stale approvals cannot land.
 * Every action lands in quote_events with a UNIQUE idempotency key —
 * replaying a cycle can never double-book.
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
  executorProvider: QuoterExecutorProvider;
  subscribe: (tokenIds: string[]) => void;
  unsubscribe: (tokenIds: string[]) => void;
  reloadIntervalMs?: number;
  /** Minimum quiet period between cycles for one session. */
  cycleMinIntervalMs?: number;
}

interface PendingMerge {
  transactionId: string;
  pairs: number;
}

interface ActiveLoop {
  readonly ruleId: string;
  readonly walletAddress: string;
  readonly def: StrategyDefinition;
  readonly params: QuoteLoopAction;
  sessionId: string;
  resting: RestingQuote[];
  inventoryYes: number;
  inventoryNo: number;
  /** Total USD paid for the current YES/NO inventory (avg-cost pools). */
  costYesUsd: number;
  costNoUsd: number;
  realizedPnlUsd: number;
  dailyLossUsd: number;
  dailyLossDay: string | null;
  pendingMerges: PendingMerge[];
  /** Whether the venue open-order reconcile ran since attach/mode-flip. */
  syncedLive: boolean;
  lastCycleMs: number;
  cycling: boolean;
}

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export const createQuoterManager = (opts: QuoterManagerOptions): QuoterManager => {
  const {
    logger,
    ruleStore,
    quoterStore,
    auditStore,
    runtimeFlags,
    executorProvider,
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

  const loopContext = (loop: ActiveLoop): QuoterLoopContext => ({
    ruleId: loop.ruleId,
    walletAddress: loop.walletAddress,
    market: {
      conditionId: loop.params.market.conditionId,
      yesTokenId: loop.params.market.yesTokenId,
      noTokenId: loop.params.market.noTokenId,
      negRisk: loop.params.market.negRisk ?? false,
      tickSize: loop.params.market.tickSize ?? "0.01",
    },
  });

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
      // Conservative restart: assume nothing rests; the live open-order
      // reconcile (first live cycle) adopts whatever actually rests on the
      // venue before any order management happens.
      resting: [],
      inventoryYes: Number(session.inventoryYes),
      inventoryNo: Number(session.inventoryNo),
      costYesUsd: Number(session.inventoryYesCostUsd),
      costNoUsd: Number(session.inventoryNoCostUsd),
      realizedPnlUsd: Number(session.realizedPnlUsd),
      dailyLossUsd: Number(session.dailyLossUsd),
      dailyLossDay: session.dailyLossDay,
      pendingMerges: [],
      syncedLive: false,
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
      { ruleId: row.id, mode: session.mode, conditionId: def.action.market.conditionId },
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

  const cancelQuotes = async (
    loop: ActiveLoop,
    executor: QuoterExecutor,
    quotes: readonly RestingQuote[],
    cycleKey: string,
  ): Promise<void> => {
    for (const quote of quotes) {
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

  const halt = async (
    loop: ActiveLoop,
    executor: QuoterExecutor | null,
    reason: string,
    cycleKey: string,
  ): Promise<void> => {
    if (executor) await cancelQuotes(loop, executor, [...loop.resting], cycleKey);
    await quoterStore.updateSession(loop.sessionId, { status: "halted", haltedReason: reason });
    await record(loop, "halt", { reason }, `${cycleKey}:halt`);
    await auditStore.emit({
      actor: loop.walletAddress,
      action: "quoter.halted",
      subject: `rule:${loop.ruleId}`,
      metadata: { reason, mode: executor?.mode ?? "unresolved" },
    });
    logger.warn({ ruleId: loop.ruleId, reason }, "Maker loop halted");
  };

  /** Poll relayer merge confirmations from previous cycles. */
  const pollMerges = async (loop: ActiveLoop, executor: QuoterExecutor): Promise<void> => {
    for (const pm of [...loop.pendingMerges]) {
      const st = await executor.mergeState(pm.transactionId);
      if (!st.ok) continue; // transient — retry next cycle
      if (st.value === "pending") continue;
      loop.pendingMerges = loop.pendingMerges.filter((x) => x !== pm);
      await record(
        loop,
        "merge_confirmed",
        { transactionId: pm.transactionId, pairs: pm.pairs, outcome: st.value },
        `quoter:${loop.ruleId}:mergeconf:${pm.transactionId}`,
      );
      if (st.value === "failed") {
        // Inventory was decremented at submit; a failed merge means the pair
        // tokens are still held. Halt for manual review rather than guessing.
        await halt(loop, executor, "merge_failed", `quoter:${loop.ruleId}:mergefail`);
        return;
      }
    }
  };

  /** Venue open-order sync → fill deltas → inventory + cost pools + events. */
  const syncFills = async (
    loop: ActiveLoop,
    executor: QuoterExecutor,
    nowMs: number,
  ): Promise<boolean> => {
    const sync = await executor.syncOpenOrders();
    if (!sync.ok) {
      logger.warn({ ruleId: loop.ruleId, err: sync.message }, "Open-order sync failed");
      return false; // fail-closed: no order management on a blind cycle
    }
    const { fills, resting, adopted } = diffOpenOrders(loop.resting, sync.value, [
      loop.params.market.yesTokenId,
      loop.params.market.noTokenId,
    ]);
    loop.resting = [...resting];
    loop.syncedLive = true;
    if (adopted.length > 0) {
      logger.info(
        { ruleId: loop.ruleId, adopted: adopted.map((a) => a.orderId) },
        "Adopted venue orders after restart",
      );
    }
    for (const fill of fills) {
      const isYes = fill.tokenId === loop.params.market.yesTokenId;
      if (isYes) {
        loop.inventoryYes += fill.sizeFilled;
        loop.costYesUsd += fill.sizeFilled * fill.price;
      } else {
        loop.inventoryNo += fill.sizeFilled;
        loop.costNoUsd += fill.sizeFilled * fill.price;
      }
      await record(
        loop,
        "fill",
        {
          orderId: fill.orderId,
          tokenId: fill.tokenId,
          price: fill.price,
          sizeFilled: fill.sizeFilled,
          side: isYes ? "YES" : "NO",
          at: nowMs,
        },
        `quoter:${loop.ruleId}:fill:${fill.orderId}:${fill.cumulativeMatched}`,
      );
    }
    return true;
  };

  /** Merge whole pairs: realize PnL from the avg-cost pools at submit. */
  const executeMerge = async (
    loop: ActiveLoop,
    executor: QuoterExecutor,
    pairs: number,
    cycleKey: string,
  ): Promise<void> => {
    const key = `${cycleKey}:merge:${pairs}`;
    const res = await executor.mergePairs(pairs, key);
    if (!res.ok) {
      logger.warn({ ruleId: loop.ruleId, err: res.message }, "Merge submit failed");
      return;
    }
    const avgYes = loop.inventoryYes > 1e-9 ? loop.costYesUsd / loop.inventoryYes : 0;
    const avgNo = loop.inventoryNo > 1e-9 ? loop.costNoUsd / loop.inventoryNo : 0;
    // Each merged pair returns $1 of collateral; entry cost is avgYes + avgNo.
    const pnl = pairs * (1 - avgYes - avgNo);
    loop.inventoryYes = Math.max(0, loop.inventoryYes - pairs);
    loop.inventoryNo = Math.max(0, loop.inventoryNo - pairs);
    loop.costYesUsd = Math.max(0, loop.costYesUsd - avgYes * pairs);
    loop.costNoUsd = Math.max(0, loop.costNoUsd - avgNo * pairs);
    loop.realizedPnlUsd += pnl;
    if (pnl < 0) loop.dailyLossUsd += -pnl;
    if (res.value.transactionId) {
      loop.pendingMerges.push({ transactionId: res.value.transactionId, pairs });
    }
    await record(
      loop,
      "merge_submitted",
      { pairs, transactionId: res.value.transactionId, realizedPnlUsd: pnl },
      key,
    );
    await auditStore.emit({
      actor: loop.walletAddress,
      action: "quoter.merge_submitted",
      subject: `rule:${loop.ruleId}`,
      metadata: { pairs, mode: executor.mode, realizedPnlUsd: pnl },
    });
  };

  const executePlaces = async (
    loop: ActiveLoop,
    executor: QuoterExecutor,
    places: readonly QuoteIntent[],
    cycleKey: string,
  ): Promise<void> => {
    for (const place of places) {
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
  };

  const persistScoreboard = async (
    loop: ActiveLoop,
    mid: number | null,
    nowMs: number,
  ): Promise<void> => {
    await quoterStore.updateSession(loop.sessionId, {
      status: loop.resting.length > 0 ? "quoting" : "idle",
      inventoryYes: loop.inventoryYes,
      inventoryNo: loop.inventoryNo,
      inventoryYesCostUsd: loop.costYesUsd,
      inventoryNoCostUsd: loop.costNoUsd,
      realizedPnlUsd: loop.realizedPnlUsd,
      dailyLossUsd: loop.dailyLossUsd,
      dailyLossDay: loop.dailyLossDay,
      capitalCommittedUsd: capitalCommittedUsd(
        loop.resting,
        loop.inventoryYes,
        loop.inventoryNo,
        mid,
      ),
      lastCycleAt: new Date(nowMs),
    });
  };

  const cycle = async (loop: ActiveLoop, nowMs: number): Promise<void> => {
    const cycleKey = `quoter:${loop.ruleId}:${nowMs}`;

    // 1. Re-read the session: the API's mode flips, halts, resumes and batch
    // approvals all take effect within one cycle. Memory stays authoritative
    // for inventory/PnL (single writer); the DB is authoritative for control.
    const session = await quoterStore.findSessionByRuleId(loop.ruleId);
    if (!session || session.status === "halted") return;

    // 2. Kill switches: idle without halting (auto-recovers when cleared).
    if (
      (await flagIsTrue("trading_paused")) ||
      (await flagIsTrue("quoter_paused")) ||
      (await flagIsTrue(`rule_auto_disabled:${loop.ruleId}`))
    ) {
      if (loop.resting.length > 0) {
        const res = await executorProvider.forLoop(
          loopContext(loop),
          session.mode as QuoteSessionMode,
        );
        if ("executor" in res) {
          await cancelQuotes(loop, res.executor, [...loop.resting], cycleKey);
          await quoterStore.updateSession(loop.sessionId, { status: "idle" });
        }
      }
      return;
    }

    // 3. Resolve the executor for THIS cycle's mode. Fail-closed: a live/
    // confirm session whose prerequisites are missing halts loudly.
    const resolution = await executorProvider.forLoop(
      loopContext(loop),
      session.mode as QuoteSessionMode,
    );
    if ("unavailable" in resolution) {
      await halt(loop, null, resolution.unavailable, cycleKey);
      return;
    }
    const executor = resolution.executor;
    const isLiveExecutor = executor.mode === "live";

    // 4. Live only: merge confirmations, then venue open-order sync → fills.
    if (isLiveExecutor) {
      // Virtual (shadow-phase) quotes don't exist on the venue — a mode flip
      // must not let them masquerade as resting orders.
      loop.resting = loop.resting.filter((r) => r.orderId !== null);
      await pollMerges(loop, executor);
      const synced = await syncFills(loop, executor, nowMs);
      if (!synced) return; // blind cycle — no order management
    }

    // 5. Daily-loss rollover (UTC).
    const day = utcDay(nowMs);
    if (loop.dailyLossDay !== day) {
      loop.dailyLossDay = day;
      loop.dailyLossUsd = 0;
    }

    // 6. Gate expression (fail-closed: stale gate data = quotes down).
    const yesView = latestView.get(loop.params.market.yesTokenId);
    const desired: DesiredQuotes = gateSatisfied(loop, nowMs)
      ? computeDesiredQuotes(loop.params, yesView, nowMs, loop.def.maxDataAgeMs)
      : { kind: "idle", reason: "gate_unsatisfied" };

    // 7. Cap checks BEFORE placing anything new.
    const mid = desired.kind === "quote" ? desired.mid : null;
    const committed = capitalCommittedUsd(loop.resting, loop.inventoryYes, loop.inventoryNo, mid);
    const breach = capBreach(committed, loop.dailyLossUsd, loop.params);
    if (breach) {
      await halt(loop, executor, breach, cycleKey);
      await persistScoreboard(loop, mid, nowMs);
      return;
    }

    // 8. Inventory plan: merge-ready pairs, one-sided exposure breach.
    const plan = inventoryPlan(loop.inventoryYes, loop.inventoryNo, loop.params);
    if (plan.breach) {
      await halt(loop, executor, plan.breach, cycleKey);
      await persistScoreboard(loop, mid, nowMs);
      return;
    }

    // 9. Reconcile quotes → the cycle's intended actions.
    const diff = diffQuotes(loop.resting, desired, loop.params.requoteToleranceCents);

    if (session.mode === "confirm") {
      // Confirm mode: cancels are risk-REDUCING and execute immediately;
      // places and merges execute only under a hash-matching approval.
      await cancelQuotes(loop, executor, diff.cancels, cycleKey);
      const batch: ProposedBatch = {
        cancels: [],
        places: diff.places,
        mergePairs: plan.mergePairs,
      };
      if (batch.places.length === 0 && batch.mergePairs === 0) {
        if (session.pendingBatchHash !== null) {
          await quoterStore.updateSession(loop.sessionId, {
            pendingBatch: null,
            pendingBatchHash: null,
            pendingBatchAt: null,
            approvedBatchHash: null,
            approvedAt: null,
          });
        }
      } else {
        const hash = computeBatchHash(batch);
        if (session.approvedBatchHash === hash) {
          // Approved and STILL current — execute, then clear the protocol state.
          if (batch.mergePairs > 0) await executeMerge(loop, executor, batch.mergePairs, cycleKey);
          await executePlaces(loop, executor, batch.places, cycleKey);
          await quoterStore.updateSession(loop.sessionId, {
            pendingBatch: null,
            pendingBatchHash: null,
            pendingBatchAt: null,
            approvedBatchHash: null,
            approvedAt: null,
          });
        } else if (session.pendingBatchHash !== hash) {
          // New (or changed) proposal — replaces the old one and voids any
          // approval that pointed at it.
          await quoterStore.updateSession(loop.sessionId, {
            pendingBatch: batch as unknown as Record<string, unknown>,
            pendingBatchHash: hash,
            pendingBatchAt: new Date(nowMs),
            approvedBatchHash: null,
            approvedAt: null,
          });
          await record(
            loop,
            "batch_proposed",
            { batch, hash, mid },
            `quoter:${loop.ruleId}:batch:${hash}`,
          );
        }
        // else: same proposal still awaiting approval — nothing to do.
      }
    } else {
      // Shadow / live: execute the whole cycle directly.
      if (plan.mergePairs > 0) await executeMerge(loop, executor, plan.mergePairs, cycleKey);
      await cancelQuotes(loop, executor, diff.cancels, cycleKey);
      await executePlaces(loop, executor, diff.places, cycleKey);
    }

    // 10. Scoreboard + cycle event.
    await persistScoreboard(loop, mid, nowMs);
    await record(loop, "cycle", {
      desired: desired.kind,
      ...(desired.kind === "idle" ? { reason: desired.reason } : { mid: desired.mid }),
      mode: session.mode,
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
      logger.info({ reloadIntervalMs, cycleMinIntervalMs }, "Maker-loop quoter started");
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
