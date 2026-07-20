// Frontend response types. These MIRROR the backend's Zod schemas — they are
// intentionally hand-written (not imported) because the backend packages pull
// node-only deps (e.g. `ws`). Sources of truth:
//   - packages/polymarket-client/src/gamma/schema.ts  (GammaEvent, GammaMarket)
//   - packages/polymarket-client/src/data/schema.ts   (Position, Activity)
//   - apps/api/src/routes/*.ts                          (response envelopes)
// Exception: @mx2/rules is pure/browser-safe, so DSL types import directly.
import type { StrategyDefinition } from "@mx2/rules";

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

export type FeedKind = "now" | "top" | "suggestedFavorites";

export interface FeedMeta {
  kind: FeedKind;
  score: number;
  selectedMarketId: string;
  reasons: string[];
  metrics: {
    mid: number;
    spread: number;
    liquidity: number;
    volume24h: number;
    volume1wk: number;
    ageHours: number;
    resolveHours: number;
    competitive: number;
    featured: boolean;
    primaryTag: string | null;
    endDate: string | null;
  };
}

export type RankedGammaEvent = GammaEvent & { _feed: FeedMeta };

export interface FeedColumnResponse {
  kind: FeedKind;
  events: RankedGammaEvent[];
  count: number;
  candidateCount: number;
  rejectedCount: number;
}

