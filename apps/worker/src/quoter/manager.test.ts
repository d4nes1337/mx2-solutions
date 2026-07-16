import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  ConditionalRuleRow,
  QuoteSessionRow,
  QuoterStore,
  RuleStore,
  RuntimeFlagStore,
} from "@mx2/db";
import type { MarketDataView, QuoteLoopAction, StrategyDefinition } from "@mx2/rules";
import type { QuoteIntent, RestingQuote, VenueOpenOrder } from "./engine.js";
import {
  createShadowExecutor,
  type QuoterExecutor,
  type QuoterExecutorProvider,
} from "./executor.js";
import { createQuoterManager, type QuoterManager } from "./manager.js";

const RULE = "rule-q1";
const WALLET = "0xowner";
const logger = createLogger({ name: "quoter-test", level: "silent" });

const quoteLoopAction = (over: Partial<QuoteLoopAction> = {}): QuoteLoopAction => ({
  kind: "quote_loop",
  market: {
    conditionId: "cond-1",
    yesTokenId: "tok-yes",
    noTokenId: "tok-no",
    tickSize: "0.01",
    negRisk: false,
  },
  sizeShares: 100,
  targetSpreadCents: 2,
  requoteToleranceCents: 1,
  maxInventoryShares: 200,
  maxCapitalUsd: 500,
  maxDailyLossUsd: 25,
  ...over,
});

const defFor = (action: QuoteLoopAction): StrategyDefinition => ({
  version: 2,
  name: "farm",
  templateId: null,
  expr: { type: "group", id: "root", op: "and", children: [] }, // empty = always-on gate
  holdsForMs: 0,
  maxDataAgeMs: 60_000,
  action,
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
});

const ruleRow = (action: QuoteLoopAction): ConditionalRuleRow =>
  ({
    id: RULE,
    walletAddress: WALLET,
    definition: defFor(action),
  }) as unknown as ConditionalRuleRow;

const bookView = (bid: number, ask: number): MarketDataView => ({
  tokenId: "tok-yes",
  conditionId: "cond-1",
  bids: [{ price: bid, size: 500 }],
  asks: [{ price: ask, size: 500 }],
  marketStatus: "open",
  sourceTimeMs: Date.now(),
  receivedAtMs: Date.now(),
});

interface StoreHarness {
  store: QuoterStore;
  session: () => QuoteSessionRow;
  setSession: (patch: Record<string, unknown>) => void;
  events: () => { type: string; payload: Record<string, unknown> }[];
}

