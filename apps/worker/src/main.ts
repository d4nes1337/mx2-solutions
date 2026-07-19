import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import {
  createDb,
  createMarketSnapshotStore,
  createAuditStore,
  createBridgeStore,
  createRuleStore,
  createTriggerStore,
  createPrivyWalletStore,
  createDelegationStore,
  createRuntimeFlagStore,
  createOrderIntentStore,
  createClobCredentialStore,
  createTradingAccountStore,
  createTradingAccountClobCredentialStore,
  createNotificationChannelStore,
  createNotificationOutboxStore,
  createLinkCodeStore,
  createSignLinkTokenStore,
  type NotificationOutboxStore,
} from "@mx2/db";
import {
  createAuthenticatedClobClient,
  createBridgeClient,
  createClobClient,
  createConfiguredDepositWalletRelayer,
  createPusdBalanceReader,
} from "@mx2/polymarket-client";
import { createConfiguredTradingSigner } from "@mx2/trading-signer";
import { createBridgePoller, type BridgePoller } from "./bridge-poller.js";
import { createMarketFeedManager, orderbookToView, type MarketFeedManager } from "./market-feed.js";
import { createOrderSyncLoop, type OrderSyncLoop } from "./order-sync.js";
import { createRuleEvaluatorManager, type RuleEvaluatorManager } from "./rule-evaluator.js";
import { createAutoExecutor, type AutoExecutor } from "./auto-executor.js";
import { createQuoterManager, type QuoterManager } from "./quoter/manager.js";
import { createLiveCapableProvider } from "./quoter/executor-provider.js";
import { createRewardsPoller, type RewardsPoller } from "./quoter/rewards-poller.js";
import { createQuoterStore } from "@mx2/db";
import { createTelegramApi } from "./telegram/api.js";
import { createDiscordApi } from "./discord/api.js";
import { createTelegramBot, type TelegramBot } from "./telegram-bot.js";
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from "./notification-dispatcher.js";

/**
 * Long-running worker process. Hosts the Polymarket WebSocket ingestion and the
 * conditional-rule evaluator (single-writer per rule → deterministic, audited
 * state transitions). A trigger never auto-submits an order; it records evidence
 * and awaits manual confirmation via the API.
 */
