import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  AuditStore,
  CommitTrigger,
  ConditionalRuleRow,
  RuleStore,
  RuleTriggerRow,
} from "@mx2/db";
import type {
  MarketDataView,
  ResolvedSeriesWindow,
  SeriesRef,
  StrategyDefinition,
} from "@mx2/rules";
import { createRuleEvaluatorManager, type RuleEvaluatorOptions } from "./rule-evaluator.js";

/**
 * Rolling series bindings (ADR-0028) end to end through the evaluator: the
 * approved walkthrough, executed. One strategy watches a stable market and
 * enters "whichever BTC 5-minute window is live" — across three consecutive
 * windows with one entry, one price skip and one too-late skip.
 */

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as RuleEvaluatorOptions["logger"];

const WALLET = "0xwallet";
/** The stable market the CONDITION watches (never rolls). */
const TRIGGER_TOKEN = "trigger-token";
const TRIGGER_COND = "trigger-cond";
const WINDOW_MS = 5 * 60_000;
const T0 = Date.parse("2026-07-27T09:20:00Z"); // a clean 5-minute boundary

const seriesRef: SeriesRef = {
  kind: "series",
  seriesSlug: "btc-up-or-down-5m",
  outcome: "Up",
  selector: "current",
  maxEntryPrice: 0.6,
  minRemainingMs: 30_000,
};

/** "Buy $ of UP on the freshest BTC 5m window when the watched market is cheap." */
const rollingDef = (over: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
  version: 2,
  name: "BTC 5m scalp",
  templateId: null,
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "c1",
        condition: {
          kind: "price",
          market: { conditionId: TRIGGER_COND, tokenId: TRIGGER_TOKEN, outcome: "YES" },
          source: "ask",
          comparator: "lte",
          threshold: 0.5,
        },
      },
    ],
  },
  holdsForMs: 0,
  maxDataAgeMs: 30_000,
  action: {
    kind: "order",
    // The anchor: the window that was live when the strategy was built. It is
    // already dead by the time the tests run — nothing may trade it.
    market: { conditionId: "anchor-cond", tokenId: "anchor-token", outcome: "Up" },
    rollingSeries: seriesRef,
    side: "BUY",
    price: 0.6,
    size: 50,
    orderType: "FAK",
    execution: "prepare",
  },
  recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: 0 },
  limits: null,
  expiresAtMs: null,
  ...over,
});

