import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import type { AppConfig } from "@mx2/config";
import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  MarketSnapshotStore,
  ChallengeStore,
  UserStore,
  SessionStore,
  AllowlistStore,
  ClobCredentialStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
  OrderIntentStore,
  RuntimeFlagStore,
  QuoterStore,
  RuleStore,
  TriggerStore,
  PrivyWalletStore,
  DelegationStore,
  WithdrawalStore,
  BridgeStore,
  DraftStore,
  NotificationChannelStore,
  LinkCodeStore,
  SignLinkTokenStore,
} from "@mx2/db";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  AuthenticatedClobClient,
  GeoblockClient,
  DepositWalletRelayer,
  BridgeClient,
} from "@mx2/polymarket-client";
import { createBridgeClient, createDisabledDepositWalletRelayer } from "@mx2/polymarket-client";
import type { TradingSigner } from "@mx2/trading-signer";
import { createViemAllowanceReader, type AllowanceReader } from "./trade/allowance-bootstrap.js";
import type { DiscordOauthClient } from "./lib/discord-oauth.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerFeedRoutes } from "./routes/feed.js";
import { registerMarketsRoutes } from "./routes/markets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerFundsRoutes } from "./routes/funds.js";
import { registerDraftsRoutes } from "./routes/drafts.js";
import { registerTradeRoutes } from "./routes/trade.js";
import { registerTradingWalletRoutes } from "./routes/trading-wallet.js";
import { registerTradingAccountsRoutes } from "./routes/trading-accounts.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerRulesRoutes } from "./routes/rules.js";
import { registerSmartOrdersRoutes } from "./routes/smart-orders.js";
import { registerShowcasesRoutes } from "./routes/showcases.js";
import { registerNotificationsRoutes } from "./routes/notifications.js";
import { registerQuoterRoutes } from "./routes/quoter.js";
import { registerAiRoutes } from "./routes/ai.js";
import type { AiClient } from "./ai/client.js";
import type {} from "./auth/types.js";

/** Minimal surface the app needs from the database (keeps tests light). */
export interface DbProbe {
  ping(): Promise<boolean>;
}

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: DbProbe;
  auditStore: AuditStore;
  marketSnapshots: MarketSnapshotStore;
  challenges: ChallengeStore;
  users: UserStore;
  sessions: SessionStore;
  allowlist: AllowlistStore;
  clobCredentials: ClobCredentialStore;
  tradingAccounts?: TradingAccountStore;
  accountClobCredentials?: TradingAccountClobCredentialStore;
  orderIntents: OrderIntentStore;
  runtimeFlags: RuntimeFlagStore;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  /** Maker-loop session store; omitted only in tests that never touch quoter routes. */
  quoterStore?: QuoterStore;
  privyWallets: PrivyWalletStore;
  delegations: DelegationStore;
  /** Withdrawal ledger; omitted only in tests that never touch withdraw routes. */
  withdrawals?: WithdrawalStore;
  /** Bridge address/deposit ledger; omitted only in tests that never touch funds routes. */
  bridgeStore?: BridgeStore;
  /** Server-synced builder drafts; omitted only in tests that never touch draft routes. */
  draftStore?: DraftStore;
  /** Notification channel links; omitted only in tests that never touch notification routes. */
  notificationChannels?: NotificationChannelStore;
  /** Channel link codes; omitted only in tests that never touch notification routes. */
  linkCodes?: LinkCodeStore;
  /** Sign-link tokens; enables the scoped sign-link exchange when present. */
  signTokens?: SignLinkTokenStore;
  /** Discord OAuth linking client (FEATURE_DISCORD_BOT). */
  discordOauth?: DiscordOauthClient;
  gammaClient: GammaClient;
  clobClient: ClobClient;
  dataClient: DataClient;
  tradingClobClient: AuthenticatedClobClient;
  tradingSigner: TradingSigner;
  depositWalletRelayer?: DepositWalletRelayer;
  geoblockClient: GeoblockClient;
  bridgeClient?: BridgeClient;
  /** Optional: injected in tests; otherwise built from POLYGON_RPC_URL. */
  allowanceReader?: AllowanceReader | null;
  /** Null/omitted when FEATURE_AI_CHAT is off — the AI route then 503s. */
  aiClient?: AiClient | null;
}

/**
 * Builds the Fastify app with dependencies injected so it can be tested via
 * `app.inject(...)` without opening a socket or a real database connection.
 */
