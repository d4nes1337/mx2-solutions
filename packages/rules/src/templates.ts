/**
 * Canonical strategy templates — the ONE source of truth for template
 * structure, copy, hero prompts and the AI few-shot examples. The web builder
 * adapts specs into editor docs (apps/web/lib/smart-orders/templates.ts) and
 * the API builds its NL-generation few-shots from `aiFewShot`, so the three
 * surfaces can never drift again (they were hand-synced before round 4).
 *
 * Pure data + builders only: this module must stay importable from both the
 * API (Node) and the web bundle.
 */
import type { MarketRef, StrategyDefinition } from "./types-v2.js";

/** Placeholder for a market the user hasn't bound yet. */
const UNBOUND_MARKET: MarketRef = { conditionId: "", tokenId: "", outcome: "YES" };

export interface TemplateSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** One-line example sentence shown in galleries. */
  readonly example: string;
  /** Ready-to-send AI prompt (hero carousel / chat seeds). */
  readonly prompt: string;
  /**
   * Feature flag gating gallery visibility (key of the /api/feature-flags
   * response), or null for always-visible.
   */
  readonly flag: "makerLoop" | null;
  /** Complete definition skeleton; markets left unbound when not provided. */
  buildDefinition(market?: MarketRef): StrategyDefinition;
  /**
   * Literal few-shot for the AI system prompt: the user line (including any
   * parenthetical search context) and the exact create_strategy JSON.
   */
  readonly aiFewShot: { user: string; json: string } | null;
}

const base = (
  id: string,
  name: string,
  expr: StrategyDefinition["expr"],
  holdsForMs: number,
  action: StrategyDefinition["action"],
): StrategyDefinition => ({
  version: 2,
  name,
  templateId: id,
  expr,
  holdsForMs,
  maxDataAgeMs: 5_000,
  action,
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
});

const dipBuy: TemplateSpec = {
  id: "re-entry",
  name: "Dip buy",
  blurb: "Buy the dip — only when the price holds and real liquidity confirms it.",
  example: "If YES drops below 58¢ for 5 min and liquidity ≥ $2,000, buy YES at 57¢.",
  prompt: "Buy 100 YES at 57¢ if the price drops below 58¢ for 5 minutes with $2,000 of liquidity",
  flag: null,
  buildDefinition: (market = UNBOUND_MARKET) =>
    base(
      "re-entry",
      "Dip buy",
      {
        type: "group",
        id: "root",
        op: "and",
        children: [
          {
            type: "condition",
            id: "c1",
            condition: { kind: "price", market, source: "ask", comparator: "lte", threshold: 0.58 },
          },
          {
            type: "condition",
            id: "c2",
            condition: {
              kind: "cumulative_notional",
              market,
              source: "ask",
              priceBound: 0.58,
              minNotional: 2000,
            },
          },
        ],
      },
      300_000,
      {
        kind: "order",
        market,
        side: "BUY",
        price: 0.57,
        size: 100,
        orderType: "GTC",
        execution: "prepare",
      },
    ),
  aiFewShot: {
    user: '"If YES drops below 58¢ for 5 min and liquidity ≥ $2,000, buy YES at 57¢." (after search_markets returned the market as candidate 0 with outcomes ["Yes","No"])',
    json: '{"name":"Dip buy","summary":"Watches for a dip below 58¢ that holds for 5 minutes with at least $2,000 of ask liquidity, then prepares a buy of 100 Yes shares at 57¢ for you to sign.","rootOp":"and","conditions":[{"type":"condition","condition":{"kind":"price","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"lte","threshold":0.58,"priceBound":null,"minNotional":null,"minLevels":null,"startMs":null,"endMs":null,"direction":null,"deltaThreshold":null,"windowMs":null}},{"type":"condition","condition":{"kind":"cumulative_notional","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"lte","threshold":null,"priceBound":0.58,"minNotional":2000,"minLevels":null,"startMs":null,"endMs":null,"direction":null,"deltaThreshold":null,"windowMs":null}}],"holdsForMs":300000,"action":{"kind":"order","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"side":"BUY","price":0.57,"size":100},"recurrence":{"kind":"once","maxRepeats":null,"cooldownMs":null}}',
  },
};

