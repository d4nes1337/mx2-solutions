/**
 * End-to-end trigger scenario harness: raw WS market frames → market-feed
 * normalization (`handleMessages`) → rule evaluator → fake stores. This is the
 * exact pipeline a production trigger takes, minus the socket and Postgres —
 * the two halves the unit suites cover separately (`ws.test.ts` stops at
 * schema parsing; `rule-evaluator.test.ts` starts at MarketDataView).
 *
 * Store fakes keep the semantics the evaluator relies on:
 *   - updateEvaluationState is a real CAS against the evaluable statuses,
 *   - commitTrigger models the atomic commit (CAS + unique (rule,
 *     triggerNumber) index + dedupe-keyed outbox + notify), the same contract
 *     packages/db/src/trigger-commit.ts implements against Postgres,
 *   - outbox dedupe keys are honored.
 *
 * Time control is the caller's: use vi.useFakeTimers() and advance — every
 * clock read in the pipeline is Date.now().
 */
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  CommitTrigger,
  ConditionalRuleRow,
  MarketSnapshotStore,
  NotificationOutboxStore,
  RuleStore,
  RuleTriggerRow,
} from "@mx2/db";
import type { PriceSample, StrategyDefinition } from "@mx2/rules";
import type { WsMarketMessage } from "@mx2/polymarket-client";
import { handleMessages, type MarketFeedOptions } from "../market-feed.js";
import {
  createRuleEvaluatorManager,
  type RuleEvaluatorManager,
  type RuleEvaluatorOptions,
} from "../rule-evaluator.js";

const logger = createLogger({ name: "scenario-test", level: "silent" });

const EVALUABLE = new Set(["ACTIVE_WAITING", "ACTIVE_ACCUMULATING"]);

export interface RecordedTrigger {
  id: string;
  ruleId: string;
  walletAddress: string;
  status: string;
  evidence: Record<string, unknown>;
  reasonCodes: readonly string[];
}

