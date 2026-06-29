import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import {
  createDb,
  createAuditStore,
  createMarketSnapshotStore,
  createChallengeStore,
  createUserStore,
  createSessionStore,
  createAllowlistStore,
  createClobCredentialStore,
  createOrderIntentStore,
  createRuntimeFlagStore,
  createRuleStore,
  createTriggerStore,
  createPrivyWalletStore,
  createDelegationStore,
} from "@mx2/db";
import {
  createGammaClient,
  createClobClient,
  createDataClient,
  createAuthenticatedClobClient,
  createGeoblockClient,
} from "@mx2/polymarket-client";
import { buildApp } from "./app.js";
import { createTradingSignerFromConfig } from "./trade/signer-factory.js";

/** Process entrypoint: wire real dependencies, start serving, shut down cleanly. */
const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger({
    name: "api",
    level: config.logLevel,
    pretty: config.env === "development",
  });

  const dbHandle = createDb(config.databaseUrl);
  const auditStore = createAuditStore(dbHandle.db);
  const marketSnapshots = createMarketSnapshotStore(dbHandle.db);
  const challenges = createChallengeStore(dbHandle.db);
  const users = createUserStore(dbHandle.db);
  const sessions = createSessionStore(dbHandle.db);
  const allowlist = createAllowlistStore(dbHandle.db);
  const clobCredentials = createClobCredentialStore(dbHandle.db);
  const orderIntents = createOrderIntentStore(dbHandle.db);
  const runtimeFlags = createRuntimeFlagStore(dbHandle.db);
  const ruleStore = createRuleStore(dbHandle.db);
  const triggerStore = createTriggerStore(dbHandle.db);
  const privyWallets = createPrivyWalletStore(dbHandle.db);
  const delegations = createDelegationStore(dbHandle.db);
  const tradingSigner = createTradingSignerFromConfig(config);

  const gammaClient = createGammaClient({ baseUrl: config.polymarket.gammaBaseUrl });
  const clobClient = createClobClient({ baseUrl: config.polymarket.clobBaseUrl });
  const dataClient = createDataClient({ baseUrl: config.polymarket.dataBaseUrl });
  const tradingClobClient = createAuthenticatedClobClient({
    baseUrl: config.polymarket.clobBaseUrl,
  });
  const geoblockClient = createGeoblockClient({ baseUrl: config.polymarket.geoblockUrl });

  const app = buildApp({
    config,
    logger,
    db: dbHandle,
    auditStore,
    marketSnapshots,
    challenges,
    users,
    sessions,
    allowlist,
    clobCredentials,
    orderIntents,
    runtimeFlags,
    ruleStore,
    triggerStore,
    privyWallets,
    delegations,
    gammaClient,
    clobClient,
    dataClient,
    tradingClobClient,
    tradingSigner,
    geoblockClient,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    await dbHandle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });

  try {
    await auditStore.emit({
      actor: "system",
      action: "system.startup",
      subject: "api",
      metadata: { env: config.env, port: config.apiPort },
    });
  } catch (error) {
    logger.warn({ err: error }, "Could not write startup audit event (db unavailable?)");
  }
};

main().catch((error: unknown) => {
  console.error("API failed to start:", error);
  process.exit(1);
});
