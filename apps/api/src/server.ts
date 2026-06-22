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
} from "@mx2/db";
import { createGammaClient, createClobClient, createDataClient } from "@mx2/polymarket-client";
import { buildApp } from "./app.js";

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

  const gammaClient = createGammaClient({ baseUrl: config.polymarket.gammaBaseUrl });
  const clobClient = createClobClient({ baseUrl: config.polymarket.clobBaseUrl });
  const dataClient = createDataClient({ baseUrl: config.polymarket.dataBaseUrl });

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
    gammaClient,
    clobClient,
    dataClient,
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
