// Frontend response types. These MIRROR the backend's Zod schemas — they are
// intentionally hand-written (not imported) because the backend packages pull
// node-only deps (e.g. `ws`). Sources of truth:
//   - packages/polymarket-client/src/gamma/schema.ts  (GammaEvent, GammaMarket)
//   - packages/polymarket-client/src/data/schema.ts   (Position, Activity)
//   - apps/api/src/routes/*.ts                          (response envelopes)

export interface GammaMarket {
  id: string;
  question: string;
  description: string;
  conditionId: string;
  slug: string;
  image: string;
  icon: string;
  active: boolean;
  closed: boolean;
  liquidity: string;
  volume: string;
  lastTradePrice: string;
  bestBid: string;
  bestAsk: string;
  spread: string;
  // JSON-encoded string arrays in the Gamma response.
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  endDate?: string | null;
  /** Neg-risk markets are matched on a different exchange contract. */
  neg_risk?: boolean;
  [key: string]: unknown;
}

export interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  image: string;
  icon: string;
  active: boolean;
  closed: boolean;
  startDate?: string | null;
  creationDate?: string | null;
  createdAt?: string | null;
  endDate?: string | null;
  liquidity?: number | string;
  liquidityClob?: number | string;
  volume?: number | string;
  volume24hr?: number | string;
  volume1wk?: number | string;
  volume1mo?: number | string;
  markets: GammaMarket[];
  [key: string]: unknown;
}

export interface EventsResponse {
  events: GammaEvent[];
  count: number;
}

export interface OrderLevel {
  price: string;
  size: string;
}

export interface LiveOrderbook {
  orderbook: { bids: OrderLevel[]; asks: OrderLevel[] } | null;
  orderbookSource: string;
  isStale: boolean;
}

export type MarketDetail = GammaMarket & { _live: LiveOrderbook };

export interface OrderbookResponse {
  tokenId: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
  isStale: boolean;
  source: string;
  receivedAt: string;
}

export interface PricePoint {
  t: number;
  p: number;
}

export interface PricesHistoryResponse {
  conditionId: string;
  history: PricePoint[];
}

export interface FeatureFlags {
  liveTrading: boolean;
  conditionalRules: boolean;
  conditionalLiveExecution: boolean;
  relayer: boolean;
}

export interface TradeStatus {
  tradingEnabled: boolean;
  featureFlag: boolean;
  runtimePaused: boolean;
  geoblock: { status: string; country?: string; error?: string };
}

export interface Me {
  address: string;
  allowlisted: boolean;
  /** Derived Polymarket deposit (Gnosis Safe) wallet; null if derivation failed. */
  depositWallet: string | null;
}

export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice?: number;
  title?: string;
  slug?: string;
  icon?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface PositionsResponse {
  signerAddress: string;
  queryAddress: string;
  positions: Position[];
  count: number;
  dataSource: string;
  fetchedAt: string;
}

export interface Activity {
  proxyWallet: string;
  timestamp: number;
  type: string;
  size: number;
  usdcSize: number;
  price: number;
  side?: string;
  title?: string;
  outcome?: string;
  transactionHash?: string;
  [key: string]: unknown;
}

export interface HistoryResponse {
  signerAddress: string;
  queryAddress: string;
  activity: Activity[];
  count: number;
  totalFetched?: number;
  hasMore?: boolean;
  dataSource: string;
  fetchedAt: string;
}

export type HistoryTypeFilter = "all" | "trade" | "redeem" | "other";

export interface PortfolioOverviewResponse {
  signerAddress: string;
  queryAddress: string;
  fetchedAt: string;
  dataSource: string;
  summary: PnlSummary;
  positions: Position[];
  activityPreview: Activity[];
  counts: {
    openOrders: number;
    usdcBalance: string | null;
    setupRequired: boolean;
  };
  methodology: string;
  limitations: string[];
}

export type EquityWindow = "7d" | "30d" | "all";

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface EquityHistoryResponse {
  signerAddress: string;
  queryAddress: string;
  window: EquityWindow;
  points: EquityPoint[];
  disclaimer: string;
  methodology: string;
  computedAt: string;
}

export interface EnrichedOpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  original_size: string;
  size_matched?: string;
  price: string;
  status: string;
  created_at?: number;
  type?: string;
  title?: string;
  marketId?: string;
  slug?: string;
}

export interface OpenOrdersResponse {
  signerAddress: string;
  setupRequired: boolean;
  balance: string | null;
  openOrders: EnrichedOpenOrder[];
  count: number;
  fetchedAt: string;
}

export interface MarketResolveResponse {
  marketId: string;
  question: string;
  slug: string;
  conditionId: string;
}

export interface PnlSummary {
  unrealizedPnl: string;
  realizedPnl: string;
  totalPnl: string;
  currentPortfolioValue: string;
  openPositions: number;
}

