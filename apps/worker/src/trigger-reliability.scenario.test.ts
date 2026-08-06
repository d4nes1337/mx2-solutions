/**
 * Trigger-reliability scenario suite (failing-first).
 *
 * Reproduces the 2026-08-06 incident class end-to-end: a strategy watching a
 * short-lived market ("Bitcoin Up or Down, 12:15–12:20") with a `price_move`
 * condition ("UP drops 10¢+ in 1 minute") whose drop REALLY happened on the
 * tape — and must ALWAYS produce exactly one signing proposal (rule_triggers
 * row + order_awaiting_signature outbox row), as fast as the pipeline allows.
 *
 * Each test drives raw WS frames through the real market-feed normalization
 * into the real evaluator (see test-support/scenario.ts). The "desired
 * behavior" assertions were written BEFORE the fixes; their initial failures
 * are transcribed in docs/TRIGGER_RELIABILITY_AUDIT.md as the before/after
 * evidence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bookFrame,
  flatHistory,
  makeRow,
  makeScenario,
  moveDef,
  priceChangeFrame,
  type Scenario,
} from "./test-support/scenario.js";
import type { MarketDataView, StrategyDefinition } from "@mx2/rules";

const COND_TOKEN = "up-token";
const COND_MKT = "btc-updown-cond";
const ORDER_TOKEN = "sharaa-token";
const ORDER_MKT = "sharaa-cond";
const TARGET = {
  condTokenId: COND_TOKEN,
  condConditionId: COND_MKT,
  orderTokenId: ORDER_TOKEN,
  orderConditionId: ORDER_MKT,
};

/** T0 mirrors the incident's market window open (12:15). */
const T0 = new Date("2026-08-06T12:15:00Z").getTime();

const seededHistory = async (
  _tokenId: string,
  lookbackMs: number,
): Promise<ReturnType<typeof flatHistory>> => flatHistory(0.55, lookbackMs, Date.now());

const restView = (tokenId: string, conditionId: string, mid: number): MarketDataView => ({
  tokenId,
  conditionId,
  bids: [{ price: mid - 0.01, size: 100 }],
  asks: [{ price: mid + 0.01, size: 100 }],
  marketStatus: "open",
  sourceTimeMs: Date.now(),
  receivedAtMs: Date.now(),
});

/** Boot the scenario: start the evaluator and let reload + seeding settle. */
const boot = async (s: Scenario): Promise<void> => {
  s.evaluator.start();
  await vi.advanceTimersByTimeAsync(5);
};

/** Feed the two initial full books (condition + order market). */
const feedInitialBooks = async (s: Scenario): Promise<void> => {
  await s.feed([
    bookFrame(COND_TOKEN, COND_MKT, 0.54, 0.56),
    bookFrame(ORDER_TOKEN, ORDER_MKT, 0.9, 0.91),
  ]);
};

/** Steady 0.55-mid ticks on the condition market, one every `stepMs`. */
const steadyTicks = async (s: Scenario, durationMs: number, stepMs = 2_000): Promise<void> => {
  for (let t = 0; t < durationMs; t += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await s.feed([priceChangeFrame(COND_TOKEN, COND_MKT, 0.54, 0.56)]);
  }
};

/**
 * The incident's defining shape: a fast 13¢ drop that RECOVERS within the
 * lookback window. Any evaluator that needs the full window covered before it
 * can see the move will miss it forever — by the time coverage exists, the
 * price is back up.
 */
const dropAndRecover = async (s: Scenario): Promise<void> => {
  await vi.advanceTimersByTimeAsync(2_000);
  await s.feed([priceChangeFrame(COND_TOKEN, COND_MKT, 0.41, 0.43)]); // mid 0.42 — the drop
  await vi.advanceTimersByTimeAsync(200);
  for (const mid of [0.44, 0.5, 0.53]) {
    await vi.advanceTimersByTimeAsync(5_000);
    await s.feed([priceChangeFrame(COND_TOKEN, COND_MKT, mid - 0.01, mid + 0.01)]);
  }
};

