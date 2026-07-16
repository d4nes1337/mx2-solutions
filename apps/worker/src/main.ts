import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import {
  createDb,
  createMarketSnapshotStore,
  createAuditStore,
  createRuleStore,
  createTriggerStore,
  createPrivyWalletStore,
  createDelegationStore,
  createRuntimeFlagStore,
  createOrderIntentStore,
  createClobCredentialStore,
  createTradingAccountStore,
  createTradingAccountClobCredentialStore,
} from "@mx2/db";
import {
  createAuthenticatedClobClient,
  createConfiguredDepositWalletRelayer,
  createPusdBalanceReader,
} from "@mx2/polymarket-client";
import { createConfiguredTradingSigner } from "@mx2/trading-signer";
import { createMarketFeedManager, type MarketFeedManager } from "./market-feed.js";
import { createRuleEvaluatorManager, type RuleEvaluatorManager } from "./rule-evaluator.js";
import { createAutoExecutor, type AutoExecutor } from "./auto-executor.js";
import { createQuoterManager, type QuoterManager } from "./quoter/manager.js";
import { createLiveCapableProvider } from "./quoter/executor-provider.js";
import { createRewardsPoller, type RewardsPoller } from "./quoter/rewards-poller.js";
import { createQuoterStore } from "@mx2/db";

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
      });
      logger.warn(
        "FEATURE_CONDITIONAL_LIVE_EXECUTION is ON — auto rules will submit real orders unattended",
      );
    }

    evaluator = createRuleEvaluatorManager({
      logger,
      ruleStore,
      triggerStore,
      auditStore,
      subscribe: (tokenIds) => feedRef.current?.subscribe(tokenIds),
      unsubscribe: (tokenIds) => feedRef.current?.unsubscribe(tokenIds),
      ...(autoExecutor ? { autoExecutor } : {}),
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
        }
      : {}),
  });
  feedRef.current = marketFeed;

  evaluator?.start();
  quoter?.start();
  rewardsPoller?.start();

  const heartbeat = setInterval(() => {
    logger.debug("worker heartbeat");
  }, HEARTBEAT_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Worker shutting down");
    clearInterval(heartbeat);
    evaluator?.stop();
    quoter?.stop();
    rewardsPoller?.stop();
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
