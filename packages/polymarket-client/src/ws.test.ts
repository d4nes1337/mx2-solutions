import { describe, it, expect } from "vitest";
import {
  WsMarketMessageSchema,
  WsBookMessageSchema,
  WsPriceChangeMessageSchema,
  WsLastTradePriceMessageSchema,
  WsTickSizeChangeMessageSchema,
  bookSides,
  priceChangeItems,
} from "./ws/schema.js";
import { MarketWsClient } from "./ws/market-client.js";

const TOKEN_ID = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const MARKET_ID = "0xdd22472e552ac1051ef7c0cbaf0d2db4a2b04a71af8a7c3a7eda3edc20f0b2c";

describe("WsMarketMessageSchema", () => {
  it("parses a book message", () => {
    const msg: unknown = {
      event_type: "book",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      buys: [{ price: "0.545", size: "1500" }],
      sells: [{ price: "0.555", size: "1200" }],
      timestamp: "1700000000",
    };
    const result = WsMarketMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_type).toBe("book");
    }
  });

  it("parses a legacy (flat) price_change message", () => {
    const msg: unknown = {
      event_type: "price_change",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      price: "0.553",
      timestamp: "1700000010",
    };
    const result = WsMarketMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_type).toBe("price_change");
    }
  });

  it("parses the current (2025-09+) book message using bids/asks", () => {
    const msg: unknown = {
      event_type: "book",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      bids: [{ price: "0.545", size: "1500" }],
      asks: [{ price: "0.555", size: "1200" }],
      hash: "0xabc",
      timestamp: "1700000000",
    };
    const result = WsBookMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      const sides = bookSides(result.data);
      expect(sides.bids).toEqual([{ price: "0.545", size: "1500" }]);
      expect(sides.asks).toEqual([{ price: "0.555", size: "1200" }]);
    }
  });

  it("bookSides normalizes the legacy buys/sells shape", () => {
    const result = WsBookMessageSchema.safeParse({
      event_type: "book",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      buys: [{ price: "0.545", size: "1500" }],
      sells: [{ price: "0.555", size: "1200" }],
      timestamp: "1700000000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const sides = bookSides(result.data);
      expect(sides.bids).toEqual([{ price: "0.545", size: "1500" }]);
      expect(sides.asks).toEqual([{ price: "0.555", size: "1200" }]);
    }
  });

  it("parses the current (2025-09+) batched price_change message", () => {
    // Per docs.polymarket.com market-channel: asset_id lives INSIDE each
    // price_changes item, not at the top level.
    const msg: unknown = {
      event_type: "price_change",
      market: MARKET_ID,
      price_changes: [
        {
          asset_id: TOKEN_ID,
          price: "0.60",
          size: "3300",
          side: "SELL",
          hash: "0xdef",
          best_bid: "0.59",
          best_ask: "0.60",
        },
      ],
      timestamp: "1729084877448",
    };
    const result = WsPriceChangeMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      const items = priceChangeItems(result.data);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        assetId: TOKEN_ID,
        price: "0.60",
        size: "3300",
        side: "SELL",
        bestBid: "0.59",
        bestAsk: "0.60",
      });
    }
  });

  it("priceChangeItems normalizes the legacy flat shape", () => {
    const result = WsPriceChangeMessageSchema.safeParse({
      event_type: "price_change",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      price: "0.553",
      timestamp: "1700000010",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const items = priceChangeItems(result.data);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ assetId: TOKEN_ID, price: "0.553" });
    }
  });

  it("parses a last_trade_price message", () => {
    const msg: unknown = {
      event_type: "last_trade_price",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      price: "0.553",
      timestamp: "1700000010",
    };
    expect(WsMarketMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("parses a tick_size_change message", () => {
    const msg: unknown = {
      event_type: "tick_size_change",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      tick_size: "0.01",
      timestamp: "1700000020",
    };
    expect(WsMarketMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an unknown event_type", () => {
    const msg: unknown = {
      event_type: "unknown_future_event",
      asset_id: TOKEN_ID,
      timestamp: "1700000000",
    };
    expect(WsMarketMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("book message requires buys and sells arrays", () => {
    const incomplete: unknown = {
      event_type: "book",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      timestamp: "1700000000",
      // missing buys and sells
    };
    expect(WsBookMessageSchema.safeParse(incomplete).success).toBe(false);
  });
});

describe("individual message schemas", () => {
  it("WsBookMessageSchema rejects wrong event_type", () => {
    const msg: unknown = {
      event_type: "price_change",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      price: "0.55",
      timestamp: "1700000000",
    };
    expect(WsBookMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("WsPriceChangeMessageSchema rejects missing price", () => {
    const msg: unknown = {
      event_type: "price_change",
      asset_id: TOKEN_ID,
      market: MARKET_ID,
      timestamp: "1700000000",
    };
    expect(WsPriceChangeMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe("MarketWsClient", () => {
  it("starts in idle state", () => {
    const client = new MarketWsClient({
      wsUrl: "wss://example.invalid/ws/market",
      onMessage: () => {},
    });
    expect(client.currentState).toBe("idle");
    // Do not call subscribe — avoid opening a real socket in tests.
  });

  it("exposes WsLastTradePriceMessageSchema and WsTickSizeChangeMessageSchema", () => {
    // Ensures they are exported and usable.
    expect(WsLastTradePriceMessageSchema).toBeDefined();
    expect(WsTickSizeChangeMessageSchema).toBeDefined();
  });
});