const spikeReversal: TemplateSpec = {
  id: "spike-reversal",
  name: "Spike reversal",
  blurb:
    "Catch the overreaction: when the price gaps during a live event, enter with a time-boxed limit order.",
  example: "If the price crashes 5¢+ within 5 minutes, place a buy that expires 5 minutes later.",
  prompt:
    "If @market crashes 5 cents within 5 minutes, prepare a limit buy just under the new price that expires after 5 minutes",
  flag: null,
  buildDefinition: (market = UNBOUND_MARKET) =>
    base(
      "spike-reversal",
      "Spike reversal",
      {
        type: "group",
        id: "root",
        op: "and",
        children: [
          {
            type: "condition",
            id: "c1",
            condition: {
              kind: "price_move",
              market,
              direction: "drop",
              deltaThreshold: 0.05,
              windowMs: 300_000,
            },
          },
        ],
      },
      0, // react immediately — the move IS the signal
      {
        kind: "order",
        market,
        side: "BUY",
        price: 0.45,
        size: 100,
        orderType: "GTD",
        expiresAfterMs: 300_000,
        execution: "prepare",
      },
    ),
  aiFewShot: {
    user: '"If the favourite\'s price crashes 8 cents within 5 minutes during the match, prepare a buy 10 cents under wherever it lands." (candidate 0, current Yes price 0.72)',
    json: '{"name":"Spike reversal entry","summary":"Watches for an 8¢ drop inside 5 minutes, then immediately prepares a 100-share buy at 54¢ for you to sign.","rootOp":"and","conditions":[{"type":"condition","condition":{"kind":"price_move","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"lte","threshold":null,"priceBound":null,"minNotional":null,"minLevels":null,"startMs":null,"endMs":null,"direction":"drop","deltaThreshold":0.08,"windowMs":300000}}],"holdsForMs":0,"action":{"kind":"order","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"side":"BUY","price":0.54,"size":100},"recurrence":{"kind":"once","maxRepeats":null,"cooldownMs":null}}',
  },
};

const makerEfficiency: TemplateSpec = {
  id: "maker-reward",
  name: "Maker efficiency",
  blurb:
    "Rest a post-only quote when the spread and rewards line up — makers pay no fee and share the rewards pool.",
  example: "If the spread is tighter than 2¢ and liquidity is healthy, rest a post-only maker quote.",
  prompt:
    "When the spread on @market tightens under 2 cents with healthy liquidity, prepare a 200-share maker quote",
  flag: null,
  buildDefinition: (market = UNBOUND_MARKET) =>
    base(
      "maker-reward",
      "Maker efficiency",
      {
        type: "group",
        id: "root",
        op: "and",
        children: [
          {
            type: "condition",
            id: "c1",
            condition: { kind: "spread", market, comparator: "lte", threshold: 0.02 },
          },
          {
            type: "condition",
            id: "c2",
            condition: {
              kind: "cumulative_notional",
              market,
              source: "ask",
              priceBound: 0.99,
              minNotional: 1000,
            },
          },
        ],
      },
      120_000,
      // Estimator-first (D-019): a post-only resting quote the user signs; the
      // automated quote/cancel loop is the separately-gated quote_loop (RFC-0003).
      {
        kind: "order",
        market,
        side: "BUY",
        price: 0.5,
        size: 200,
        orderType: "GTC",
        postOnly: true,
        execution: "prepare",
      },
    ),
  aiFewShot: {
    user: '"Quote this market whenever the spread is tighter than 2 cents and there\'s healthy liquidity."',
    json: '{"name":"Maker efficiency","summary":"When the spread tightens under 2¢ with at least $1,000 resting, prepares a 200-share maker quote at 50¢ for you to sign.","rootOp":"and","conditions":[{"type":"condition","condition":{"kind":"spread","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"lte","threshold":0.02,"priceBound":null,"minNotional":null,"minLevels":null,"startMs":null,"endMs":null,"direction":null,"deltaThreshold":null,"windowMs":null}},{"type":"condition","condition":{"kind":"cumulative_notional","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"lte","threshold":null,"priceBound":0.99,"minNotional":1000,"minLevels":null,"startMs":null,"endMs":null,"direction":null,"deltaThreshold":null,"windowMs":null}}],"holdsForMs":120000,"action":{"kind":"order","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"side":"BUY","price":0.5,"size":200},"recurrence":{"kind":"once","maxRepeats":null,"cooldownMs":null}}',
  },
};