const makeRow = (def: StrategyDefinition): ConditionalRuleRow =>
  ({
    id: "rule-1",
    walletAddress: WALLET,
    conditionId: TRIGGER_COND,
    tokenId: TRIGGER_TOKEN,
    side: "BUY",
    definition: def,
    definitionHash: "hash-1",
    status: "ACTIVE_WAITING",
    version: 2,
    trueSince: null,
    staleSince: null,
    supersedes: null,
    supersededBy: null,
    expiresAt: null,
    pausedAt: null,
    lastEvaluatedAt: null,
    errorMessage: null,
    name: "BTC 5m scalp",
    templateId: null,
    tokenIds: [TRIGGER_TOKEN],
    triggerCount: 0,
    cooldownUntil: null,
    runtimeWatermarks: null,
    totalNotionalExecuted: "0",
    tags: [],
    archivedAt: null,
    starredAt: null,
    seriesSlug: "btc-up-or-down-5m",
    lastSeriesWindowStart: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as unknown as ConditionalRuleRow;

/** The condition's market — satisfied at 0.40, unsatisfied at 0.80. */
const view = (ask: number, tMs: number): MarketDataView => ({
  tokenId: TRIGGER_TOKEN,
  conditionId: TRIGGER_COND,
  bids: [{ price: ask - 0.01, size: 100 }],
  asks: [{ price: ask, size: 100 }],
  marketStatus: "open",
  sourceTimeMs: tMs,
  receivedAtMs: tMs,
});

/** The Nth 5-minute window from T0, priced as the test dictates. */
const windowN = (n: number, bestAsk: number | null): ResolvedSeriesWindow => {
  const startMs = T0 + n * WINDOW_MS;
  return {
    market: {
      conditionId: `cond-w${n}`,
      tokenId: `token-w${n}`,
      outcome: "Up",
      title: `Bitcoin Up or Down — window ${n}`,
    },
    windowStartMs: startMs,
    windowEndMs: startMs + WINDOW_MS,
    bestAsk,
    slug: `btc-updown-5m-${Math.floor(startMs / 1000)}`,
  };
};

interface AuditRecord {
  action: string;
  metadata: Record<string, unknown>;
}

const makeHarness = (row: ConditionalRuleRow, windowFor: () => ResolvedSeriesWindow | null) => {
  const rows = [row];
  const triggers: { id: string; evidence: Record<string, unknown> }[] = [];
  const audits: AuditRecord[] = [];
  const claims: number[] = [];
  const EVALUABLE = new Set(["ACTIVE_WAITING", "ACTIVE_ACCUMULATING"]);

  const ruleStore = {
    listEvaluable: async () => rows.filter((r) => EVALUABLE.has(r.status)),
    updateEvaluationState: async (
      id: string,
      update: {
        status: string;
        trueSinceMs: number | null;
        lastEvaluatedAt: Date;
        triggerCount?: number;
        cooldownUntilMs?: number | null;
      },
    ) => {
      const r = rows.find((x) => x.id === id);
      if (!r || !EVALUABLE.has(r.status)) return null;
      r.status = update.status;
      r.trueSince = update.trueSinceMs === null ? null : new Date(update.trueSinceMs);
      r.lastEvaluatedAt = update.lastEvaluatedAt;
      if (update.triggerCount !== undefined) r.triggerCount = update.triggerCount;
      if (update.cooldownUntilMs !== undefined)
        r.cooldownUntil = update.cooldownUntilMs === null ? null : new Date(update.cooldownUntilMs);
      return r;
    },
    // Real CAS semantics: a window can only ever be claimed once.
    claimSeriesWindow: async (id: string, windowStartMs: number) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.lastSeriesWindowStart === windowStartMs) return false;
      r.lastSeriesWindowStart = windowStartMs;
      claims.push(windowStartMs);
      return true;
    },
    cancel: async () => null,
  } as unknown as RuleStore;

  // Atomic-commit fake with the same CAS + unique-(rule, triggerNumber)
  // semantics as packages/db/src/trigger-commit.ts.
  const commitTrigger: CommitTrigger = async (o) => {
    const r = rows.find((x) => x.id === o.ruleId);
    if (!r || !EVALUABLE.has(r.status)) return { outcome: "cas_lost" };
    r.status = o.stateUpdate.status;
    r.trueSince = o.stateUpdate.trueSinceMs === null ? null : new Date(o.stateUpdate.trueSinceMs);
    r.lastEvaluatedAt = o.stateUpdate.lastEvaluatedAt;
    if (o.stateUpdate.triggerCount !== undefined) r.triggerCount = o.stateUpdate.triggerCount;
    if (o.stateUpdate.cooldownUntilMs !== undefined) {
      r.cooldownUntil =
        o.stateUpdate.cooldownUntilMs === null ? null : new Date(o.stateUpdate.cooldownUntilMs);
    }
    const tn = (o.trigger.evidence as { triggerNumber?: number }).triggerNumber;
    if (
      tn !== undefined &&
      triggers.some((t) => (t.evidence as { triggerNumber?: number }).triggerNumber === tn)
    ) {
      return { outcome: "duplicate", rule: r };
    }
    const trig = {
      id: `trig-${triggers.length + 1}`,
      evidence: o.trigger.evidence as unknown as Record<string, unknown>,
    };
    triggers.push(trig);
    return { outcome: "committed", rule: r, trigger: trig as unknown as RuleTriggerRow };
  };

  const auditStore = {
    emit: async (e: AuditRecord) => {
      audits.push(e);
      return e;
    },
  } as unknown as AuditStore;

  const evaluator = createRuleEvaluatorManager({
    logger,
    ruleStore,
    commitTrigger,
    auditStore,
    subscribe: () => {},
    unsubscribe: () => {},
    resolveRollingWindow: async () => windowFor(),
  });

  return { evaluator, rows, triggers, audits, claims };
};

const skips = (audits: AuditRecord[]) =>
  audits.filter((a) => a.action === "rule.execution.skipped");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
});
afterEach(() => vi.useRealTimers());