export const buildApp = (deps: AppDeps) => {
  const app = Fastify({ loggerInstance: deps.logger, disableRequestLogging: false });
  const tradingAccounts =
    deps.tradingAccounts ??
    ({
      listByOwner: async () => [],
      findByOwner: async () => null,
      getPrimary: async () => null,
      setPrimary: async () => null,
      upsertExternal: async () => {
        throw new Error("trading account store not configured");
      },
      upsertInternalPrivy: async () => {
        throw new Error("trading account store not configured");
      },
      markReady: async () => {},
      updateStatus: async () => {},
      archive: async () => null,
    } satisfies TradingAccountStore);
  const accountClobCredentials =
    deps.accountClobCredentials ??
    ({
      upsert: async () => {
        throw new Error("account CLOB credential store not configured");
      },
      find: async () => null,
      delete: async () => {},
    } satisfies TradingAccountClobCredentialStore);
  const depositWalletRelayer = deps.depositWalletRelayer ?? createDisabledDepositWalletRelayer();
  const bridgeClient =
    deps.bridgeClient ??
    createBridgeClient({
      baseUrl: deps.config.polymarket.bridgeBaseUrl,
      builderCode: deps.config.polymarket.builderCode,
    });

  // Expose req.user on every request (null until auth middleware sets it).
  app.decorateRequest("user", null);
  // Session restriction marker (null = full session; see auth/types.ts).
  app.decorateRequest("authScope", null);

  // CORS: in development allow any localhost origin (needed for the test HTML page).
  // In staging/production allow exactly the configured frontend origin (APP_BASE_URL).
  // Same-domain deploys (web + /api behind one reverse proxy) are same-origin and need
  // no CORS; this also supports a split deploy (web on a different host) with credentials.
  void app.register(fastifyCors, {
    origin:
      deps.config.env === "development"
        ? (origin, cb) => cb(null, origin ?? true)
        : [deps.config.baseUrl],
    credentials: true,
    // PATCH (strategy tags) and PUT (draft sync) joined in the organization/
    // drafts slices — split deploys break without them.
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Cookie support — required before any route that reads/sets the session cookie.
  void app.register(fastifyCookie);

  // Liveness: the process is up and serving. Must not depend on downstreams.
  app.get("/healthz", async () => ({
    status: "ok",
    env: deps.config.env,
    ts: new Date().toISOString(),
  }));

  // Readiness: safe to receive traffic. Checks critical downstreams (DB).
  app.get("/readyz", async (_req, reply) => {
    const dbUp = await deps.db.ping();
    const ready = dbUp;
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      checks: { db: dbUp ? "up" : "down" },
    };
  });

  // Expose non-sensitive feature flag state for the frontend / diagnostics.
  app.get("/api/feature-flags", async () => deps.config.features);

  // Cast needed because our pino Logger is more specific than FastifyBaseLogger.
  const fastifyApp = app as unknown as FastifyInstance;

  registerEventsRoutes(fastifyApp, { gammaClient: deps.gammaClient });
  registerFeedRoutes(fastifyApp, { gammaClient: deps.gammaClient });
  registerMarketsRoutes(fastifyApp, {
    gammaClient: deps.gammaClient,
    clobClient: deps.clobClient,
    dataClient: deps.dataClient,
    marketSnapshots: deps.marketSnapshots,
    makerLoopEnabled: deps.config.features.makerLoop,
  });
  registerAuthRoutes(fastifyApp, {
    config: deps.config,
    challenges: deps.challenges,
    users: deps.users,
    sessions: deps.sessions,
    allowlist: deps.allowlist,
    auditStore: deps.auditStore,
    tradingSigner: deps.tradingSigner,
    privyWallets: deps.privyWallets,
    tradingAccounts,
    ...(deps.signTokens ? { signTokens: deps.signTokens } : {}),
    ...(deps.notificationChannels ? { notificationChannels: deps.notificationChannels } : {}),
  });
  registerProfileRoutes(fastifyApp, {
    dataClient: deps.dataClient,
    sessions: deps.sessions,
    clobCredentials: deps.clobCredentials,
    tradingClobClient: deps.tradingClobClient,
    config: deps.config,
    gammaClient: deps.gammaClient,
  });
  const bridgeStore =
    deps.bridgeStore ??
    ({
      saveAddress: async () => {
        throw new Error("bridgeStore not wired");
      },
      listAddresses: async () => [],
      listPollableAddresses: async () => [],
      listActivePollableAddresses: async () => [],
      markAddressChecked: async () => {},
      upsertDepositsFromStatus: async () => ({ changed: [] }),
      listDepositsByWallet: async () => [],
      dismissDeposit: async () => null,
      listNonTerminalDeposits: async () => [],
      expireStaleDeposits: async () => [],
      completeDepositFromChain: async () => null,
      createWithdrawal: async () => null,
      findWithdrawalByIdempotencyKey: async () => null,
      listWithdrawalsByWallet: async () => [],
      updateWithdrawalState: async () => null,
      updateWithdrawalsFromStatus: async () => ({ changed: [] }),
      advanceWithdrawalState: async () => null,
      listWithdrawalsByStates: async () => [],
    } satisfies BridgeStore);
  registerFundsRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    tradingAccounts,
    privyWallets: deps.privyWallets,
    bridgeClient,
    bridgeStore,
    geoblockClient: deps.geoblockClient,
  });
  if (deps.draftStore) {
    registerDraftsRoutes(fastifyApp, {
      config: deps.config,
      sessions: deps.sessions,
      draftStore: deps.draftStore,
    });
  }
  if (deps.notificationChannels && deps.linkCodes) {
    registerNotificationsRoutes(fastifyApp, {
      config: deps.config,
      sessions: deps.sessions,
      auditStore: deps.auditStore,
      notificationChannels: deps.notificationChannels,
      linkCodes: deps.linkCodes,
      ...(deps.discordOauth ? { discordOauth: deps.discordOauth } : {}),
    });
  }
  registerTradeRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    tradingAccounts,
    accountClobCredentials,
    orderIntents: deps.orderIntents,
    runtimeFlags: deps.runtimeFlags,
    tradingClobClient: deps.tradingClobClient,
    geoblockClient: deps.geoblockClient,
    tradingSigner: deps.tradingSigner,
    triggerStore: deps.triggerStore,
  });
  const allowanceReader =
    deps.allowanceReader ??
    (deps.config.polygonRpcUrl ? createViemAllowanceReader(deps.config.polygonRpcUrl) : null);
  const withdrawals =
    deps.withdrawals ??
    ({
      create: async () => null,
      updateState: async () => {},
      findByIdempotencyKey: async () => null,
      listByWallet: async () => [],
    } satisfies WithdrawalStore);
  registerTradingWalletRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    tradingSigner: deps.tradingSigner,
    privyWallets: deps.privyWallets,
    tradingAccounts,
    delegations: deps.delegations,
    allowanceReader,
    depositWalletRelayer,
    withdrawals,
    bridgeClient,
    bridgeStore,
    geoblockClient: deps.geoblockClient,
  });
  registerTradingAccountsRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    tradingAccounts,
    accountClobCredentials,
    allowanceReader,
  });
  registerAdminRoutes(fastifyApp, {
    config: deps.config,
    auditStore: deps.auditStore,
    runtimeFlags: deps.runtimeFlags,
  });
  registerRulesRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    ruleStore: deps.ruleStore,
    triggerStore: deps.triggerStore,
    orderIntents: deps.orderIntents,
    marketSnapshots: deps.marketSnapshots,
    tradingAccounts,
    accountClobCredentials,
  });
  registerSmartOrdersRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    ruleStore: deps.ruleStore,
    triggerStore: deps.triggerStore,
    orderIntents: deps.orderIntents,
    runtimeFlags: deps.runtimeFlags,
    marketSnapshots: deps.marketSnapshots,
    gammaClient: deps.gammaClient,
    clobClient: deps.clobClient,
    ...(deps.privyWallets ? { privyWallets: deps.privyWallets } : {}),
    ...(deps.delegations ? { delegations: deps.delegations } : {}),
  });
  registerShowcasesRoutes(fastifyApp, {
    gammaClient: deps.gammaClient,
    clobClient: deps.clobClient,
  });
  if (deps.quoterStore) {
    registerQuoterRoutes(fastifyApp, {
      config: deps.config,
      sessions: deps.sessions,
      ruleStore: deps.ruleStore,
      quoterStore: deps.quoterStore,
      auditStore: deps.auditStore,
      gammaClient: deps.gammaClient,
      clobClient: deps.clobClient,
      geoblockClient: deps.geoblockClient,
      privyWallets: deps.privyWallets,
      tradingAccounts,
      accountClobCredentials,
      allowanceReader,
      relayerEnabled: deps.config.features.relayer && depositWalletRelayer.enabled,
    });
  }
  registerAiRoutes(fastifyApp, {
    config: deps.config,
    auditStore: deps.auditStore,
    gammaClient: deps.gammaClient,
    aiClient: deps.aiClient ?? null,
  });

  return app;
};
