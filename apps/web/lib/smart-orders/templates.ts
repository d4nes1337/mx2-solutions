/**
 * First-class strategy templates. Each returns a complete StrategyDoc the
 * builder opens pre-populated — never an empty canvas. Templates may leave
 * market references unbound (UNBOUND); validation walks the user to bind them.
 */
import type { MarketRef } from "@mx2/rules";
import { UNBOUND, freshNodeId, type MarketMeta, type StrategyDoc, emptyDoc } from "./doc";
import { layoutDoc } from "./layout";

export interface TemplateDef {
  id: string;
  name: string;
  blurb: string;
  example: string;
  build: (market?: MarketRef, meta?: MarketMeta) => StrategyDoc;
}

const withMeta = (doc: StrategyDoc, market?: MarketRef, meta?: MarketMeta): StrategyDoc => {
  if (market && meta) doc.marketMeta[market.tokenId] = meta;
  return layoutDoc(doc);
};

const reEntry: TemplateDef = {
  id: "re-entry",
  name: "Re-entry",
  blurb: "Buy the dip — only when the price holds and liquidity confirms it.",
  example: "If YES drops below 58¢ for 5 min and liquidity ≥ $2,000, buy YES at 57¢.",
  build: (market = UNBOUND, meta) => {
    const doc = emptyDoc();
    doc.templateId = "re-entry";
    doc.name = "Re-entry";
    doc.expr = {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: freshNodeId(),
          condition: { kind: "price", market, source: "ask", comparator: "lte", threshold: 0.58 },
        },
        {
          type: "condition",
          id: freshNodeId(),
          condition: {
            kind: "cumulative_notional",
            market,
            source: "ask",
            priceBound: 0.58,
            minNotional: 2000,
          },
        },
      ],
    };
    doc.holdsForMs = 300_000;
    doc.action = {
      kind: "order",
      market,
      side: "BUY",
      price: 0.57,
      size: 100,
      orderType: "GTC",
      execution: "prepare",
    };
    return withMeta(doc, market, meta);
  },
};

const crossMarket: TemplateDef = {
  id: "cross-market",
  name: "Cross-market",
  blurb: "React when two related markets disagree, using @market references.",
  example: "If this market is above 70¢ and @other market is above 40¢ for 10 min, alert me.",
  build: (market = UNBOUND, meta) => {
    const doc = emptyDoc();
    doc.templateId = "cross-market";
    doc.name = "Cross-market watch";
    doc.expr = {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: freshNodeId(),
          condition: { kind: "price", market, source: "ask", comparator: "gte", threshold: 0.7 },
        },
        {
          type: "condition",
          id: freshNodeId(),
          // Second market intentionally unbound — the user @mentions it.
          condition: {
            kind: "price",
            market: UNBOUND,
            source: "ask",
            comparator: "gte",
            threshold: 0.4,
          },
        },
      ],
    };
    doc.holdsForMs = 600_000;
    doc.action = { kind: "alert" };
    return withMeta(doc, market, meta);
  },
};

const makerReward: TemplateDef = {
  id: "maker-reward",
  name: "Reward-aware maker",
  blurb:
    "Quote when the spread, liquidity and reward conditions line up — with a clear estimate first.",
  example: "If the spread is tighter than 2¢ and liquidity is healthy, prepare a maker quote.",
  build: (market = UNBOUND, meta) => {
    const doc = emptyDoc();
    doc.templateId = "maker-reward";
    doc.name = "Reward-aware maker";
    doc.expr = {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: freshNodeId(),
          condition: { kind: "spread", market, comparator: "lte", threshold: 0.02 },
        },
        {
          type: "condition",
          id: freshNodeId(),
          condition: {
            kind: "cumulative_notional",
            market,
            source: "ask",
            priceBound: 0.99,
            minNotional: 1000,
          },
        },
      ],
    };
    doc.holdsForMs = 120_000;
    // Estimator-first (D-019): the template prepares a resting quote the user
    // signs; the automated quote/cancel/replace loop is deliberately deferred
    // until re-entry auto-mode is proven live.
    doc.action = {
      kind: "order",
      market,
      side: "BUY",
      price: 0.5,
      size: 200,
      orderType: "GTC",
      execution: "prepare",
    };
    return withMeta(doc, market, meta);
  },
};

export const TEMPLATES: readonly TemplateDef[] = [reEntry, crossMarket, makerReward];

export const templateById = (id: string): TemplateDef | null =>
  TEMPLATES.find((t) => t.id === id) ?? null;