export interface RecordedOutboxItem {
  walletAddress: string;
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface RecordedAudit {
  actor: string;
  action: string;
  subject: string;
  metadata: Record<string, unknown>;
}

export interface RecordedSnapshot {
  tokenId: string;
  conditionId: string;
  bids: readonly unknown[];
  asks: readonly unknown[];
  lastTradePrice: string | null;
  midPrice: string | null;
  source: string;
  isStale: boolean;
  receivedAt: Date;
}

export type ScenarioOptions = Partial<RuleEvaluatorOptions>;

export interface Scenario {
  evaluator: RuleEvaluatorManager;
  /** Push raw WS frames through the market-feed normalization path. */
  feed(msgs: WsMarketMessage[]): Promise<void>;
  rows: ConditionalRuleRow[];
  triggers: RecordedTrigger[];
  outboxItems: RecordedOutboxItem[];
  /** Event-bus notify payloads the atomic commit would pg_notify. */
  notifications: Record<string, unknown>[];
  audits: RecordedAudit[];
  /** Latest persisted snapshot per token (upsert history in `snapshotWrites`). */
  snapshots: Map<string, RecordedSnapshot>;
  snapshotWrites: RecordedSnapshot[];
  staleMarked: string[];
  /** Fault injection: the next N commitTrigger calls throw (DB outage). */
  failCommits: { count: number };
}

export const makeScenario = (rows: ConditionalRuleRow[], over: ScenarioOptions = {}): Scenario => {
  const triggers: RecordedTrigger[] = [];
  const outboxItems: RecordedOutboxItem[] = [];
  const notifications: Record<string, unknown>[] = [];
  const audits: RecordedAudit[] = [];
  const snapshots = new Map<string, RecordedSnapshot>();
  const snapshotWrites: RecordedSnapshot[] = [];
  const staleMarked: string[] = [];
  const outboxDedupe = new Set<string>();

  const ruleStore = {
    listEvaluable: async () => rows.filter((r) => EVALUABLE.has(r.status)),
    updateEvaluationState: async (
      id: string,
      update: {
        status: string;
        trueSinceMs: number | null;
        lastEvaluatedAt: Date;
        triggerCount: number;
        cooldownUntilMs: number | null;
        staleSinceMs: number | null;
      },
    ) => {
      const row = rows.find((r) => r.id === id);
      if (!row || !EVALUABLE.has(row.status)) return null;
      row.status = update.status;
      row.trueSince = update.trueSinceMs === null ? null : new Date(update.trueSinceMs);
      row.lastEvaluatedAt = update.lastEvaluatedAt;
      row.triggerCount = update.triggerCount;
      row.cooldownUntil = update.cooldownUntilMs === null ? null : new Date(update.cooldownUntilMs);
      row.staleSince = update.staleSinceMs === null ? null : new Date(update.staleSinceMs);
      return row;
    },
    cancel: async () => null,
    claimSeriesWindow: async () => true,
  } as unknown as RuleStore;

  const applyStateUpdate = (
    row: ConditionalRuleRow,
    update: {
      status: string;
      trueSinceMs: number | null;
      lastEvaluatedAt: Date;
      triggerCount?: number;
      cooldownUntilMs?: number | null;
      staleSinceMs?: number | null;
    },
  ): void => {
    row.status = update.status;
    row.trueSince = update.trueSinceMs === null ? null : new Date(update.trueSinceMs);
    row.lastEvaluatedAt = update.lastEvaluatedAt;
    if (update.triggerCount !== undefined) row.triggerCount = update.triggerCount;
    if (update.cooldownUntilMs !== undefined) {
      row.cooldownUntil = update.cooldownUntilMs === null ? null : new Date(update.cooldownUntilMs);
    }
    if (update.staleSinceMs !== undefined) {
      row.staleSince = update.staleSinceMs === null ? null : new Date(update.staleSinceMs);
    }
  };

  const failCommits = { count: 0 };
  const commitTrigger: CommitTrigger = async (o) => {
    if (failCommits.count > 0) {
      failCommits.count--;
      throw new Error("injected commit failure");
    }
    const row = rows.find((r) => r.id === o.ruleId);
    if (!row || !EVALUABLE.has(row.status)) return { outcome: "cas_lost" };
    applyStateUpdate(row, o.stateUpdate);
    const tn = (o.trigger.evidence as { triggerNumber?: number }).triggerNumber;
    if (
      tn !== undefined &&
      triggers.some(
        (t) =>
          t.ruleId === o.ruleId && (t.evidence as { triggerNumber?: number }).triggerNumber === tn,
      )
    ) {
      return { outcome: "duplicate", rule: row };
    }
    const trig: RecordedTrigger = {
      id: `trig-${triggers.length + 1}`,
      ruleId: o.ruleId,
      walletAddress: o.trigger.walletAddress,
      status: o.trigger.status,
      evidence: o.trigger.evidence as unknown as Record<string, unknown>,
      reasonCodes: o.trigger.reasonCodes,
    };
    triggers.push(trig);
    if (o.outboxItem) {
      const item = o.outboxItem(trig.id);
      if (!outboxDedupe.has(item.dedupeKey)) {
        outboxDedupe.add(item.dedupeKey);
        outboxItems.push(item);
      }
    }
    if (o.notify) notifications.push(o.notify(trig.id));
    return {
      outcome: "committed",
      rule: row,
      trigger: trig as unknown as RuleTriggerRow,
    };
  };

  const auditStore = {
    emit: async (e: RecordedAudit) => {
      audits.push(e);
      return e;
    },
  } as unknown as AuditStore;

  const outbox = {
    enqueue: async (o: RecordedOutboxItem) => {
      if (outboxDedupe.has(o.dedupeKey)) return null;
      outboxDedupe.add(o.dedupeKey);
      outboxItems.push(o);
      return { id: `outbox-${outboxItems.length}`, ...o };
    },
  } as unknown as NotificationOutboxStore;

  const marketSnapshots = {
    upsert: async (s: RecordedSnapshot) => {
      snapshots.set(s.tokenId, s);
      snapshotWrites.push(s);
      return { ...s, updatedAt: new Date() };
    },
    findByTokenId: async (tokenId: string) => snapshots.get(tokenId) ?? null,
    markStale: async (tokenId: string) => {
      staleMarked.push(tokenId);
      const s = snapshots.get(tokenId);
      if (s) snapshots.set(tokenId, { ...s, isStale: true });
    },
  } as unknown as MarketSnapshotStore;

  const evaluator = createRuleEvaluatorManager({
    logger,
    ruleStore,
    commitTrigger,
    auditStore,
    outbox,
    subscribe: () => {},
    unsubscribe: () => {},
    // Mirrors main.ts: the evaluator persists its patched view so snapshot
    // readers stay fresh on delta-only tapes.
    persistSnapshot: (view) => {
      void marketSnapshots.upsert({
        tokenId: view.tokenId,
        conditionId: view.conditionId,
        bids: view.bids.map((l) => ({ price: String(l.price), size: String(l.size) })),
        asks: view.asks.map((l) => ({ price: String(l.price), size: String(l.size) })),
        lastTradePrice: null,
        midPrice: null,
        source: "ws",
        isStale: false,
        receivedAt: new Date(view.receivedAtMs),
      } as unknown as RecordedSnapshot);
    },
    ...over,
  });

  const feedOpts: MarketFeedOptions = {
    wsUrl: "wss://unused.test",
    logger,
    marketSnapshots,
    onBookView: (view) => evaluator.onBook(view),
    onReconnect: () => evaluator.onReconnect(),
    onTickSizeChange: (tokenId) => evaluator.onTickSizeChange(tokenId),
    onPrice: (tokenId, price, tMs) => evaluator.onPrice(tokenId, price, tMs),
    onBookDelta: (tokenId, deltas, tMs) => evaluator.onBookDelta(tokenId, deltas, tMs),
    onHeartbeat: (tokenId, tMs) => evaluator.onHeartbeat(tokenId, tMs),
  };

  return {
    evaluator,
    feed: (msgs) => handleMessages(msgs, feedOpts),
    rows,
    triggers,
    outboxItems,
    notifications,
    audits,
    snapshots,
    snapshotWrites,
    staleMarked,
    failCommits,
  };
};

// ── Raw frame builders (current upstream shapes) ────────────────────────────

/** Full `book` snapshot with one level per side. */
export const bookFrame = (
  tokenId: string,
  conditionId: string,
  bestBid: number,
  bestAsk: number,
): WsMarketMessage =>
  ({
    event_type: "book",
    asset_id: tokenId,
    market: conditionId,
    bids: [{ price: bestBid.toFixed(3), size: "100" }],
    asks: [{ price: bestAsk.toFixed(3), size: "100" }],
    timestamp: String(Date.now()),
  }) as WsMarketMessage;

/** Batched `price_change` carrying best bid/ask (its mid feeds price windows). */
export const priceChangeFrame = (
  tokenId: string,
  conditionId: string,
  bestBid: number,
  bestAsk: number,
): WsMarketMessage =>
  ({
    event_type: "price_change",
    market: conditionId,
    timestamp: String(Date.now()),
    price_changes: [
      {
        asset_id: tokenId,
        price: bestAsk.toFixed(3),
        size: "50",
        side: "SELL",
        best_bid: bestBid.toFixed(3),
        best_ask: bestAsk.toFixed(3),
      },
    ],
  }) as WsMarketMessage;

/** `last_trade_price` print. */
export const tradeFrame = (tokenId: string, conditionId: string, price: number): WsMarketMessage =>
  ({
    event_type: "last_trade_price",
    asset_id: tokenId,
    market: conditionId,
    price: price.toFixed(3),
    timestamp: String(Date.now()),
  }) as WsMarketMessage;

// ── Definition + row builders ───────────────────────────────────────────────

export const WALLET = "0xowner";

export interface MoveDefTarget {
  condTokenId: string;
  condConditionId: string;
  orderTokenId: string;
  orderConditionId: string;
}

/**
 * The incident-shaped strategy: "price_move drop ≥ deltaThreshold within
 * windowMs on the condition market → BUY on the order market" (limit 91¢ × 10,
 * manual signing).
 */
export const moveDef = (
  t: MoveDefTarget,
  over: Partial<StrategyDefinition> = {},
): StrategyDefinition => ({
  version: 2,
  name: "incident repro",
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
          kind: "price_move",
          market: { conditionId: t.condConditionId, tokenId: t.condTokenId, outcome: "UP" },
          direction: "drop",
          deltaThreshold: 0.1,
          windowMs: 60_000,
        },
      },
    ],
  },
  holdsForMs: 0,
  maxDataAgeMs: 30_000,
  action: {
    kind: "order",
    market: { conditionId: t.orderConditionId, tokenId: t.orderTokenId, outcome: "YES" },
    side: "BUY",
    price: 0.91,
    size: 10,
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  ...over,
});