export interface HomeFeedResponse {
  generatedAt: string;
  degraded: boolean;
  sourceCount: number;
  candidateCount: number;
  tuning: Record<string, number>;
  feeds: {
    now: FeedColumnResponse;
    top: FeedColumnResponse;
    suggestedFavorites: FeedColumnResponse;
  };
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

/** Token-keyed history (builder projection panel — no Gamma market id needed). */
export interface TokenPricesHistoryResponse {
  tokenId: string;
  history: PricePoint[];
}

// ── Backtested showcases (mirror apps/api/src/lib/showcases.ts) ─────────────

export interface ShowcaseMarket {
  title: string;
  image: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  currentPriceCents: number;
}

export interface Showcase {
  id: string;
  market: ShowcaseMarket;
  sentence: string;
  /** Chat-voice text a user could paste into the AI prompt box. */
  prompt?: string;
  definition: StrategyDefinition;
  stats: {
    stakeUsd: number;
    hypotheticalPnlUsd: number;
    triggerCount: number;
    windowDays: number;
  };
  series: PricePoint[];
  triggers: { t: number; price: number }[];
}

export interface ShowcasesResponse {
  generatedAt: string;
  showcases: Showcase[];
}

export interface FeatureFlags {
  liveTrading: boolean;
  conditionalRules: boolean;
  smartOrdersV2: boolean;
  conditionalLiveExecution: boolean;
  relayer: boolean;
  privySigning: boolean;
  aiChat: boolean;
  openBeta: boolean;
  walletWithdraw: boolean;
  bridgeFunding: boolean;
  bridgeWithdrawals: boolean;
  makerLoop: boolean;
  makerLoopLive: boolean;
  notifications: boolean;
  telegramBot: boolean;
  telegramMiniapp: boolean;
  discordBot: boolean;
}

// ── Notification channels (Telegram/Discord) ─────────────────────────────────

export type NotificationKind =
  | "order_awaiting_signature"
  | "rule_alert"
  | "order_auto_executed"
  | "order_filled"
  | "deposit_completed"
  | "withdrawal_completed";

export interface NotificationChannelItem {
  id: string;
  channel: "telegram" | "discord";
  externalUsername: string | null;
  status: "active" | "revoked";
  /** Per-kind opt-outs; a kind absent from the map is ON. */
  preferences: Partial<Record<NotificationKind, boolean>>;
  createdAt: string;
}

export interface NotificationChannelsResponse {
  channels: NotificationChannelItem[];
  kinds: NotificationKind[];
  telegramEnabled: boolean;
  discordEnabled: boolean;
}

export interface LinkCodeResponse {
  code: string;
  expiresAt: string;
  /** t.me deep link (telegram only). */
  deepLink: string | null;
  /** Project guild invite (discord only). */
  guildInviteUrl: string | null;
}

export interface TradeStatus {
  tradingEnabled: boolean;
  featureFlag: boolean;
  runtimePaused: boolean;
  /** Attribution code embedded in signed orders (public config). */
  builderCode?: string | null;
  geoblock: { status: string; country?: string; error?: string };
}

// ── Market cockpit data panels ───────────────────────────────────────────────

export interface MarketTradeRow {
  side: string;
  price: number;
  size: number;
  /** Unix seconds. */
  timestamp: number;
  outcome: string | null;
  outcomeIndex: number | null;
  name: string | null;
  proxyWallet: string;
  transactionHash: string | null;
}

export interface MarketTradesResponse {
  conditionId: string;
  trades: MarketTradeRow[];
}

export interface MarketHolderRow {
  proxyWallet: string;
  name: string | null;
  amount: number;
  profileImage: string | null;
}

export interface MarketHoldersResponse {
  conditionId: string;
  groups: { tokenId: string; outcome: string | null; holders: MarketHolderRow[] }[];
}

export interface MarketScenario {
  id: string;
  kind: "dip_buy" | "breakout" | "limit_entry" | "trailing_dip" | "rescue_exit" | "farm_rewards";
  label: string;
  sentence: string;
  prompt: string;
  definition: StrategyDefinition;
  entryPriceCents: number;
  stats: {
    stakeUsd: number;
    windowDays: number;
    hypotheticalPnlUsd?: number;
    triggerCount?: number;
    touches?: number;
    rewardsPerDayUsd?: number;
  };
  triggers: { t: number; price: number }[];
  /** Alternate destination (farming cockpit) instead of the builder deep-link. */
  link?: { label: string; href: string };
}

export interface MarketScenariosResponse {
  conditionId: string;
  outcome: string;
  generatedAt: string;
  scenarios: MarketScenario[];
}

export type TradingAccountKind = "external_wallet" | "internal_privy";
export type TradingSigningMode = "browser" | "server" | "unavailable";

export interface TradingAccount {
  id: string;
  kind: TradingAccountKind;
  label: string;
  signerAddress: string;
  funderAddress: string | null;
  signatureType: number;
  signingMode: TradingSigningMode;
  status: string;
  credentialsReady: boolean;
  isPrimary: boolean;
  depositWalletAddress: string | null;
  /** On-chain exchange-allowance check: false = "Authorize trading" needed;
   * null = unprobeable (no RPC on the server). */
  allowancesClean: boolean | null;
  nextAction: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradingAccountsResponse {
  accounts: TradingAccount[];
  primaryAccount: TradingAccount | null;
}

export interface UpsertExternalTradingAccountRequest {
  address: string;
  funderAddress?: string;
  label?: string;
  makePrimary?: boolean;
}

export interface TradingAccountResponse {
  account: TradingAccount;
}

export interface TradingWalletStatusResponse {
  privySigningEnabled: boolean;
  relayerEnabled: boolean;
  provisioned: boolean;
  embeddedAddress: string | null;
  tradingAccountId: string | null;
  tradingAccountStatus: string | null;
  depositWalletAddress: string | null;
  allowancesBootstrapped: boolean;
  delegationActive: boolean;
  delegationExpiresAt: string | null;
  /** Only populated when requested with ?verify=1 (provider round-trip). */
  walletHealth: "ok" | "missing" | "unknown" | null;
}

export interface WalletWithdrawalItem {
  id: string;
  amountUsd: number;
  destination: string;
  state: "requested" | "submitted" | "confirmed" | "failed";
  transactionHash: string | null;
  createdAt: string;
}

export interface WithdrawResponse {
  ok: boolean;
  withdrawalId?: string;
  bridgeWithdrawalId?: string;
  destination?: string;
  toChainId?: string;
  amountUsd?: number;
  alreadySubmitted?: boolean;
  relayer?: { transactionId: string; state: string; transactionHash?: string };
  quote?: {
    minReceived: number | null;
    estOutputUsd: number | null;
    estCheckoutTimeMs?: number | null;
  };
}

/** Cross-chain (bridge) withdrawal — two legs, destination = login wallet. */
export interface BridgeWithdrawalItem {
  id: string;
  amountUsd: number;
  destination: string;
  toChainId: string;
  state:
    | "requested"
    | "address_created"
    | "polygon_submitted"
    | "polygon_confirmed"
    | "bridging"
    | "completed"
    | "failed_address"
    | "failed_polygon"
    | "failed_bridge";
  polygonTxHash: string | null;
  bridgeTxHash: string | null;
  createdAt: string;
}

export interface FundsAsset {
  id: string;
  chainId: string;
  chainName: string;
  addressType: "evm" | "svm" | "btc" | "tvm";
  minCheckoutUsd: number;
  token: {
    name: string;
    symbol: string;
    address: string;
    decimals: number;
  };
}

export interface FundsChain {
  chainId: string;
  chainName: string;
  addressType: "evm" | "svm" | "btc" | "tvm";
  assetCount: number;
  minCheckoutUsd: number;
}

export interface FundsAssetsResponse {
  enabled: boolean;
  assets: FundsAsset[];
  chains: FundsChain[];
  note?: string | null;
}

export interface FundsDepositAddressesResponse {
  ok: boolean;
  depositWalletAddress: string;
  addresses: Partial<Record<FundsAsset["addressType"], string>>;
}

/** GET /api/funds/deposit-addresses — previously generated addresses (may be empty). */
export interface FundsSavedAddressesResponse {
  ok: boolean;
  depositWalletAddress: string | null;
  addresses: Partial<Record<FundsAsset["addressType"], string>>;
}

/** POST /api/funds/quote — deposit-direction fee/ETA estimate. */
export interface FundsQuoteResponse {
  quoteId: string | null;
  estCheckoutTimeMs: number | null;
  estToTokenBaseUnit: string | null;
  estInputUsd: number | null;
  estOutputUsd: number | null;
  fees: {
    appFeeLabel: string | null;
    appFeeUsd: number | null;
    gasUsd: number | null;
    totalImpactUsd: number | null;
    minReceived: number | null;
  };
}

/** GET /api/funds/deposits — tracked bridge deposit transfers. */
export interface BridgeDepositItem {
  id: string;
  fromChainId: string;
  fromTokenAddress: string;
  fromAmountBaseUnit: string;
  state:
    | "detected"
    | "processing"
    | "origin_confirmed"
    | "submitted"
    | "completed"
    | "failed"
    | "superseded"
    | "expired";
  providerStatus: string;
  txHash: string | null;
  /** User pressed Dismiss — hidden from active surfaces, kept in history. */
  dismissedAt: string | null;
  /** "provider" (normal) or "chain_reconciled" (funds observed on-chain). */
  completionSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradingWalletBalanceResponse {
  depositWalletAddress: string | null;
  /** pUSD — the spendable/withdrawable Polymarket balance (1:1 USD). */
  depositWalletUsdc: number | null;
  /** Raw USDC.e in the deposit wallet awaiting conversion to pUSD. */
  depositWalletUnconvertedUsdc: number | null;
  embeddedAddress: string;
  embeddedUsdc: number;
  asOf: string;
}

export interface TradingWalletReissueResponse {
  ok: boolean;
  reissued: boolean;
  created: boolean;
  tradingAccountId: string;
  embeddedAddress: string;
  depositWalletAddress: string | null;
  walletHealth: "ok" | "unknown";
}

export interface TradingWalletProvisionResponse {
  ok: boolean;
  tradingAccountId: string;
  embeddedAddress: string;
  depositWalletAddress: string | null;
  allowancesBootstrapped?: boolean;
  alreadyProvisioned: boolean;
  fundingInstructions?: string;
}

export interface TradingWalletActivationResponse {
  ok: boolean;
  tradingAccountId: string;
  embeddedAddress: string;
  depositWalletAddress: string;
  status: string;
  relayer: {
    submitted: boolean;
    deployed: boolean;
    state?: string;
    transactionId?: string;
    transactionHash?: string;
  };
  nextAction: string;
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

export interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  timestamp: number;
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

export type MarketPnlStatus =
  | "OPEN_PROFIT"
  | "OPEN_LOSS"
  | "WON"
  | "LOST"
  | "SOLD_PROFIT"
  | "SOLD_LOSS"
  | "FLAT";

export interface MarketPnlItem {
  id: string;
  source: "positions" | "closed-positions";
  conditionId: string;
  asset: string;
  title?: string;
  slug?: string;
  icon?: string;
  outcome?: string;
  status: MarketPnlStatus;
  statusLabel: string;
  pnl: number;
  pnlPct: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  currentValue: number;
  exposure: number;
  totalBought: number;
  avgPrice: number;
  curPrice?: number;
  size: number | null;
  closed: boolean;
  lastActivityAt: number | null;
}

export interface PortfolioProfile {
  name?: string;
  profileImage: string | null;
  proxyWallet: string;
  xUsername: string | null;
  verifiedBadge: boolean;
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
  profile: PortfolioProfile | null;
  fetchedAt: string;
  dataSource: string;
  summary: PnlSummary;
  positions: Position[];
  closedPositions: ClosedPosition[];
  marketPnl: MarketPnlItem[];
  activityPreview: Activity[];
  counts: {
    openOrders: number;
    usdcBalance: string | null;
    setupRequired: boolean;
    marketPnl: number;
  };
  methodology: string;
  limitations: string[];
}

export type EquityWindow = "7d" | "30d" | "all";

export interface EquityPoint {
  t: number;
  pnl: number;
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
  positionValue?: string;
  dataApiPositionValue?: string | null;
  exposure?: string;
  cashBalance?: string | null;
  cashBalanceKnown?: boolean;
  openPositions: number;
  sources?: {
    totalPnl: string;
    unrealizedPnl: string;
    realizedPnl: string;
    exposure: string;
    cashBalance: string;
  };
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
export type OrderType = "GTC" | "GTD" | "FOK" | "FAK";

/** Client-side validated order input (lib/orders.ts). No preview round-trip —
 * the ticket signs and submits directly; the server re-validates everything. */
export interface OrderPreviewRequest {
  tradingAccountId?: string;
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  price: string;
  size: string;
  orderType: OrderType;
  funder: string;
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
  tradingAccountId?: string;
  l1Signature: string;
  timestamp: string;
  nonce: string;
}

export interface SetupCredentialsResponse {
  ok: boolean;
  apiKey: string;
  tradingAccountId: string;
}

/** Per-market fees + liquidity-rewards config (GET /api/markets/:id/economics). */
export interface MarketEconomicsResponse {
  feeSchedule: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number | null;
  } | null;
  rewards: {
    minSize: number | null;
    maxSpread: number | null;
    ratePerDayUsd: number | null;
    totalRewards: number | null;
    startDate: string | null;
    endDate: string | null;
  } | null;
  fetchedAt: string;
}

export interface SubmitOrderRequest {
  tradingAccountId?: string;
  idempotencyKey: string;
  conditionId: string;
  price: string;
  size: string;
  orderType: OrderType;
  /** Maker-only: the CLOB rejects instead of crossing (GTC/GTD only). */
  postOnly?: boolean;
  order?: SignedClobOrder;
}

export interface SubmitOrderResponse {
  intentId: string;
  clobOrderId: string | null;
  status: string;
  tradingAccountId?: string;
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
    postOnly: boolean;
    /** GTD wire expiration (unix seconds, +60s early-expiry compensation), else null. */
    expiration: string | null;
    maxSpend: string;
    builderCode: string | null;
    signatureType: number;
    timestamp: string;
  };
  /** Primary trading-account signing context (for the mobile sign page,
   * whose restricted session cannot call /api/trading-accounts). */
  account: {
    id: string;
    label: string;
    signerAddress: string;
    funderAddress: string | null;
    signingMode: "browser" | "server";
    credentialsReady: boolean;
  } | null;
  tradingEnabled: boolean;
  warning: string;
}

export interface SignLinkExchangeResponse {
  ok: boolean;
  triggerId: string;
  walletAddress: string;
  expiresAt: string;
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