const crossMarket: TemplateSpec = {
  id: "cross-market",
  name: "Cross-market",
  blurb: "React when two related markets disagree, using @market references.",
  example: "If this market is above 70¢ and @other market is above 40¢ for 10 min, alert me.",
  prompt: "Alert me if @market goes above 70¢ while @other market holds above 40¢ for 10 minutes",
  flag: null,
  buildDefinition: (market = UNBOUND_MARKET) =>
    base(
      "cross-market",
      "Cross-market watch",
      {
        type: "group",
        id: "root",
        op: "and",
        children: [
          {
            type: "condition",
            id: "c1",
            condition: { kind: "price", market, source: "ask", comparator: "gte", threshold: 0.7 },
          },
          {
            type: "condition",
            id: "c2",
            // Second market intentionally unbound — the user @mentions it.
            condition: {
              kind: "price",
              market: UNBOUND_MARKET,
              source: "ask",
              comparator: "gte",
              threshold: 0.4,
            },
          },
        ],
      },
      600_000,
      { kind: "alert" },
    ),
  aiFewShot: {
    user: '"Alert me if this market goes above 70¢ while that other market is above 40¢ for 10 minutes." (candidates 0 and 1 from two search_markets calls)',
    json: '{"name":"Cross-market watch","summary":"Alerts you when the first market trades above 70¢ while the second holds above 40¢ for 10 minutes.","rootOp":"and","conditions":[{"type":"condition","condition":{"kind":"price","market":{"source":"search","index":0,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"gte","threshold":0.7,"priceBound":null,"minNotional":null,"minLevels":null,"startMs":null,"endMs":null,"direction":null,"deltaThreshold":null,"windowMs":null}},{"type":"condition","condition":{"kind":"price","market":{"source":"search","index":1,"tokenId":"","outcome":"Yes"},"source":"ask","comparator":"gte","threshold":0.4,"priceBound":null,"minNotional":null,"minLevels":null,"startMs":null,"endMs":null,"direction":null,"deltaThreshold":null,"windowMs":null}}],"holdsForMs":600000,"action":{"kind":"alert","market":null,"side":"BUY","price":null,"size":null},"recurrence":{"kind":"once","maxRepeats":null,"cooldownMs":null}}',
  },
};

const rebateFarm: TemplateSpec = {
  id: "rebate-farm",
  name: "Rebate farm",
  blurb:
    "Delta-neutral maker loop: quote both sides near mid, merge filled pairs back to cash, farm the rewards pool.",
  example: "Quote 100 shares both sides at mid ±2¢, merging pairs — halting at your caps.",
  prompt: "", // designed in the farming cockpit, not via chat
  flag: "makerLoop",
  buildDefinition: (market = UNBOUND_MARKET) =>
    base(
      "rebate-farm",
      "Rebate farm",
      { type: "group", id: "root", op: "and", children: [] }, // always-on gate
      0,
      {
        kind: "quote_loop",
        market: {
          conditionId: market.conditionId,
          yesTokenId: market.tokenId,
          noTokenId: "",
          ...(market.title !== undefined ? { title: market.title } : {}),
        },
        sizeShares: 100,
        targetSpreadCents: 2,
        requoteToleranceCents: 1,
        maxInventoryShares: 200,
        maxCapitalUsd: 150,
        maxDailyLossUsd: 10,
      },
    ),
  aiFewShot: null,
};

/** Gallery/AI ordering: business scenarios first. */
export const TEMPLATE_SPECS: readonly TemplateSpec[] = [
  dipBuy,
  spikeReversal,
  makerEfficiency,
  rebateFarm,
  crossMarket,
];

export const templateSpecById = (id: string): TemplateSpec | null =>
  TEMPLATE_SPECS.find((t) => t.id === id) ?? null;
