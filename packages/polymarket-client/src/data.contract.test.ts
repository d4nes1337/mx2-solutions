import { describe, it, expect } from "vitest";
import {
  ActivitySchema,
  ClosedPositionSchema,
  LeaderboardEntrySchema,
  PositionSchema,
  PositionValueSchema,
} from "./data/schema.js";

// Fixtures captured from the live Polymarket Data API on 2026-06-22.
const samplePosition: unknown = {
  proxyWallet: "0x997c95d8be61d5779edfb49aaf5dd83d85f31434",
  asset: "23671075461960714649241747386422883221530784061107785153438964021753509907395",
  conditionId: "0x1b6eab50dbd311232b55f08c226a8b713a8571adb1a72494ee2fe12356cbd00a",
  size: 4043.93,
  avgPrice: 0.0154,
  initialValue: 62.6526,
  currentValue: 0,
  cashPnl: -62.6526,
  percentPnl: -99.9999,
  totalBought: 4043.93,
  realizedPnl: 0,
  percentRealizedPnl: -100,
  curPrice: 0,
  redeemable: true,
  mergeable: false,
  title: "Will BetBoom win IEM Cologne Major 2026?",
  slug: "will-betboom-win-iem-cologne-major-2026",
  icon: "https://example.com/icon.png",
  eventId: "350795",
  eventSlug: "iem-cologne-major-2026-winner",
  outcome: "Yes",
  outcomeIndex: 0,
  oppositeOutcome: "No",
  oppositeAsset: "100359110674914522822697377537277907924870692163936528365268467884811762456483",
  endDate: "2026-06-21",
  negativeRisk: true,
};

const sampleTradeActivity: unknown = {
  proxyWallet: "0x997c95d8be61d5779edfb49aaf5dd83d85f31434",
  timestamp: 1782002719,
  conditionId: "0x1b6eab50dbd311232b55f08c226a8b713a8571adb1a72494ee2fe12356cbd00a",
  type: "TRADE",
  size: 500,
  usdcSize: 275.0,
  transactionHash: "0xtxhash",
  price: 0.55,
  asset: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  side: "BUY",
  outcomeIndex: 0,
  title: "Will X happen?",
  outcome: "Yes",
};

const sampleClosedPosition: unknown = {
  proxyWallet: "0x997c95d8be61d5779edfb49aaf5dd83d85f31434",
  asset: "123",
  conditionId: "0x9c183f63913cee589ec7a8d584fb7743a541f724edc047837c053c027bdf9074",
  avgPrice: 0.49,
  totalBought: 170,
  realizedPnl: -42.5,
  curPrice: 0.235,
  timestamp: 1782937889,
  title: "Will Belgium win on 2026-07-01?",
  slug: "fifwc-bel-sen-2026-07-01-bel",
  outcome: "Yes",
};

describe("PositionSchema", () => {
  it("parses a live position (numeric fields)", () => {
    const result = PositionSchema.safeParse(samplePosition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.size).toBe(4043.93);
      expect(result.data.currentValue).toBe(0);
      expect(result.data.realizedPnl).toBe(0);
    }
  });

  it("accepts a position without optional fields", () => {
    const minimal: unknown = {
      proxyWallet: "0x0",
      asset: "123",
      conditionId: "0xcond",
      size: 100,
      avgPrice: 0.5,
      initialValue: 50,
      currentValue: 55,
      cashPnl: 5,
      percentPnl: 10,
      totalBought: 50,
      realizedPnl: 0,
    };
    expect(PositionSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects a position with string numeric fields", () => {
    const wrong: unknown = { ...(samplePosition as object), size: "4043.93" };
    expect(PositionSchema.safeParse(wrong).success).toBe(false);
  });
});

describe("ActivitySchema", () => {
  it("parses a TRADE activity", () => {
    const result = ActivitySchema.safeParse(sampleTradeActivity);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("TRADE");
      expect(result.data.price).toBe(0.55);
    }
  });

  it("parses a MAKER_REBATE activity (open type set, empty asset)", () => {
    const rebate: unknown = {
      proxyWallet: "0x997c95d8be61d5779edfb49aaf5dd83d85f31434",
      timestamp: 1782002719,
      conditionId: "",
      type: "MAKER_REBATE",
      size: 3.9616,
      usdcSize: 3.9616,
      transactionHash: "0x474ff1",
      price: 0,
      asset: "",
      side: "",
      outcomeIndex: 999,
    };
    expect(ActivitySchema.safeParse(rebate).success).toBe(true);
  });

  it("parses a REDEEM activity", () => {
    const redeem: unknown = {
      proxyWallet: "0x0",
      timestamp: 1700001000,
      type: "REDEEM",
      size: 500,
      usdcSize: 500,
      price: 1.0,
    };
    expect(ActivitySchema.safeParse(redeem).success).toBe(true);
  });
});

describe("ClosedPositionSchema", () => {
  it("parses a closed position", () => {
    const result = ClosedPositionSchema.safeParse(sampleClosedPosition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.realizedPnl).toBe(-42.5);
      expect(result.data.curPrice).toBe(0.235);
    }
  });
});

describe("PositionValueSchema", () => {
  it("parses user position value", () => {
    expect(
      PositionValueSchema.safeParse({
        user: "0x997c95d8be61d5779edfb49aaf5dd83d85f31434",
        value: 134.312,
      }).success,
    ).toBe(true);
  });
});

describe("LeaderboardEntrySchema", () => {
  it("parses all-time leaderboard PnL for one user", () => {
    const result = LeaderboardEntrySchema.safeParse({
      rank: "123448",
      proxyWallet: "0x997c95d8be61d5779edfb49aaf5dd83d85f31434",
      userName: "ydsmx2",
      vol: 137621.586188,
      pnl: 400.27321950723183,
      profileImage: "https://example.com/avatar.webp",
    });
    expect(result.success).toBe(true);
  });
});