const makeQuoterStore = (initial: Record<string, unknown> = {}): StoreHarness => {
  const session: Record<string, unknown> = {
    id: "sess-1",
    ruleId: RULE,
    walletAddress: WALLET,
    mode: "shadow",
    status: "idle",
    haltedReason: null,
    inventoryYes: "0",
    inventoryNo: "0",
    inventoryYesCostUsd: "0",
    inventoryNoCostUsd: "0",
    capitalCommittedUsd: "0",
    realizedPnlUsd: "0",
    dailyLossUsd: "0",
    rewardsAccruedUsd: "0",
    dailyLossDay: null,
    pendingBatch: null,
    pendingBatchHash: null,
    pendingBatchAt: null,
    approvedBatchHash: null,
    approvedAt: null,
    lastCycleAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const keys = new Set<string>();
  const numeric = new Set([
    "inventoryYes",
    "inventoryNo",
    "inventoryYesCostUsd",
    "inventoryNoCostUsd",
    "capitalCommittedUsd",
    "realizedPnlUsd",
    "dailyLossUsd",
    "rewardsAccruedUsd",
  ]);
  const store: QuoterStore = {
    ensureSession: async () => session as unknown as QuoteSessionRow,
    findSessionByRuleId: async () => session as unknown as QuoteSessionRow,
    updateSession: async (_id, update) => {
      for (const [k, v] of Object.entries(update)) {
        // Mirror the real store: numeric columns persist as strings.
        session[k] = numeric.has(k) && v !== null ? String(v) : v;
      }
      return session as unknown as QuoteSessionRow;
    },
    setMode: async (_id, mode) => {
      session["mode"] = mode;
      return session as unknown as QuoteSessionRow;
    },
    approveBatch: async (_id, hash) => {
      if (session["pendingBatchHash"] !== hash) return null;
      session["approvedBatchHash"] = hash;
      session["approvedAt"] = new Date();
      return session as unknown as QuoteSessionRow;
    },
    recordEvent: async (e) => {
      if (e.idempotencyKey !== undefined) {
        if (keys.has(e.idempotencyKey)) return false;
        keys.add(e.idempotencyKey);
      }
      events.push({ type: e.type, payload: e.payload });
      return true;
    },
    listEvents: async () => [],
    upsertRewardAccrual: async () => {},
    sumRewardAccruals: async () => 0,
    listActiveSessions: async () => [session as unknown as QuoteSessionRow],
  };
  return {
    store,
    session: () => session as unknown as QuoteSessionRow,
    setSession: (patch) => Object.assign(session, patch),
    events: () => events,
  };
};

interface LiveState {
  placed: QuoteIntent[];
  cancelled: RestingQuote[];
  merges: number[];
  venueOrders: VenueOpenOrder[];
  unavailable: string | null;
}

const makeLiveExecutor = (state: LiveState): QuoterExecutor => ({
  mode: "live",
  place: async (intent) => {
    state.placed.push(intent);
    return {
      ok: true,
      value: { ...intent, orderId: `ord-${state.placed.length}`, sizeMatched: 0 },
    };
  },
  cancel: async (quote) => {
    state.cancelled.push(quote);
    return { ok: true, value: undefined };
  },
  mergePairs: async (pairs) => {
    state.merges.push(pairs);
    return { ok: true, value: { transactionId: `tx-${state.merges.length}` } };
  },
  syncOpenOrders: async () => ({ ok: true, value: state.venueOrders }),
  mergeState: async () => ({ ok: true, value: "confirmed" as const }),
});

const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until(): condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let running: QuoterManager | null = null;
afterEach(() => {
  running?.stop();
  running = null;
});

const makeHarness = (
  over: {
    action?: QuoteLoopAction;
    sessionInit?: Record<string, unknown>;
    flags?: Record<string, string>;
  } = {},
) => {
  const action = over.action ?? quoteLoopAction();
  const sh = makeQuoterStore(over.sessionInit ?? {});
  const audits: string[] = [];
  const live: LiveState = {
    placed: [],
    cancelled: [],
    merges: [],
    venueOrders: [],
    unavailable: null,
  };
  const shadow = createShadowExecutor();
  const provider: QuoterExecutorProvider = {
    forLoop: async (_ctx, mode) => {
      if (mode === "shadow") return { executor: shadow };
      if (live.unavailable) return { unavailable: live.unavailable };
      return { executor: makeLiveExecutor(live) };
    },
  };
  const manager = createQuoterManager({
    logger,
    ruleStore: { listEvaluable: async () => [ruleRow(action)] } as unknown as RuleStore,
    quoterStore: sh.store,
    auditStore: {
      emit: async (e) => {
        audits.push(e.action);
        return {} as never;
      },
      recent: async () => [],
      forActor: async () => [],
    } as AuditStore,
    runtimeFlags: {
      get: async (key: string) =>
        over.flags?.[key] !== undefined
          ? { key, value: over.flags[key], updatedBy: "t", updatedAt: new Date() }
          : null,
    } as unknown as RuntimeFlagStore,
    executorProvider: provider,
    subscribe: () => {},
    unsubscribe: () => {},
    reloadIntervalMs: 25,
    cycleMinIntervalMs: 0,
  });
  running = manager;
  return { manager, sh, audits, live };
};

describe("quoter manager (B4–B5)", () => {
  it("shadow session quotes virtually: quote_intent events, no order_placed", async () => {
    const h = makeHarness();
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.events().some((e) => e.type === "cycle"));
    await until(() => h.sh.events().filter((e) => e.type === "quote_intent").length >= 2);
    expect(h.sh.events().some((e) => e.type === "order_placed")).toBe(false);
    expect(h.sh.session().status).toBe("quoting");
  });

  it("a mode flip to live takes effect within one cycle (session re-read)", async () => {
    const h = makeHarness();
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.events().some((e) => e.type === "cycle"));
    h.sh.setSession({ mode: "live" });
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.live.placed.length >= 2);
    await until(() => h.sh.events().some((e) => e.type === "order_placed"));
  });

  it("halts (visibly, fail-closed) when a live prerequisite is unavailable", async () => {
    const h = makeHarness({ sessionInit: { mode: "live" } });
    h.live.unavailable = "clob_credentials_missing";
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.session().status === "halted");
    expect(h.sh.session().haltedReason).toBe("clob_credentials_missing");
    expect(h.audits).toContain("quoter.halted");
    expect(h.live.placed).toHaveLength(0);
  });

  it("confirm mode: proposes a hashed batch and executes NOTHING until approved", async () => {
    const h = makeHarness({ sessionInit: { mode: "confirm" } });
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.session().pendingBatchHash !== null);
    expect(h.sh.events().some((e) => e.type === "batch_proposed")).toBe(true);
    expect(h.live.placed).toHaveLength(0);

    // Approve the CURRENT hash (as the API route would).
    const hash = h.sh.session().pendingBatchHash!;
    const approved = await h.sh.store.approveBatch("sess-1", hash);
    expect(approved).not.toBeNull();

    await until(() => h.live.placed.length >= 2);
    // Protocol state fully cleared after execution.
    await until(() => h.sh.session().pendingBatchHash === null);
    expect(h.sh.session().approvedBatchHash).toBeNull();
  });

  it("confirm mode: a moved book re-proposes and voids the stale approval", async () => {
    const h = makeHarness({ sessionInit: { mode: "confirm" } });
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.session().pendingBatchHash !== null);
    const staleHash = h.sh.session().pendingBatchHash!;

    // Market moves well beyond the requote tolerance BEFORE any approval.
    h.manager.onBook(bookView(0.39, 0.41));
    await until(
      () =>
        h.sh.session().pendingBatchHash !== null && h.sh.session().pendingBatchHash !== staleHash,
    );

    // Approving the OLD hash now fails the store's WHERE guard (BATCH_STALE).
    expect(await h.sh.store.approveBatch("sess-1", staleHash)).toBeNull();
    expect(h.live.placed).toHaveLength(0);
  });

  it("applies venue fill deltas to inventory and emits fill events (live)", async () => {
    const h = makeHarness({ sessionInit: { mode: "live" } });
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.live.placed.length >= 2);

    // The venue reports the YES bid (ord-1) 40 shares matched.
    const yes = h.live.placed.find((p) => p.tokenId === "tok-yes")!;
    h.live.venueOrders = [
      {
        orderId: "ord-1",
        tokenId: "tok-yes",
        price: yes.price,
        originalSize: yes.size,
        sizeMatched: 40,
      },
      // ord-2 (NO) untouched and still resting:
      {
        orderId: "ord-2",
        tokenId: "tok-no",
        price: 0.48,
        originalSize: 100,
        sizeMatched: 0,
      },
    ];
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.events().some((e) => e.type === "fill"));
    await until(() => Number(h.sh.session().inventoryYes) === 40);
    expect(Number(h.sh.session().inventoryYesCostUsd)).toBeCloseTo(40 * yes.price, 6);
  });

  it("kill switch (quoter_paused) idles quotes on the next cycle without halting", async () => {
    const flags: Record<string, string> = {};
    const h = makeHarness({ flags });
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.session().status === "quoting");
    flags["quoter_paused"] = "true";
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.sh.session().status === "idle");
    expect(h.sh.session().haltedReason).toBeNull();
  });

  it("merges whole pairs and realizes PnL from the cost pools (live)", async () => {
    // Start with symmetric inventory just above the merge threshold, entered
    // at 0.48 + 0.48 → each merged pair realizes ~0.04.
    const h = makeHarness({
      sessionInit: {
        mode: "live",
        inventoryYes: "30",
        inventoryNo: "30",
        inventoryYesCostUsd: String(30 * 0.48),
        inventoryNoCostUsd: String(30 * 0.48),
      },
    });
    h.manager.start();
    h.manager.onBook(bookView(0.49, 0.51));
    await until(() => h.live.merges.length >= 1);
    expect(h.live.merges[0]).toBe(30);
    await until(() => Number(h.sh.session().realizedPnlUsd) > 0);
    expect(Number(h.sh.session().realizedPnlUsd)).toBeCloseTo(30 * (1 - 0.96), 6);
    expect(Number(h.sh.session().dailyLossUsd)).toBe(0);
    await until(() => h.sh.events().some((e) => e.type === "merge_confirmed"));
  });
});