const HEARTBEAT_MS = 30_000;

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger({
    name: "worker",
    level: config.logLevel,
    pretty: config.env === "development",
  });

  const dbHandle = createDb(config.databaseUrl);
  const dbUp = await dbHandle.ping();
  logger.info(
    { dbUp, env: config.env, conditionalRules: config.features.conditionalRules },
    "Worker started",
  );

  const marketSnapshots = createMarketSnapshotStore(dbHandle.db);

  // Notification outbox — producers (evaluator, auto-executor, order-sync,
  // bridge poller) enqueue; the dispatcher below delivers. Absent when the
  // master flag is off: nothing is ever enqueued.
  const outbox: NotificationOutboxStore | undefined = config.features.notifications
    ? createNotificationOutboxStore(dbHandle.db)
    : undefined;

  // The evaluator drives WS subscriptions for the tokens its rules watch, while
  // the feed pushes normalized book/reconnect/tick-size events back to it. They
  // reference each other, so the feed is held behind a const ref the evaluator's
  // subscribe/unsubscribe thunks read after wiring is complete.
  const feedRef: { current: MarketFeedManager | null } = { current: null };
  let evaluator: RuleEvaluatorManager | null = null;

  if (config.features.conditionalRules) {
    const ruleStore = createRuleStore(dbHandle.db);
    const triggerStore = createTriggerStore(dbHandle.db);
    const auditStore = createAuditStore(dbHandle.db);

    // Auto-execution is wired ONLY when explicitly enabled (config validation
    // requires Privy signing + live trading for this flag). Absent → manual-only.
    let autoExecutor: AutoExecutor | undefined;
    if (config.features.conditionalLiveExecution) {
      const privyCreds =
        config.privy.appId && config.privy.appSecret && config.privy.authorizationKey
          ? {
              appId: config.privy.appId,
              appSecret: config.privy.appSecret,
              authorizationPrivateKey: config.privy.authorizationKey,
              keyQuorumId: config.privy.keyQuorumId,
              tradingPolicyId: config.privy.tradingPolicyId,
              rpcUrl: config.polygonRpcUrl,
            }
          : undefined;
      autoExecutor = createAutoExecutor({
        logger,
        config,
        tradingSigner: createConfiguredTradingSigner({
          enabled: config.features.privySigning,
          isProduction: config.env === "production",
          mockSignerPrivateKey: config.mockSignerPrivateKey,
          privy: privyCreds,
        }),
        privyWallets: createPrivyWalletStore(dbHandle.db),
        delegations: createDelegationStore(dbHandle.db),
        runtimeFlags: createRuntimeFlagStore(dbHandle.db),
        orderIntents: createOrderIntentStore(dbHandle.db),
        clobCredentials: createClobCredentialStore(dbHandle.db),
        tradingAccounts: createTradingAccountStore(dbHandle.db),
        accountClobCredentials: createTradingAccountClobCredentialStore(dbHandle.db),
        tradingClobClient: createAuthenticatedClobClient({
          baseUrl: config.polymarket.clobBaseUrl,
        }),
        ruleStore,
        triggerStore,
        auditStore,
        // Balance pre-check (W6/W4): the deposit wallet's pUSD — its actual
        // spendable balance (INTEGRATION §23) — raw 6-decimal units → USD.
        balanceOfUsdc: config.polygonRpcUrl
          ? (() => {
              const readBalance = createPusdBalanceReader(config.polygonRpcUrl);
              return async (owner: string) => Number(await readBalance(owner)) / 1e6;
            })()
          : null,
        ...(outbox ? { outbox } : {}),
      });
      logger.warn(
        "FEATURE_CONDITIONAL_LIVE_EXECUTION is ON — auto rules will submit real orders unattended",
      );
    }

    // Background freshness verification (public CLOB REST): quiet-but-live
    // markets legitimately send no WS traffic, so the evaluator re-fetches
    // aging books instead of resetting hold windows as "stale". Gated on the
    // WS transport being connected — a real disconnect still fails closed.
    const publicClobClient = createClobClient({ baseUrl: config.polymarket.clobBaseUrl });
    evaluator = createRuleEvaluatorManager({
      logger,
      ruleStore,
      triggerStore,
      auditStore,
      subscribe: (tokenIds) => feedRef.current?.subscribe(tokenIds),
      unsubscribe: (tokenIds) => feedRef.current?.unsubscribe(tokenIds),
      fetchOrderbook: async (tokenId) => {
        const ob = await publicClobClient.getOrderbook(tokenId);
        return ob.ok ? orderbookToView(ob.value, Date.now()) : null;
      },
      isFeedConnected: () => feedRef.current?.state() === "connected",
      ...(autoExecutor ? { autoExecutor } : {}),
      ...(outbox ? { outbox } : {}),
    });
  } else {
    logger.warn("FEATURE_CONDITIONAL_RULES is off — rule evaluator disabled");
  }

  // Maker-loop quoter (RFC-0003). The executor is resolved PER CYCLE from the
  // session's mode: shadow sessions always run; confirm/live sessions resolve
  // the real executor only when FEATURE_MAKER_LOOP_LIVE plus every W2–W4
  // prerequisite (signer, deposit wallet, CLOB creds, verified adapters,
  // relayer) is present — anything missing halts the session visibly.
  let quoter: QuoterManager | null = null;
  let rewardsPoller: RewardsPoller | null = null;
  if (config.features.makerLoop && config.features.conditionalRules) {
    const quoterStore = createQuoterStore(dbHandle.db);
    const quoterRuleStore = createRuleStore(dbHandle.db);
    const quoterSigner = createConfiguredTradingSigner({
      enabled: config.features.privySigning,
      isProduction: config.env === "production",
      mockSignerPrivateKey: config.mockSignerPrivateKey,
      privy:
        config.privy.appId && config.privy.appSecret && config.privy.authorizationKey
          ? {
              appId: config.privy.appId,
              appSecret: config.privy.appSecret,
              authorizationPrivateKey: config.privy.authorizationKey,
              keyQuorumId: config.privy.keyQuorumId,
              tradingPolicyId: config.privy.tradingPolicyId,
              rpcUrl: config.polygonRpcUrl,
            }
          : undefined,
    });
    const quoterSharedDeps = {
      config,
      tradingSigner: quoterSigner,
      privyWallets: createPrivyWalletStore(dbHandle.db),
      tradingAccounts: createTradingAccountStore(dbHandle.db),
      accountClobCredentials: createTradingAccountClobCredentialStore(dbHandle.db),
    };
    quoter = createQuoterManager({
      logger,
      ruleStore: quoterRuleStore,
      quoterStore,
      auditStore: createAuditStore(dbHandle.db),
      runtimeFlags: createRuntimeFlagStore(dbHandle.db),
      executorProvider: createLiveCapableProvider({
        ...quoterSharedDeps,
        depositWalletRelayer: createConfiguredDepositWalletRelayer({
          enabled: config.features.relayer,
          relayerUrl: config.polymarket.relayer.url,
          builderApiKey: config.polymarket.relayer.builderApiKey,
          builderSecret: config.polymarket.relayer.builderSecret,
          builderPassphrase: config.polymarket.relayer.builderPassphrase,
          chainId: config.polymarket.chainId,
          polygonRpcUrl: config.polygonRpcUrl,
          signTypedData: async (owner, typedData) => {
            if (!owner.ownerWalletId) {
              throw new Error("Deposit-wallet relayer requires a provisioned Privy wallet id.");
            }
            const signed = await quoterSigner.signOrder({
              wallet: { walletId: owner.ownerWalletId, address: owner.ownerAddress },
              typedData,
            });
            if (!signed.ok) throw new Error(signed.error.message);
            return signed.value.signature;
          },
        }),
        tradingClobClient: createAuthenticatedClobClient({
          baseUrl: config.polymarket.clobBaseUrl,
        }),
      }),
      subscribe: (tokenIds) => feedRef.current?.subscribe(tokenIds),
      unsubscribe: (tokenIds) => feedRef.current?.unsubscribe(tokenIds),
    });
    rewardsPoller = createRewardsPoller({
      logger,
      ...quoterSharedDeps,
      quoterStore,
      ruleStore: quoterRuleStore,
    });
    logger.info(
      { liveCapable: config.features.makerLoopLive },
      "FEATURE_MAKER_LOOP is ON — quoter running (shadow by default; mode per session)",
    );
  }

  const marketFeed = createMarketFeedManager({
    wsUrl: config.polymarket.marketWsUrl,
    logger,
    marketSnapshots,
    ...(evaluator || quoter
      ? {
          onBookView: (view) => {
            evaluator?.onBook(view);
            quoter?.onBook(view);
          },
          onReconnect: () => {
            evaluator?.onReconnect();
            quoter?.onReconnect();
          },
          onTickSizeChange: (tokenId) => evaluator?.onTickSizeChange(tokenId),
          onPrice: (tokenId, price, tMs) => evaluator?.onPrice(tokenId, price, tMs),
          onBookDelta: (tokenId, deltas, tMs) => evaluator?.onBookDelta(tokenId, deltas, tMs),
          onHeartbeat: (tokenId, tMs) => evaluator?.onHeartbeat(tokenId, tMs),
        }
      : {}),
  });
  feedRef.current = marketFeed;

  // Order fill reconciliation — read-only against the CLOB (no orders placed,
  // modified, or cancelled), so no trading feature flag gates it; it only
  // needs the encryption master key to read per-account CLOB credentials.
  let orderSync: OrderSyncLoop | null = null;
  if (config.encryptionMasterKey) {
    orderSync = createOrderSyncLoop({
      logger,
      encryptionMasterKey: config.encryptionMasterKey,
      orderIntents: createOrderIntentStore(dbHandle.db),
      tradingAccounts: createTradingAccountStore(dbHandle.db),
      accountClobCredentials: createTradingAccountClobCredentialStore(dbHandle.db),
      tradingClobClient: createAuthenticatedClobClient({
        baseUrl: config.polymarket.clobBaseUrl,
      }),
      auditStore: createAuditStore(dbHandle.db),
      ...(outbox ? { outbox } : {}),
    });
  } else {
    logger.warn("No encryption master key — order fill sync disabled");
  }

  // Bridge status polling (deposits + withdrawal legs) — read-only against
  // the Bridge, so it needs no signing/relayer prerequisites. When bridge
  // withdrawals are on (config already requires the relayer stack for that
  // flag), the poller additionally polls the relayer for Polygon-leg
  // confirmations — reads only, but the SDK factory needs the signer bridge.
  let bridgePoller: BridgePoller | null = null;
  if (config.features.bridgeFunding || config.features.bridgeWithdrawals) {
    let withdrawalLegDeps = {};
    if (config.features.bridgeWithdrawals) {
      const pollerSigner = createConfiguredTradingSigner({
        enabled: config.features.privySigning,
        isProduction: config.env === "production",
        mockSignerPrivateKey: config.mockSignerPrivateKey,
        privy:
          config.privy.appId && config.privy.appSecret && config.privy.authorizationKey
            ? {
                appId: config.privy.appId,
                appSecret: config.privy.appSecret,
                authorizationPrivateKey: config.privy.authorizationKey,
                keyQuorumId: config.privy.keyQuorumId,
                tradingPolicyId: config.privy.tradingPolicyId,
                rpcUrl: config.polygonRpcUrl,
              }
            : undefined,
      });
      withdrawalLegDeps = {
        privyWallets: createPrivyWalletStore(dbHandle.db),
        depositWalletRelayer: createConfiguredDepositWalletRelayer({
          enabled: config.features.relayer,
          relayerUrl: config.polymarket.relayer.url,
          builderApiKey: config.polymarket.relayer.builderApiKey,
          builderSecret: config.polymarket.relayer.builderSecret,
          builderPassphrase: config.polymarket.relayer.builderPassphrase,
          chainId: config.polymarket.chainId,
          polygonRpcUrl: config.polygonRpcUrl,
          signTypedData: async (owner, typedData) => {
            if (!owner.ownerWalletId) {
              throw new Error("Deposit-wallet relayer requires a provisioned Privy wallet id.");
            }
            const signed = await pollerSigner.signOrder({
              wallet: { walletId: owner.ownerWalletId, address: owner.ownerAddress },
              typedData,
            });
            if (!signed.ok) throw new Error(signed.error.message);
            return signed.value.signature;
          },
        }),
      };
    }
    bridgePoller = createBridgePoller({
      logger,
      bridgeStore: createBridgeStore(dbHandle.db),
      bridgeClient: createBridgeClient({
        baseUrl: config.polymarket.bridgeBaseUrl,
        builderCode: config.polymarket.builderCode,
      }),
      auditStore: createAuditStore(dbHandle.db),
      ...withdrawalLegDeps,
      ...(outbox ? { outbox } : {}),
    });
  }

  // External delivery: Telegram inbound bot loop + the channel-agnostic
  // dispatcher (Telegram messages, Discord DMs). Config load already
  // fail-closed each flag without its credentials — assertions just narrow.
  let telegramBot: TelegramBot | null = null;
  let notificationDispatcher: NotificationDispatcher | null = null;
  if (outbox && (config.features.telegramBot || config.features.discordBot)) {
    const channels = createNotificationChannelStore(dbHandle.db);
    const signTokens = createSignLinkTokenStore(dbHandle.db);
    const notifAudit = createAuditStore(dbHandle.db);

    let telegramApi: ReturnType<typeof createTelegramApi> | undefined;
    if (config.features.telegramBot) {
      const botToken = config.notifications.telegramBotToken;
      if (!botToken) throw new Error("FEATURE_TELEGRAM_BOT requires TELEGRAM_BOT_TOKEN");
      telegramApi = createTelegramApi({ botToken });
      telegramBot = createTelegramBot({
        logger,
        api: telegramApi,
        channels,
        linkCodes: createLinkCodeStore(dbHandle.db),
        triggerStore: createTriggerStore(dbHandle.db),
        signTokens,
        auditStore: notifAudit,
        appBaseUrl: config.baseUrl,
        miniapp: config.features.telegramMiniapp,
      });
      logger.info("FEATURE_TELEGRAM_BOT is ON — bot long-poll enabled");
    }

    const discordApi =
      config.features.discordBot && config.notifications.discordBotToken
        ? createDiscordApi({ botToken: config.notifications.discordBotToken })
        : undefined;
    if (discordApi) logger.info("FEATURE_DISCORD_BOT is ON — DM delivery enabled");

    notificationDispatcher = createNotificationDispatcher({
      logger,
      ...(telegramApi ? { api: telegramApi } : {}),
      ...(discordApi ? { discordApi } : {}),
      outbox,
      channels,
      signTokens,
      auditStore: notifAudit,
      appBaseUrl: config.baseUrl,
      miniapp: config.features.telegramMiniapp,
    });
  }

  evaluator?.start();
  quoter?.start();
  rewardsPoller?.start();
  orderSync?.start();
  bridgePoller?.start();
  telegramBot?.start();
  notificationDispatcher?.start();

  const heartbeat = setInterval(() => {
    logger.debug("worker heartbeat");
  }, HEARTBEAT_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Worker shutting down");
    clearInterval(heartbeat);
    evaluator?.stop();
    quoter?.stop();
    rewardsPoller?.stop();
    orderSync?.stop();
    bridgePoller?.stop();
    telegramBot?.stop();
    notificationDispatcher?.stop();
    marketFeed.close();
    await dbHandle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error: unknown) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