describe("rolling series bindings across consecutive windows", () => {
  it("enters window 1, skips window 2 on price, skips window 3 on time — refunding both", async () => {
    let current: ResolvedSeriesWindow | null = null;
    const h = makeHarness(makeRow(rollingDef()), () => current);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);

    // ── Window 1: 51¢ ask, 4 minutes left → ENTER ──
    vi.setSystemTime(new Date(T0 + 60_000));
    current = windowN(0, 0.51);
    h.evaluator.onBook(view(0.4, T0 + 60_000));
    await vi.advanceTimersByTimeAsync(50);

    expect(h.triggers).toHaveLength(1);
    const evidence = h.triggers[0]!.evidence as {
      preparedAction: { market: { tokenId: string }; price: number; rollingSeries?: unknown };
      seriesWindow: { slug: string; windowStartMs: number };
      tokenId: string;
    };
    // It traded the LIVE window, never the anchor baked into the definition.
    expect(evidence.preparedAction.market.tokenId).toBe("token-w0");
    expect(evidence.tokenId).toBe("token-w0");
    expect(evidence.preparedAction.rollingSeries).toBeUndefined();
    // Marketable limit at the user's own ceiling, not the raw ask.
    expect(evidence.preparedAction.price).toBe(0.6);
    expect(evidence.seriesWindow.windowStartMs).toBe(T0);
    expect(h.rows[0]!.triggerCount).toBe(1);
    expect(h.claims).toEqual([T0]);

    // ── Window 2: 72¢ ask → SKIP (above the 60¢ ceiling) ──
    const t2 = T0 + WINDOW_MS + 60_000;
    vi.setSystemTime(new Date(t2));
    current = windowN(1, 0.72);
    h.evaluator.onBook(view(0.8, t2)); // condition off…
    await vi.advanceTimersByTimeAsync(50);
    h.evaluator.onBook(view(0.4, t2)); // …and on again, so it re-fires
    await vi.advanceTimersByTimeAsync(50);

    expect(h.triggers).toHaveLength(1); // no new trigger
    const priceSkip = skips(h.audits).at(-1)!;
    expect(priceSkip.metadata["reason"]).toBe("series_price_above_ceiling");
    expect(priceSkip.metadata["bestAsk"]).toBe(0.72);
    // The refund: a skipped window costs no money and no repeat budget.
    expect(h.rows[0]!.triggerCount).toBe(1);
    expect(h.claims).toEqual([T0]);

    // ── Window 3: cheap, but only 10s left → SKIP (below the 30s floor) ──
    const t3 = T0 + 2 * WINDOW_MS + (WINDOW_MS - 10_000);
    vi.setSystemTime(new Date(t3));
    current = windowN(2, 0.45);
    h.evaluator.onBook(view(0.8, t3));
    await vi.advanceTimersByTimeAsync(50);
    h.evaluator.onBook(view(0.4, t3));
    await vi.advanceTimersByTimeAsync(50);

    expect(h.triggers).toHaveLength(1);
    const timeSkip = skips(h.audits).at(-1)!;
    expect(timeSkip.metadata["reason"]).toBe("series_window_too_short");
    // ~10s left against a 30s floor (exact ms drifts with the timer advance).
    expect(timeSkip.metadata["remainingMs"] as number).toBeLessThan(30_000);
    expect(timeSkip.metadata["requiredMs"]).toBe(30_000);
    expect(h.rows[0]!.triggerCount).toBe(1);

    // Still armed and still holding budget for 2 more windows.
    expect(h.rows[0]!.status).toBe("ACTIVE_WAITING");
  });

  it("never enters the same window twice, even if the condition re-fires", async () => {
    const current: ResolvedSeriesWindow | null = windowN(0, 0.51);
    const h = makeHarness(makeRow(rollingDef()), () => current);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);

    const t = T0 + 30_000;
    vi.setSystemTime(new Date(t));
    h.evaluator.onBook(view(0.4, t));
    await vi.advanceTimersByTimeAsync(50);
    expect(h.triggers).toHaveLength(1);

    // Same window, condition flaps off and on again.
    h.evaluator.onBook(view(0.8, t + 1_000));
    await vi.advanceTimersByTimeAsync(50);
    vi.setSystemTime(new Date(t + 60_000));
    h.evaluator.onBook(view(0.4, t + 60_000));
    await vi.advanceTimersByTimeAsync(50);

    expect(h.triggers).toHaveLength(1); // one entry per window, guaranteed
    expect(skips(h.audits).at(-1)!.metadata["reason"]).toBe("series_window_already_traded");
    expect(h.claims).toEqual([T0]);
    void current;
  });

  it("fails closed when the window cannot be resolved — no order, still armed", async () => {
    const h = makeHarness(makeRow(rollingDef()), () => null);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);

    const t = T0 + 30_000;
    vi.setSystemTime(new Date(t));
    h.evaluator.onBook(view(0.4, t));
    await vi.advanceTimersByTimeAsync(50);

    expect(h.triggers).toHaveLength(0);
    expect(skips(h.audits).at(-1)!.metadata["reason"]).toBe("series_unresolved");
    expect(h.rows[0]!.triggerCount).toBe(0);
    expect(h.rows[0]!.status).toBe("ACTIVE_WAITING");
  });

  it("skips rather than guessing when the resolved window has no book", async () => {
    const h = makeHarness(makeRow(rollingDef()), () => windowN(0, null));
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);

    const t = T0 + 30_000;
    vi.setSystemTime(new Date(t));
    h.evaluator.onBook(view(0.4, t));
    await vi.advanceTimersByTimeAsync(50);

    expect(h.triggers).toHaveLength(0);
    expect(skips(h.audits).at(-1)!.metadata["reason"]).toBe("series_no_book");
  });
});
