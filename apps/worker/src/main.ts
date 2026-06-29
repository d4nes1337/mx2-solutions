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
} from "@mx2/db";
import { createAuthenticatedClobClient } from "@mx2/polymarket-client";
import { createConfiguredTradingSigner } from "@mx2/trading-signer";
import { createMarketFeedManager, type MarketFeedManager } from "./market-feed.js";
import { createRuleEvaluatorManager, type RuleEvaluatorManager } from "./rule-evaluator.js";
import { createAutoExecutor, type AutoExecutor } from "./auto-executor.js";

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
        tradingClobClient: createAuthenticatedClobClient({
          baseUrl: config.polymarket.clobBaseUrl,
        }),
        ruleStore,
        triggerStore,
        auditStore,
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

  const marketFeed = createMarketFeedManager({
    wsUrl: config.polymarket.marketWsUrl,
    logger,
    marketSnapshots,
    ...(evaluator
      ? {
          onBookView: (view) => evaluator?.onBook(view),
          onReconnect: () => evaluator?.onReconnect(),
          onTickSizeChange: (tokenId) => evaluator?.onTickSizeChange(tokenId),
        }
      : {}),
  });
  feedRef.current = marketFeed;

  evaluator?.start();

  const heartbeat = setInterval(() => {
    logger.debug("worker heartbeat");
  }, HEARTBEAT_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Worker shutting down");
    clearInterval(heartbeat);
    evaluator?.stop();
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
