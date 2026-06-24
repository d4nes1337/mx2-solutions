import { describe, it, expect, vi, afterEach } from "vitest";
import { OrderbookSchema, TradeSchema, TokenPriceSchema } from "./clob/schema.js";
import { createClobClient } from "./clob/client.js";

const sampleOrderbook: unknown = {
  market: "0xdd22472e552ac1051ef7c0cbaf0d2db4a2b04a71af8a7c3a7eda3edc20f0b2c",
  asset_id: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  bids: [
    { price: "0.545", size: "1500.00" },
    { price: "0.540", size: "3200.00" },
    { price: "0.535", size: "5000.00" },
  ],
  asks: [
    { price: "0.555", size: "1200.00" },
    { price: "0.560", size: "2800.00" },
    { price: "0.565", size: "4500.00" },
  ],
  hash: "0x7a8b9c0d1e2f",
  timestamp: "1700000000",
};

const sampleTrade: unknown = {
  id: "trade_001",
  market: "0xdd22472e552ac1051ef7c0cbaf0d2db4a2b04a71af8a7c3a7eda3edc20f0b2c",
  asset_id: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  side: "BUY",
  size: "100.00",
  price: "0.55",
  status: "MATCHED",
  match_time: "1700000000",
  outcome: "Yes",
  transaction_hash: "0xabc123",
  type: "TRADE",
};

describe("OrderbookSchema", () => {
  it("parses a valid orderbook", () => {
    const result = OrderbookSchema.safeParse(sampleOrderbook);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bids).toHaveLength(3);
      expect(result.data.asks).toHaveLength(3);
      expect(result.data.bids[0]?.price).toBe("0.545");
    }
  });

  it("accepts an orderbook with empty sides", () => {
    const empty: unknown = {
      market: "0xabc",
      asset_id: "123",
      bids: [],
      asks: [],
    };
    expect(OrderbookSchema.safeParse(empty).success).toBe(true);
  });
});

describe("TradeSchema", () => {
  it("parses a valid trade", () => {
    const result = TradeSchema.safeParse(sampleTrade);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.side).toBe("BUY");
      expect(result.data.price).toBe("0.55");
    }
  });

  it("rejects a trade with invalid side", () => {
    const bad: unknown = {
      id: "trade_001",
      market: "0xdd22472e552ac1051ef7c0cbaf0d2db4a2b04a71af8a7c3a7eda3edc20f0b2c",
      asset_id: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      side: "HOLD",
      size: "100.00",
      price: "0.55",
      status: "MATCHED",
      match_time: "1700000000",
      type: "TRADE",
    };
    expect(TradeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("TokenPriceSchema", () => {
  it("parses a valid token price", () => {
    const result = TokenPriceSchema.safeParse({
      token_id: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      price: "0.55",
      winner: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("ClobClient.getPricesHistory", () => {
  afterEach(() => vi.restoreAllMocks());

  it("queries the CLOB host by TOKEN id (not conditionId) and unwraps `history`", async () => {
    // Regression for the bug where this hit the Gamma host with the conditionId
    // and a bare-array schema → 404 / empty for every market.
    let calledUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calledUrl = url;
        return new Response(
          JSON.stringify({
            history: [
              { t: 1779498020, p: 0.485 },
              { t: 1779501607, p: 0.49 },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const clob = createClobClient({ baseUrl: "https://clob.example.com" });
    const res = await clob.getPricesHistory({ tokenId: "TOKEN123" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(2);
      expect(res.value[0]).toEqual({ t: 1779498020, p: 0.485 });
    }

    const u = new URL(calledUrl);
    expect(u.origin).toBe("https://clob.example.com");
    expect(u.pathname).toBe("/prices-history");
    expect(u.searchParams.get("market")).toBe("TOKEN123");
    expect(u.searchParams.get("interval")).toBe("max");
  });
});
