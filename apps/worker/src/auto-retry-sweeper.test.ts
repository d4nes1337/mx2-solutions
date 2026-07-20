/**
 * Decision table for the bounded funds-arrival retry sweeper: retries only
 * with fresh satisfied conditions and the SAME triggerId (idempotent), and
 * abandons loudly in every other case.
 */
import { describe, it, expect } from "vitest";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  ConditionalRuleRow,
  NotificationOutboxStore,
  RuleStore,
  RuleTriggerRow,
  TriggerStore,
} from "@mx2/db";
import type { MarketDataView, StrategyDefinition } from "@mx2/rules";
import { createAutoRetrySweeper } from "./auto-retry-sweeper.js";
import type { AutoExecuteInput } from "./auto-executor.js";

const logger = createLogger({ name: "retry-test", level: "silent" });
const TOKEN = "token-1";
const WALLET = "0xowner";

const def = (over: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
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
          market: { conditionId: "cond-1", tokenId: TOKEN, outcome: "YES" },
          source: "ask",
          comparator: "lte",
          threshold: 0.61,
        },
      },
    ],
  },
  holdsForMs: 0,
  maxDataAgeMs: 30_000,
  action: {
    kind: "order",
    market: { conditionId: "cond-1", tokenId: TOKEN, outcome: "YES" },
    side: "BUY",
    price: 0.6,
    size: 10,
    orderType: "GTC",
    execution: "auto",
  },
  recurrence: { kind: "once" },
  limits: { maxNotionalPerOrder: 10, maxTotalNotional: 30, maxDailyNotional: 30 },
  expiresAtMs: null,
  ...over,
});

const view = (ask: number): MarketDataView => ({
  tokenId: TOKEN,
  conditionId: "cond-1",
  bids: [{ price: ask - 0.02, size: 100 }],
  asks: [{ price: ask, size: 100 }],
  marketStatus: "open",
  sourceTimeMs: Date.now(),
  receivedAtMs: Date.now(),
});

const retryTrigger = (over: Partial<RuleTriggerRow> = {}): RuleTriggerRow =>
  ({
    id: "trig-1",
    ruleId: "rule-1",
    walletAddress: WALLET,
    status: "awaiting_user",
    evidence: {},
    autoRetryUntil: new Date(Date.now() + 10 * 60_000),
    autoRetryReason: "insufficient_balance",
    ...over,
  }) as RuleTriggerRow;

interface HarnessOpts {
  retryable?: RuleTriggerRow[];
  lapsed?: RuleTriggerRow[];
  ruleStatus?: string;
  definition?: StrategyDefinition;
  ask?: number | null; // null = fetch failure
}

const makeHarness = (opts: HarnessOpts = {}) => {
  const executed: AutoExecuteInput[] = [];
  const cleared: string[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const notified: string[] = [];
  const rule = {
    id: "rule-1",
    walletAddress: WALLET,
    tokenId: TOKEN,
    name: "Test strategy",
    status: opts.ruleStatus ?? "TRIGGERED_AWAITING_USER",
    definition: opts.definition ?? def(),
    runtimeWatermarks: null,
  } as unknown as ConditionalRuleRow;
  const sweeper = createAutoRetrySweeper({
    logger,
    ruleStore: { findById: async () => rule } as unknown as RuleStore,
    triggerStore: {
      listAutoRetryable: async () => opts.retryable ?? [],
      listAutoRetryLapsed: async () => opts.lapsed ?? [],
      clearAutoRetry: async (id: string) => {
        cleared.push(id);
      },
    } as unknown as TriggerStore,
    auditStore: {
      emit: async (e: { action: string; metadata: Record<string, unknown> }) => {
        audits.push(e);
      },
    } as unknown as AuditStore,
    autoExecutor: {
      execute: async (input: AutoExecuteInput) => {
        executed.push(input);
      },
    },
    fetchOrderbook: async () => (opts.ask == null ? null : view(opts.ask)),
    outbox: {
      enqueue: async (e: { dedupeKey: string }) => {
        notified.push(e.dedupeKey);
        return null;
      },
    } as unknown as NotificationOutboxStore,
  });
  return { sweeper, executed, cleared, audits, notified };
};

const abandonReasons = (h: ReturnType<typeof makeHarness>): string[] =>
  h.audits
    .filter((a) => a.action === "rule.execution.retry_abandoned")
    .map((a) => a.metadata.reason as string);

describe("auto-retry sweeper", () => {
  it("lapsed window → abandoned + user notified", async () => {
    const h = makeHarness({ lapsed: [retryTrigger()] });
    await h.sweeper.runOnce();
    expect(h.cleared).toEqual(["trig-1"]);
    expect(abandonReasons(h)).toEqual(["retry_window_expired"]);
    expect(h.notified).toEqual(["retry-abandoned:trig-1"]);
    expect(h.executed).toHaveLength(0);
  });

  it("rule paused/cancelled meanwhile → abandoned (user wins)", async () => {
    const h = makeHarness({ retryable: [retryTrigger()], ruleStatus: "CANCELLED", ask: 0.6 });
    await h.sweeper.runOnce();
    expect(abandonReasons(h)).toEqual(["rule_inactive"]);
    expect(h.executed).toHaveLength(0);
  });

  it("conditions no longer satisfied on fresh books → abandoned, no execution", async () => {
    const h = makeHarness({ retryable: [retryTrigger()], ask: 0.9 });
    await h.sweeper.runOnce();
    expect(abandonReasons(h)).toEqual(["conditions_no_longer_met"]);
    expect(h.executed).toHaveLength(0);
  });

  it("conditions satisfied fresh → executes with the SAME triggerId", async () => {
    const h = makeHarness({ retryable: [retryTrigger()], ask: 0.6 });
    await h.sweeper.runOnce();
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]!.triggerId).toBe("trig-1");
    expect(h.executed[0]!.rule.id).toBe("rule-1");
    expect(h.audits.some((a) => a.action === "rule.execution.retried")).toBe(true);
    expect(h.cleared).toHaveLength(0);
  });

  it("book fetch failure → neither executes nor abandons (next pass retries)", async () => {
    const h = makeHarness({ retryable: [retryTrigger()], ask: null });
    await h.sweeper.runOnce();
    expect(h.executed).toHaveLength(0);
    expect(abandonReasons(h)).toEqual([]);
  });

  it("price_move strategies cannot be re-verified statelessly → abandoned", async () => {
    const moveDef = def({
      expr: {
        type: "group",
        id: "root",
        op: "and",
        children: [
          {
            type: "condition",
            id: "c1",
            condition: {
              kind: "price_move",
              market: { conditionId: "cond-1", tokenId: TOKEN, outcome: "YES" },
              direction: "drop",
              deltaThreshold: 0.05,
              windowMs: 300_000,
            },
          },
        ],
      },
    });
    const h = makeHarness({ retryable: [retryTrigger()], definition: moveDef, ask: 0.6 });
    await h.sweeper.runOnce();
    expect(abandonReasons(h)).toEqual(["price_move_not_reverifiable"]);
    expect(h.executed).toHaveLength(0);
  });
});
