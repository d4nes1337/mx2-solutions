/**
 * Worker-level tests for the freshness/dwell behavior of the rule evaluator.
 *
 * The production failure these lock in: a 15-minute hold on a QUIET but live
 * market never fired, because freshness only advanced on full `book` WS
 * messages — every gap > maxDataAgeMs reset the accumulating window. The
 * evaluator now (a) refreshes freshness on price_change deltas + trade
 * heartbeats, (b) background-verifies quiet books over REST while the WS
 * transport is healthy, and (c) still fails closed when the feed is down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "@mx2/observability";
import type { AuditStore, ConditionalRuleRow, RuleStore, TriggerStore } from "@mx2/db";
import type { MarketDataView, StrategyDefinition } from "@mx2/rules";
import { createRuleEvaluatorManager, type RuleEvaluatorOptions } from "./rule-evaluator.js";

const TOKEN = "token-1";
const COND = "cond-1";
const WALLET = "0xowner";
const logger = createLogger({ name: "rule-eval-test", level: "silent" });

const defV2 = (over: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
  version: 2,
  name: "test",
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
          market: { conditionId: COND, tokenId: TOKEN, outcome: "YES" },
          source: "ask",
          comparator: "lte",
          threshold: 0.61,
        },
      },
    ],
  },
  holdsForMs: 900_000,
  maxDataAgeMs: 30_000,
  action: { kind: "alert" },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  ...over,
});

const makeRow = (
  def: StrategyDefinition,
  over: Partial<ConditionalRuleRow> = {},
): ConditionalRuleRow => ({
  id: "rule-1",
  walletAddress: WALLET,
  conditionId: COND,
  tokenId: TOKEN,
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
  name: "test",
  templateId: null,
  tokenIds: [TOKEN],
  triggerCount: 0,
  cooldownUntil: null,
  runtimeWatermarks: null,
  totalNotionalExecuted: "0",
  tags: [],
  archivedAt: null,
  starredAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const view = (ask: number, tMs: number): MarketDataView => ({
  tokenId: TOKEN,
  conditionId: COND,
  bids: [{ price: ask - 0.01, size: 100 }],
  asks: [{ price: ask, size: 100 }],
  marketStatus: "open",
  sourceTimeMs: tMs,
  receivedAtMs: tMs,
});

interface AuditRecord {
  action: string;
  metadata: Record<string, unknown>;
}

interface Harness {
  evaluator: ReturnType<typeof createRuleEvaluatorManager>;
  triggers: unknown[];
  audits: AuditRecord[];
  rows: ConditionalRuleRow[];
  fetches: number;
}

const EVALUABLE = new Set(["ACTIVE_WAITING", "ACTIVE_ACCUMULATING"]);

const makeHarness = (
  rows: ConditionalRuleRow[],
  over: Partial<RuleEvaluatorOptions> = {},
): Harness => {
  const triggers: unknown[] = [];
  const audits: AuditRecord[] = [];
  const h: Harness = { evaluator: null as never, triggers, audits, rows, fetches: 0 };

  const ruleStore = {
    listEvaluable: async () => rows.filter((r) => EVALUABLE.has(r.status)),
    updateEvaluationState: async (
      id: string,
      update: { status: string; trueSinceMs: number | null; lastEvaluatedAt: Date },
    ) => {
      const row = rows.find((r) => r.id === id);
      if (!row || !EVALUABLE.has(row.status)) return null;
      row.status = update.status;
      row.trueSince = update.trueSinceMs === null ? null : new Date(update.trueSinceMs);
      row.lastEvaluatedAt = update.lastEvaluatedAt;
      return row;
    },
    cancel: async () => null,
  } as unknown as RuleStore;

  const triggerStore = {
    create: async (o: Record<string, unknown>) => {
      const trig = { id: `trig-${triggers.length + 1}`, ...o };
      triggers.push(trig);
      return trig;
    },
    hasForRule: async () => false,
  } as unknown as TriggerStore;

  const auditStore = {
    emit: async (e: AuditRecord) => {
      audits.push(e);
      return e;
    },
  } as unknown as AuditStore;

  h.evaluator = createRuleEvaluatorManager({
    logger,
    ruleStore,
    triggerStore,
    auditStore,
    subscribe: () => {},
    unsubscribe: () => {},
    ...over,
  });
  return h;
};

const churnReasons = (audits: AuditRecord[], reason: string): AuditRecord[] =>
  audits.filter((a) => a.action === "rule.state_changed" && a.metadata["reason"] === reason);

describe("rule evaluator freshness & dwell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes a 15-minute hold on a quiet live book (deltas + heartbeats only)", async () => {
    // THE production bug scenario: one full book at t=0, then only
    // price_change deltas / trade heartbeats every 20 s. With 30 s
    // maxDataAgeMs this must accumulate straight through and fire once.
    const h = makeHarness([makeRow(defV2())]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    h.evaluator.onBook(view(0.59, Date.now()));
    await vi.advanceTimersByTimeAsync(1);

    for (let i = 0; i < 46; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      if (i % 2 === 0) {
        h.evaluator.onBookDelta(TOKEN, [{ price: 0.6, size: 150, side: "ask" }], Date.now());
      } else {
        h.evaluator.onHeartbeat(TOKEN, Date.now());
      }
    }
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.triggers).toHaveLength(1);
    expect(churnReasons(h.audits, "DATA_STALE")).toHaveLength(0);
    expect(h.rows[0]!.status).toBe("COMPLETED");
    h.evaluator.stop();
  });

  it("book deltas patch the cached view (a delta can flip the condition)", async () => {
    const h = makeHarness([makeRow(defV2({ holdsForMs: 10_000 }))]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    // Best ask 0.65 → condition (ask ≤ 0.61) fails.
    h.evaluator.onBook(view(0.65, Date.now()));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rows[0]!.status).toBe("ACTIVE_WAITING");
    // Delta inserts a better ask at 0.59 → condition satisfied → window starts.
    h.evaluator.onBookDelta(TOKEN, [{ price: 0.59, size: 50, side: "ask" }], Date.now());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rows[0]!.status).toBe("ACTIVE_ACCUMULATING");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.triggers).toHaveLength(1);
    h.evaluator.stop();
  });

  it("REST verification keeps a totally silent book fresh while the feed is connected", async () => {
    const h = makeHarness([makeRow(defV2({ holdsForMs: 60_000 }))], {
      fetchOrderbook: async () => {
        h.fetches++;
        return view(0.59, Date.now());
      },
      isFeedConnected: () => true,
    });
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    h.evaluator.onBook(view(0.59, Date.now()));
    // 70 s with ZERO further WS traffic — REST re-fetch must carry freshness.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.fetches).toBeGreaterThan(0);
    expect(h.triggers).toHaveLength(1);
    expect(churnReasons(h.audits, "DATA_STALE")).toHaveLength(0);
    h.evaluator.stop();
  });

  it("fails closed when the feed is disconnected: pause, then reset past the grace", async () => {
    const h = makeHarness([makeRow(defV2({ holdsForMs: 60_000 }))], {
      fetchOrderbook: async () => {
        h.fetches++;
        return view(0.59, Date.now());
      },
      isFeedConnected: () => false,
    });
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    h.evaluator.onBook(view(0.59, Date.now()));
    // Inside maxDataAge + grace the window only PAUSES (no trigger either way).
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.fetches).toBe(0);
    expect(h.triggers).toHaveLength(0);
    expect(h.rows[0]!.status).toBe("ACTIVE_ACCUMULATING");
    expect(churnReasons(h.audits, "STALE_PAUSED").length).toBeGreaterThan(0);
    // Past maxDataAge (30s default) + grace (60s default) the reset lands.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.triggers).toHaveLength(0);
    expect(h.rows[0]!.status).toBe("ACTIVE_WAITING");
    expect(churnReasons(h.audits, "DATA_STALE").length).toBeGreaterThan(0);
    h.evaluator.stop();
  });

  it("reconnect pauses an accumulating window; a dark grace expiry resets (audited)", async () => {
    const h = makeHarness([makeRow(defV2({ holdsForMs: 60_000 }))]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    h.evaluator.onBook(view(0.59, Date.now()));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.rows[0]!.status).toBe("ACTIVE_ACCUMULATING");
    h.evaluator.onReconnect();
    await vi.advanceTimersByTimeAsync(1);
    // No proof the market moved — the window pauses instead of resetting.
    expect(h.rows[0]!.status).toBe("ACTIVE_ACCUMULATING");
    expect(churnReasons(h.audits, "STALE_PAUSED").length).toBeGreaterThan(0);
    // Feed stays dark past the 60s grace → conservative reset.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.rows[0]!.status).toBe("ACTIVE_WAITING");
    expect(churnReasons(h.audits, "DATA_STALE").length).toBeGreaterThan(0);
    expect(h.triggers).toHaveLength(0);
    h.evaluator.stop();
  });

  it("resumes a mid-accumulation window across restart when the row is still fresh", async () => {
    const now = Date.now();
    const h = makeHarness([
      makeRow(defV2({ holdsForMs: 60_000 }), {
        status: "ACTIVE_ACCUMULATING",
        trueSince: new Date(now - 50_000),
        lastEvaluatedAt: new Date(now - 10_000),
      }),
    ]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    h.evaluator.onBook(view(0.59, Date.now()));
    // 50 s already accumulated before "restart" — only ~10 s more needed.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.triggers).toHaveLength(1);
    h.evaluator.stop();
  });

  it("resets (with audit) across restart when the row went stale while down", async () => {
    const now = Date.now();
    const h = makeHarness([
      makeRow(defV2({ holdsForMs: 60_000 }), {
        status: "ACTIVE_ACCUMULATING",
        trueSince: new Date(now - 50_000),
        lastEvaluatedAt: new Date(now - 120_000),
      }),
    ]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(churnReasons(h.audits, "RESTART_RESET")).toHaveLength(1);
    h.evaluator.onBook(view(0.59, Date.now()));
    await vi.advanceTimersByTimeAsync(15_000);
    // Not resumed: the window restarted, so 15 s < 60 s → no trigger yet.
    expect(h.triggers).toHaveLength(0);
    h.evaluator.stop();
  });

  it("rate-limits churn audits per (rule, reason)", async () => {
    const h = makeHarness([makeRow(defV2({ holdsForMs: 600_000, maxDataAgeMs: 5_000 }))]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    // Four stale-pause→resume cycles inside one minute (7 s gaps sit inside
    // the 10 s grace, so the window survives each one — by design).
    for (let i = 0; i < 4; i++) {
      h.evaluator.onBook(view(0.59, Date.now()));
      await vi.advanceTimersByTimeAsync(7_000); // > maxDataAgeMs → stale pause
    }
    expect(churnReasons(h.audits, "WINDOW_STARTED")).toHaveLength(1);
    expect(churnReasons(h.audits, "STALE_PAUSED")).toHaveLength(1);
    expect(churnReasons(h.audits, "STALE_RESUMED")).toHaveLength(1);
    expect(churnReasons(h.audits, "DATA_STALE")).toHaveLength(0);
    h.evaluator.stop();
  });

  it("heartbeats never fabricate freshness for a token with no cached book", async () => {
    const h = makeHarness([makeRow(defV2({ holdsForMs: 10_000 }))]);
    h.evaluator.start();
    await vi.advanceTimersByTimeAsync(1);
    // No onBook ever — heartbeats/deltas alone must not create a view.
    h.evaluator.onHeartbeat(TOKEN, Date.now());
    h.evaluator.onBookDelta(TOKEN, [{ price: 0.59, size: 50, side: "ask" }], Date.now());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.triggers).toHaveLength(0);
    expect(h.rows[0]!.status).toBe("ACTIVE_WAITING");
    h.evaluator.stop();
  });
});
