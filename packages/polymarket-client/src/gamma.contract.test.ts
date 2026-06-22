import { describe, it, expect } from "vitest";
import { GammaEventSchema, GammaMarketSchema, PricePointSchema } from "./gamma/schema.js";

const sampleMarket: unknown = {
  id: "508994",
  question: "Will X happen?",
  conditionId: "0xdd22472e552ac1051ef7c0cbaf0d2db4a2b04a71af8a7c3a7eda3edc20f0b2c",
  slug: "will-x-happen",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.55","0.45"]',
  clobTokenIds:
    '["71321045679252212594626385532706912750332728571942532289631379312455583992563","52114319501245915516055106046884209969926127482827954674443846427813813222426"]',
  active: true,
  closed: false,
  archived: false,
  restricted: false,
  liquidity: "250000.50",
  volume: "1500000.75",
  openInterest: "180000.00",
  lastTradePrice: "0.55",
  bestBid: "0.545",
  bestAsk: "0.555",
  spread: "0.01",
  status: "open",
  acceptingOrders: true,
};

const sampleEvent: unknown = {
  id: "12345",
  title: "Test Event",
  slug: "test-event",
  description: "A test event",
  active: true,
  closed: false,
  archived: false,
  restricted: false,
  tags: [{ id: "1", label: "Politics", slug: "politics" }],
  markets: [sampleMarket],
};

describe("GammaMarketSchema", () => {
  it("parses a valid market object", () => {
    const result = GammaMarketSchema.safeParse(sampleMarket);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("508994");
      expect(result.data.conditionId).toBe(
        "0xdd22472e552ac1051ef7c0cbaf0d2db4a2b04a71af8a7c3a7eda3edc20f0b2c",
      );
      expect(result.data.active).toBe(true);
    }
  });

  it("applies defaults for missing optional fields", () => {
    const minimal: unknown = {
      id: "1",
      conditionId: "0xabc",
    };
    const result = GammaMarketSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.liquidity).toBe("0");
      expect(result.data.outcomes).toBe("[]");
      expect(result.data.status).toBe("closed");
    }
  });
});

describe("GammaEventSchema", () => {
  it("parses a valid event with nested markets", () => {
    const result = GammaEventSchema.safeParse(sampleEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("12345");
      expect(result.data.markets).toHaveLength(1);
      expect(result.data.markets[0]?.id).toBe("508994");
      expect(result.data.tags).toHaveLength(1);
    }
  });

  it("applies default empty arrays for missing tags and markets", () => {
    const minimal: unknown = { id: "2" };
    const result = GammaEventSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.markets).toEqual([]);
    }
  });
});

describe("PricePointSchema", () => {
  it("parses a valid price point", () => {
    const result = PricePointSchema.safeParse({ t: 1700000000, p: 0.55 });
    expect(result.success).toBe(true);
  });

  it("parses an array of price points", () => {
    const points = [
      { t: 1700000000, p: 0.55 },
      { t: 1700003600, p: 0.57 },
    ];
    const result = PricePointSchema.array().safeParse(points);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
  });
});
