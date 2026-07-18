import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OrderbookSchema,
  TradeSchema,
  TokenPriceSchema,
  UserTradesResponseSchema,
} from "./clob/schema.js";
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

describe("UserTradesResponseSchema (authenticated GET /data/trades)", () => {
  it("parses the paginated envelope with maker_orders attribution", () => {
    // Field set mirrors @polymarket/clob-client's Trade/MakerOrder types.
    const payload: unknown = {
      data: [
        {
          id: "t-1",
          taker_order_id: "0xtaker",
          market: "0xcond",
          asset_id: "123",
          side: "BUY",
          size: "10",
          fee_rate_bps: "0",
          price: "0.41",
          status: "CONFIRMED",
          match_time: "1700000000",
          last_update: "1700000001",
          outcome: "No",
          bucket_index: 0,
          owner: "api-key",
          maker_address: "0xmaker",
          maker_orders: [
            {
              order_id: "0xours",
              owner: "api-key",
              maker_address: "0xmaker",
              matched_amount: "10",
              price: "0.41",
              fee_rate_bps: "0",
              asset_id: "123",
              outcome: "No",
              side: "SELL",
            },
          ],
          transaction_hash: "0xabc",
          trader_side: "MAKER",
        },
      ],
      next_cursor: "LTE=",
      limit: 100,
      count: 1,
    };
    const result = UserTradesResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data[0]!.maker_orders[0]!.matched_amount).toBe("10");
      expect(result.data.next_cursor).toBe("LTE=");
    }
  });

  it("tolerates missing optional fields (taker_order_id, maker_orders)", () => {
    const result = UserTradesResponseSchema.safeParse({
      data: [
        {
          id: "t-2",
          market: "0xcond",
          asset_id: "123",
          side: "SELL",
          size: "5",
          price: "0.6",
          status: "CONFIRMED",
          match_time: "1700000000",
        },
      ],
      next_cursor: "MA==",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data[0]!.maker_orders).toEqual([]);
    }
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
