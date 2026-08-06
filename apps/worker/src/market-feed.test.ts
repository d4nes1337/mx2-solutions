/**
 * Frame-normalization tests for the market feed — the previously untested
 * bridge between raw WS JSON and the evaluator's callbacks. Locks in exactly
 * which callbacks fire (and what they carry) for each upstream message shape,
 * including the legacy generations the schema still accepts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import type { MarketDataView } from "@mx2/rules";
import type { WsMarketMessage } from "@mx2/polymarket-client";
import { computeMidPrice, handleMessages, type BookDelta } from "./market-feed.js";

const logger = createLogger({ name: "market-feed-test", level: "silent" });
const TOKEN = "token-1";
const COND = "cond-1";

interface Recorded {
  books: MarketDataView[];
  prices: { tokenId: string; price: number; tMs: number }[];
  deltas: { tokenId: string; deltas: readonly BookDelta[]; tMs: number }[];
  heartbeats: { tokenId: string; tMs: number }[];
  tickSizes: string[];
  upserts: Record<string, unknown>[];
}

const makeFeedHarness = (existingSnapshot: Record<string, unknown> | null = null) => {
  const rec: Recorded = {
    books: [],
    prices: [],
    deltas: [],
    heartbeats: [],
    tickSizes: [],
    upserts: [],
  };
  const marketSnapshots = {
    upsert: async (s: Record<string, unknown>) => {
      rec.upserts.push(s);
      return s;
    },
    findByTokenId: async () => existingSnapshot,
    markStale: async () => {},
    setMarketStatus: async () => {},
  } as unknown as MarketSnapshotStore;
  const opts = {
    wsUrl: "wss://unused.test",
    logger,
    marketSnapshots,
    onBookView: (v: MarketDataView) => rec.books.push(v),
    onPrice: (tokenId: string, price: number, tMs: number) =>
      rec.prices.push({ tokenId, price, tMs }),
    onBookDelta: (tokenId: string, deltas: readonly BookDelta[], tMs: number) =>
      rec.deltas.push({ tokenId, deltas, tMs }),
    onHeartbeat: (tokenId: string, tMs: number) => rec.heartbeats.push({ tokenId, tMs }),
    onTickSizeChange: (tokenId: string) => rec.tickSizes.push(tokenId),
  };
  return { rec, feed: (msgs: WsMarketMessage[]) => handleMessages(msgs, opts) };
};

describe("market feed frame normalization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:15:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("book (current bids/asks shape): view + BEST-level mid + snapshot upsert", async () => {
    // Upstream sends levels WORST-first (verified live 2026-08-06). This book
    // is deliberately asymmetric: a naive [0]-read mid would be (0.01+0.99)/2
    // = 0.50 — the phantom that fabricated false price_move triggers.
    const { rec, feed } = makeFeedHarness();
    await feed([
      {
        event_type: "book",
        asset_id: TOKEN,
        market: COND,
        bids: [
          { price: "0.01", size: "1000" },
          { price: "0.52", size: "10" },
          { price: "0.54", size: "20" },
        ],
        asks: [
          { price: "0.99", size: "500" },
          { price: "0.58", size: "10" },
          { price: "0.56", size: "5" },
        ],
        timestamp: "1770000000",
      } as WsMarketMessage,
    ]);

    expect(rec.books).toHaveLength(1);
    const view = rec.books[0]!;
    // Levels sorted best-first regardless of upstream order.
    expect(view.bids.map((l) => l.price)).toEqual([0.54, 0.52, 0.01]);
    expect(view.asks.map((l) => l.price)).toEqual([0.56, 0.58, 0.99]);
    expect(view.sourceTimeMs).toBe(Date.now());
    // Mid of the BEST bid/ask feeds the price window — never the raw [0]s.
    expect(rec.prices).toEqual([{ tokenId: TOKEN, price: 0.55, tMs: Date.now() }]);
    expect(rec.upserts).toHaveLength(1);
    expect(rec.upserts[0]!["isStale"]).toBe(false);
    expect(rec.upserts[0]!["midPrice"]).toBe("0.5500");
  });

  it("book (legacy buys/sells shape) normalizes identically", async () => {
    const { rec, feed } = makeFeedHarness();
    await feed([
      {
        event_type: "book",
        asset_id: TOKEN,
        market: COND,
        buys: [{ price: "0.54", size: "20" }],
        sells: [{ price: "0.56", size: "5" }],
        timestamp: "1770000000",
      } as WsMarketMessage,
    ]);
    expect(rec.books).toHaveLength(1);
    expect(rec.books[0]!.bids[0]!.price).toBe(0.54);
    expect(rec.books[0]!.asks[0]!.price).toBe(0.56);
    expect(rec.prices[0]!.price).toBe(0.55);
  });

  it("price_change (batched, with bests): mid price + grouped deltas, NO snapshot write today", async () => {
    const { rec, feed } = makeFeedHarness();
    await feed([
      {
        event_type: "price_change",
        market: COND,
        timestamp: "1770000000",
        price_changes: [
          {
            asset_id: TOKEN,
            price: "0.56",
            size: "50",
            side: "SELL",
            best_bid: "0.54",
            best_ask: "0.56",
          },
          {
            asset_id: TOKEN,
            price: "0.54",
            size: "30",
            side: "BUY",
            best_bid: "0.54",
            best_ask: "0.56",
          },
        ],
      } as WsMarketMessage,
    ]);
    // Two price observations (one per item), both the mid of the bests.
    expect(rec.prices.map((p) => p.price)).toEqual([0.55, 0.55]);
    // One grouped delta call for the token; SELL→ask, BUY→bid.
    expect(rec.deltas).toHaveLength(1);
    expect(rec.deltas[0]!.deltas).toEqual([
      { price: 0.56, size: 50, side: "ask" },
      { price: 0.54, size: 30, side: "bid" },
    ]);
    // Documented gap (fixed in a later slice): deltas do not persist snapshots.
    expect(rec.upserts).toHaveLength(0);
  });

  it("price_change without bests: NO price sample (a raw level price is never a price)", async () => {
    // The false-trigger caught live on 2026-08-06: a deep resting order's
    // level price (0.47 on a 0.125 market) recorded as a "price observation"
    // fabricated a phantom 10¢+ move. Bestless items are book/liveness
    // signals only; the evaluator samples the PATCHED book mid instead.
    const { rec, feed } = makeFeedHarness();
    await feed([
      {
        event_type: "price_change",
        market: COND,
        timestamp: "1770000000",
        asset_id: TOKEN,
        price: "0.47",
      } as WsMarketMessage,
    ]);
    expect(rec.prices).toHaveLength(0);
    expect(rec.deltas).toHaveLength(0);
    expect(rec.heartbeats).toEqual([{ tokenId: TOKEN, tMs: Date.now() }]);
  });

  it("price_change with size/side but no bests: delta only, still no price sample", async () => {
    const { rec, feed } = makeFeedHarness();
    await feed([
      {
        event_type: "price_change",
        market: COND,
        timestamp: "1770000000",
        price_changes: [{ asset_id: TOKEN, price: "0.47", size: "50", side: "SELL" }],
      } as WsMarketMessage,
    ]);
    expect(rec.prices).toHaveLength(0);
    expect(rec.deltas).toHaveLength(1);
  });

  it("last_trade_price: price + heartbeat; snapshot updated only when a row exists", async () => {
    const none = makeFeedHarness(null);
    await none.feed([
      {
        event_type: "last_trade_price",
        asset_id: TOKEN,
        market: COND,
        price: "0.51",
        timestamp: "1770000000",
      } as WsMarketMessage,
    ]);
    expect(none.rec.prices).toEqual([{ tokenId: TOKEN, price: 0.51, tMs: Date.now() }]);
    expect(none.rec.heartbeats).toHaveLength(1);
    expect(none.rec.upserts).toHaveLength(0);

    const existing = makeFeedHarness({
      tokenId: TOKEN,
      conditionId: COND,
      bids: [],
      asks: [],
      midPrice: "0.5",
      source: "ws",
      isStale: false,
    });
    await existing.feed([
      {
        event_type: "last_trade_price",
        asset_id: TOKEN,
        market: COND,
        price: "0.51",
        timestamp: "1770000000",
      } as WsMarketMessage,
    ]);
    expect(existing.rec.upserts).toHaveLength(1);
    expect(existing.rec.upserts[0]!["lastTradePrice"]).toBe("0.51");
  });

  it("tick_size_change forwards the token id", async () => {
    const { rec, feed } = makeFeedHarness();
    await feed([
      {
        event_type: "tick_size_change",
        asset_id: TOKEN,
        market: COND,
        new_tick_size: "0.001",
        timestamp: "1770000000",
      } as WsMarketMessage,
    ]);
    expect(rec.tickSizes).toEqual([TOKEN]);
  });

  it("computeMidPrice: null without both sides; BEST levels regardless of ordering", () => {
    expect(computeMidPrice([], [{ price: "0.5" }])).toBeNull();
    expect(computeMidPrice([{ price: "0.5" }], [])).toBeNull();
    expect(computeMidPrice([{ price: "0.54" }], [{ price: "0.57" }])).toBe("0.5550");
    // Worst-first arrays (live upstream ordering): best bid 0.12, best ask 0.13.
    expect(
      computeMidPrice(
        [{ price: "0.01" }, { price: "0.12" }],
        [{ price: "0.99" }, { price: "0.13" }],
      ),
    ).toBe("0.1250");
  });
});
