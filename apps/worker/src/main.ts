import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import { createDb, createMarketSnapshotStore } from "@mx2/db";
import { createMarketFeedManager } from "./market-feed.js";

/**
 * Long-running worker process. Hosts the Polymarket WebSocket ingestion and
 * (in later slices) the conditional-rule evaluator. Single-writer per rule
 * ensures deterministic state transitions.
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
  logger.info({ dbUp, env: config.env }, "Worker started");

  const marketSnapshots = createMarketSnapshotStore(dbHandle.db);

  const marketFeed = createMarketFeedManager({
    wsUrl: config.polymarket.marketWsUrl,
    logger,
    marketSnapshots,
  });

  const heartbeat = setInterval(() => {
    logger.debug("worker heartbeat");
  }, HEARTBEAT_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Worker shutting down");
    clearInterval(heartbeat);
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