describe("trigger reliability scenarios", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("control (works today): plain price condition fires instantly with a signing proposal", async () => {
    const def = moveDef(TARGET);
    const priceDef: StrategyDefinition = {
      ...def,
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
              market: { conditionId: COND_MKT, tokenId: COND_TOKEN, outcome: "UP" },
              source: "ask",
              comparator: "lte",
              threshold: 0.5,
            },
          },
        ],
      },
    };
    const s = makeScenario([makeRow(priceDef)]);
    await boot(s);
    await feedInitialBooks(s); // ask 0.56 → not met
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.triggers).toHaveLength(0);
    await s.feed([bookFrame(COND_TOKEN, COND_MKT, 0.41, 0.43)]); // ask 0.43 ≤ 0.50
    await vi.advanceTimersByTimeAsync(100);

    expect(s.triggers).toHaveLength(1);
    expect(s.triggers[0]!.status).toBe("awaiting_user");
    expect(s.outboxItems).toHaveLength(1);
    expect(s.outboxItems[0]!.kind).toBe("order_awaiting_signature");
    expect(s.outboxItems[0]!.payload["price"]).toBe(0.91);
    expect(s.outboxItems[0]!.payload["size"]).toBe(10);
    s.evaluator.stop();
  });

  it("THE INCIDENT: 10¢+ drop 40s after arming on a 5-minute market fires ONE signing proposal at the drop", async () => {
    // Strategy armed at market open (T0), market expires at T0+5min. The drop
    // lands at T0+40s and recovers by T0+57s — exactly what the tape showed.
    const def = moveDef(TARGET, { expiresAtMs: T0 + 300_000 });
    const s = makeScenario([makeRow(def)], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 38_000);
    await dropAndRecover(s);

    // Desired: the trigger exists, recorded AT the drop (T0+40s ±3s) — not a
    // window-warm-up later, not never.
    expect(s.triggers).toHaveLength(1);
    const evidence = s.triggers[0]!.evidence;
    const triggeredAtMs = evidence["triggeredAtMs"] as number;
    expect(triggeredAtMs).toBeGreaterThanOrEqual(T0 + 39_000);
    expect(triggeredAtMs).toBeLessThanOrEqual(T0 + 43_000);
    expect(s.triggers[0]!.status).toBe("awaiting_user");
    expect(s.outboxItems.map((o) => o.kind)).toEqual(["order_awaiting_signature"]);

    // And the strategy must not have died as "expired with nothing to show":
    // run to market close; still exactly one trigger.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.triggers).toHaveLength(1);
    s.evaluator.stop();
  });

  it("WS reconnect must not blind an armed strategy: a drop 10s after reconnect still fires", async () => {
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 180_000); // 3 healthy minutes — window fully covered
    expect(s.triggers).toHaveLength(0);

    s.evaluator.onReconnect();
    await vi.advanceTimersByTimeAsync(5); // reseed settles
    // Upstream re-sends the book on resubscribe, then normal ticks resume.
    await feedInitialBooks(s);
    await steadyTicks(s, 8_000);
    await dropAndRecover(s); // drop at ~reconnect+12s

    expect(s.triggers).toHaveLength(1);
    expect(s.outboxItems.map((o) => o.kind)).toEqual(["order_awaiting_signature"]);
    s.evaluator.stop();
  });

  it("REST-only market (sparse WS): the verify pass must feed price windows, not just books", async () => {
    // Zero WS frames for the condition market — its data arrives exclusively
    // through the REST freshness-verify pass (10s cadence).
    let restMid = 0.55;
    const s = makeScenario([makeRow(moveDef(TARGET))], {
      fetchPriceHistory: seededHistory,
      fetchOrderbook: async (tokenId) =>
        restView(tokenId, tokenId === COND_TOKEN ? COND_MKT : ORDER_MKT, restMid),
    });
    await boot(s);
    await vi.advanceTimersByTimeAsync(30_000); // ≥2 verify passes at 0.55
    expect(s.triggers).toHaveLength(0);
    restMid = 0.42; // the drop, visible only over REST
    await vi.advanceTimersByTimeAsync(25_000); // next passes observe 0.42

    expect(s.triggers).toHaveLength(1);
    expect(s.triggers[0]!.status).toBe("awaiting_user");
    s.evaluator.stop();
  });

  it("fail-closed regression guard: dead feed (no WS, REST failing) never fires, even fully seeded", async () => {
    const s = makeScenario([makeRow(moveDef(TARGET))], {
      fetchPriceHistory: seededHistory, // seed succeeds…
      fetchOrderbook: async () => {
        throw new Error("upstream down");
      },
    });
    await boot(s);
    // …but no live book EVER arrives. Seeded history alone must not fire.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(s.triggers).toHaveLength(0);
    expect(s.outboxItems).toHaveLength(0);
    s.evaluator.stop();
  });

  it("action matrix: alert / FOK / GTD orders all produce their trigger + notification on the same tape", async () => {
    const cases: {
      name: string;
      def: StrategyDefinition;
      expectStatus: string;
      expectKind: string;
    }[] = [
      {
        name: "alert",
        def: moveDef(TARGET, { action: { kind: "alert" } }),
        expectStatus: "notified",
        expectKind: "rule_alert",
      },
      {
        name: "FOK order",
        def: moveDef(TARGET, {
          action: {
            kind: "order",
            market: { conditionId: ORDER_MKT, tokenId: ORDER_TOKEN, outcome: "YES" },
            side: "BUY",
            price: 0.91,
            size: 10,
            orderType: "FOK",
            execution: "prepare",
          },
        }),
        expectStatus: "awaiting_user",
        expectKind: "order_awaiting_signature",
      },
      {
        name: "GTD order",
        def: moveDef(TARGET, {
          action: {
            kind: "order",
            market: { conditionId: ORDER_MKT, tokenId: ORDER_TOKEN, outcome: "YES" },
            side: "BUY",
            price: 0.91,
            size: 10,
            orderType: "GTD",
            expiresAfterMs: 600_000,
            execution: "prepare",
          },
        }),
        expectStatus: "awaiting_user",
        expectKind: "order_awaiting_signature",
      },
    ];

    for (const c of cases) {
      vi.setSystemTime(new Date(T0));
      const s = makeScenario([makeRow(c.def)], { fetchPriceHistory: seededHistory });
      await boot(s);
      await feedInitialBooks(s);
      await steadyTicks(s, 10_000);
      await dropAndRecover(s);

      expect(s.triggers, c.name).toHaveLength(1);
      expect(s.triggers[0]!.status, c.name).toBe(c.expectStatus);
      expect(
        s.outboxItems.map((o) => o.kind),
        c.name,
      ).toEqual([c.expectKind]);
      s.evaluator.stop();
    }
  });

  it("atomicity: a concurrent user pause wins, and the dropped trigger is AUDITED, not silent", async () => {
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 10_000);
    // The user pauses via the API in the same instant the drop lands: the DB
    // row leaves the evaluable statuses before the worker's commit.
    s.rows[0]!.status = "PAUSED";
    await dropAndRecover(s);

    expect(s.triggers).toHaveLength(0);
    expect(s.outboxItems).toHaveLength(0);
    const dropped = s.audits.filter((a) => a.action === "rule.trigger_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.metadata["reason"]).toBe("cas_lost");
    s.evaluator.stop();
  });

  it("atomicity: transient DB failure at commit time delays the trigger, never loses it", async () => {
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 10_000);
    // The DB goes away exactly when the drop fires: both commit attempts
    // (initial + one retry) fail.
    s.failCommits.count = 2;
    await vi.advanceTimersByTimeAsync(2_000);
    await s.feed([priceChangeFrame(COND_TOKEN, COND_MKT, 0.41, 0.43)]); // the drop — holds
    await vi.advanceTimersByTimeAsync(1_000); // covers the 250ms retry too
    expect(s.triggers).toHaveLength(0);
    const dropped = s.audits.filter(
      (a) => a.action === "rule.trigger_dropped" && a.metadata["reason"] === "persist_failed",
    );
    expect(dropped).toHaveLength(1);
    // DB truth is still ACTIVE (nothing committed): the reload pass must
    // re-add the rule instead of leaving an in-memory zombie...
    expect(s.rows[0]!.status).toBe("ACTIVE_WAITING");
    // ...and with the DB healthy again and the drop still on the tape, the
    // re-added rule fires. (The re-add resubscribes, so upstream re-sends the
    // full book — mirrored here.)
    await vi.advanceTimersByTimeAsync(6_000); // past the reload pass
    await s.feed([
      bookFrame(COND_TOKEN, COND_MKT, 0.41, 0.43),
      bookFrame(ORDER_TOKEN, ORDER_MKT, 0.9, 0.91),
    ]);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      await s.feed([priceChangeFrame(COND_TOKEN, COND_MKT, 0.41, 0.43)]);
    }
    expect(s.triggers).toHaveLength(1);
    expect(s.outboxItems.map((o) => o.kind)).toEqual(["order_awaiting_signature"]);
    s.evaluator.stop();
  });

  it("atomicity: a stale-ACTIVE row with an existing trigger row cannot double-sign (unique index)", async () => {
    // Simulates the crash window the old code left open: the trigger row
    // exists but the rule row was somehow left ACTIVE (e.g. restored backup,
    // manual ops fix). The unique (rule, triggerNumber) index must make the
    // re-fire a no-op instead of a second signing prompt.
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 10_000);
    await dropAndRecover(s);
    expect(s.triggers).toHaveLength(1);

    // Corrupt the row back to a pre-trigger state with the trigger row still
    // present (restored backup / manual ops fix).
    s.rows[0]!.status = "ACTIVE_WAITING";
    s.rows[0]!.triggerCount = 0;
    await vi.advanceTimersByTimeAsync(6_000); // reload re-adds the rule
    await feedInitialBooks(s); // resubscribe re-sends the books
    await steadyTicks(s, 4_000);
    await dropAndRecover(s); // same triggerNumber recomputed — must dedupe

    expect(s.triggers).toHaveLength(1); // still exactly one
    expect(s.outboxItems).toHaveLength(1);
    s.evaluator.stop();
  });

  it("snapshot freshness: a delta-only tape keeps the persisted snapshot fresh (rate-limited)", async () => {
    // The UI's "no fresh data" badge reads market_snapshots — which the old
    // pipeline only rewrote on FULL book messages. An actively-trading market
    // sending only price_change deltas therefore looked stale to every
    // snapshot reader. The evaluator now persists its patched view, ≤1/s.
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    const writesAfterBooks = s.snapshotWrites.length;

    // 10 s of pure deltas, 2 per second — no full books.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await s.feed([priceChangeFrame(COND_TOKEN, COND_MKT, 0.54, 0.56)]);
    }
    const deltaWrites = s.snapshotWrites
      .slice(writesAfterBooks)
      .filter((w) => w.tokenId === COND_TOKEN);
    // Rate-limited: ~1/s over 10 s, never the raw 20.
    expect(deltaWrites.length).toBeGreaterThanOrEqual(8);
    expect(deltaWrites.length).toBeLessThanOrEqual(11);
    // And the persisted snapshot is current, not stale.
    const snap = s.snapshots.get(COND_TOKEN)!;
    expect(snap.isStale).toBe(false);
    expect(Date.now() - snap.receivedAt.getTime()).toBeLessThanOrEqual(1_500);
    s.evaluator.stop();
  });

  it("a deep resting order can NEVER fabricate a price move (live false-trigger regression)", async () => {
    // Caught on the live stack 2026-08-06: a bestless price_change carrying a
    // 47¢ LEVEL price on a ~55¢ market was recorded as a price sample and
    // combined with seeded history into a phantom "drop". The level must
    // patch the book only — the honest observation is the patched book's
    // mid, which barely moves when a deep level appears.
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 10_000);

    // A deep BUY level at 0.05 appears (bestless item) — the top of book is
    // untouched at 0.54/0.56, so the honest mid does not move. (Pre-fix, the
    // raw 0.05 became a price sample → phantom 50¢ "drop" → false trigger.)
    await vi.advanceTimersByTimeAsync(2_000);
    await s.feed([
      {
        event_type: "price_change",
        market: COND_MKT,
        timestamp: String(Date.now()),
        price_changes: [{ asset_id: COND_TOKEN, price: "0.05", size: "25", side: "BUY" }],
      } as never,
    ]);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(s.triggers).toHaveLength(0);
    s.evaluator.stop();
  });

  it("market resolution INVALIDATES the strategy instead of eternal 'no fresh data'", async () => {
    const s = makeScenario([makeRow(moveDef(TARGET))], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 10_000);
    expect(s.rows[0]!.status).toBe("ACTIVE_WAITING");

    // The 5-minute window closes: the Gamma poller reports resolved.
    s.evaluator.onMarketStatus(COND_TOKEN, "resolved");
    await vi.advanceTimersByTimeAsync(100);

    expect(s.rows[0]!.status).toBe("INVALIDATED");
    const audit = s.audits.find(
      (a) => a.action === "rule.state_changed" && a.metadata["to"] === "INVALIDATED",
    );
    expect(audit?.metadata["reason"]).toBe("MARKET_RESOLVED");
    expect(s.triggers).toHaveLength(0);
    s.evaluator.stop();
  });

  it("repeat recurrence: two separate drops produce two signing proposals with distinct dedupe keys", async () => {
    const def = moveDef(TARGET, {
      recurrence: { kind: "repeat", maxRepeats: 5, cooldownMs: 30_000 },
    });
    const s = makeScenario([makeRow(def)], { fetchPriceHistory: seededHistory });
    await boot(s);
    await feedInitialBooks(s);
    await steadyTicks(s, 10_000);
    await dropAndRecover(s); // drop #1 at ~T0+12s
    expect(s.triggers).toHaveLength(1);

    await steadyTicks(s, 60_000); // recovery holds through the cooldown
    await dropAndRecover(s); // drop #2

    expect(s.triggers).toHaveLength(2);
    const keys = s.outboxItems.map((o) => o.dedupeKey);
    expect(new Set(keys).size).toBe(2);
    s.evaluator.stop();
  });
});