export interface PnlResponse {
  signerAddress: string;
  queryAddress: string;
  computedAt: string;
  dataSource: string;
  summary: PnlSummary;
  methodology: string;
  limitations: string[];
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "GTC" | "GTD" | "FOK";

export interface OrderPreviewRequest {
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  price: string;
  size: string;
  orderType: OrderType;
  funder: string;
}

export interface OrderPreviewResponse {
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  price: string;
  size: string;
  orderType: OrderType;
  funder: string;
  maxSpend: string;
  builderCode: string | null;
  signatureType: number;
  timestamp: string;
  note: string;
  warning: string;
}

// CLOB V2 signed order produced client-side (lib/order-sign.ts).
export interface SignedClobOrder {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: OrderSide | 0 | 1;
  signatureType: number;
  timestamp: string;
  metadata: string;
  builder: string;
  expiration?: string;
  signature: string;
}

export interface SetupCredentialsRequest {
  l1Signature: string;
  timestamp: string;
  nonce: string;
}

export interface SetupCredentialsResponse {
  ok: boolean;
  apiKey: string;
}

export interface SubmitOrderRequest {
  idempotencyKey: string;
  conditionId: string;
  price: string;
  size: string;
  orderType: OrderType;
  order: SignedClobOrder;
}

export interface SubmitOrderResponse {
  intentId: string;
  clobOrderId: string | null;
  status: string;
  idempotent?: boolean;
}

// ── Conditional rules (mirror apps/api/src/routes/rules.ts + @mx2/rules) ──────

export type RuleStatus =
  | "DRAFT"
  | "ACTIVE_WAITING"
  | "ACTIVE_ACCUMULATING"
  | "PAUSED"
  | "TRIGGERED_AWAITING_USER"
  | "EXECUTED_MANUALLY"
  | "EXPIRED"
  | "CANCELLED"
  | "INVALIDATED"
  | "ERROR";

export interface RulePredicateInput {
  kind: "price" | "cumulative_notional" | "visible_levels";
  source: "ask" | "bid";
  comparator?: "lte" | "gte";
  threshold?: number;
  priceBound?: number;
  minNotional?: number;
  minLevels?: number;
}

export interface PrepareOrderActionView {
  kind: "prepare_order";
  side: OrderSide;
  price: number;
  size: number;
  orderType: "GTC";
}

export interface CreateRuleRequest {
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  predicates: RulePredicateInput[];
  continuousWindowMs: number;
  maxDataAgeMs: number;
  action: PrepareOrderActionView;
  expiresAt?: string | null;
}

export interface RuleDefinitionView {
  version: number;
  tokenId: string;
  conditionId: string;
  outcomeSide: OrderSide;
  predicates: RulePredicateInput[];
  continuousWindowMs: number;
  maxDataAgeMs: number;
  action: PrepareOrderActionView;
  recurrence: "once";
  expiresAtMs: number | null;
}

export interface RuleRow {
  id: string;
  walletAddress: string;
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  definition: RuleDefinitionView;
  definitionHash: string;
  status: RuleStatus;
  version: number;
  trueSince: string | null;
  expiresAt: string | null;
  pausedAt: string | null;
  lastEvaluatedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RulesResponse {
  rules: RuleRow[];
}

export interface PredicateResultView {
  kind: string;
  satisfied: boolean;
  actual: number | null;
  threshold: number;
  reason: string;
}

export interface EvaluateNowResponse {
  ruleId: string;
  status: RuleStatus;
  maxDataAgeMs: number;
  continuousWindowMs: number;
  hasData: boolean;
  isStale: boolean;
  dataAgeMs: number | null;
  satisfied: boolean;
  predicates?: PredicateResultView[];
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
}

export interface TriggerEvidenceView {
  evaluatorVersion: string;
  ruleDefinitionHash: string;
  tokenId: string;
  conditionId: string;
  windowStartMs: number;
  windowEndMs: number;
  triggeredAtMs: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  cumulativeNotional: number | null;
  cumulativeShares: number | null;
  visibleLevels: number | null;
  sourceTimeMs: number;
  receivedAtMs: number;
  marketStatus: string;
  reasonCodes: string[];
  preparedAction: PrepareOrderActionView;
}

export interface TriggerRow {
  id: string;
  ruleId: string;
  walletAddress: string;
  triggeredAt: string;
  evidence: TriggerEvidenceView;
  reasonCodes: string[];
  status: string;
  orderIntentId: string | null;
  createdAt: string;
}

export interface TriggersResponse {
  triggers: TriggerRow[];
}

export interface TriggerDetailResponse {
  trigger: TriggerRow;
  evidence: TriggerEvidenceView;
  conditionStillHolds: boolean;
  fresh: EvaluateNowResponse;
  preview: {
    tokenId: string;
    conditionId: string;
    side: OrderSide;
    price: string;
    size: string;
    orderType: OrderType;
    maxSpend: string;
    builderCode: string | null;
    signatureType: number;
    timestamp: string;
  };
  warning: string;
}

// The challenge envelope returned by GET /api/auth/challenge.
export interface LoginChallenge {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  typedData: {
    domain: { name: string; version: string; chainId: number };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: { statement: string; nonce: string; issuedAt: string };
  };
}