export const makeRow = (
  def: StrategyDefinition,
  over: Partial<ConditionalRuleRow> = {},
): ConditionalRuleRow => {
  const orderMarket = def.action.kind === "order" ? def.action.market : null;
  return {
    id: "rule-1",
    walletAddress: WALLET,
    conditionId: orderMarket?.conditionId ?? "cond-1",
    tokenId: orderMarket?.tokenId ?? "token-1",
    side: "BUY",
    definition: def,
    definitionHash: "hash-1",
    status: "ACTIVE_WAITING",
    version: 2,
    trueSince: null,
    staleSince: null,
    supersedes: null,
    supersededBy: null,
    expiresAt: def.expiresAtMs === null ? null : new Date(def.expiresAtMs),
    pausedAt: null,
    lastEvaluatedAt: null,
    errorMessage: null,
    name: def.name,
    templateId: null,
    tokenIds: [],
    triggerCount: 0,
    cooldownUntil: null,
    runtimeWatermarks: null,
    totalNotionalExecuted: "0",
    tags: [],
    archivedAt: null,
    starredAt: null,
    seriesSlug: null,
    lastSeriesWindowStart: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
};

/**
 * Flat 1-minute price bars at `price` covering [now − lookbackMs, now], the
 * shape a CLOB /prices-history seed produces for a quiet tape. Oldest-first.
 */
export const flatHistory = (
  price: number,
  lookbackMs: number,
  nowMs: number,
): readonly PriceSample[] => {
  const samples: PriceSample[] = [];
  for (let t = nowMs - lookbackMs; t <= nowMs; t += 60_000) {
    samples.push({ t, p: price });
  }
  return samples;
};
