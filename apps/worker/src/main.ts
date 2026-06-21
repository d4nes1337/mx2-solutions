import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import { createDb } from "@mx2/db";

/**
 * Long-running worker process. In later slices this hosts the Polymarket
 * WebSocket ingestion and the conditional-rule evaluator (single-writer per
 * rule). For Slice 0 it starts, verifies DB connectivity, emits a heartbeat,
 * and shuts down cleanly — establishing the process lifecycle contract.
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

  const heartbeat = setInterval(() => {
    logger.debug("worker heartbeat");
  }, HEARTBEAT_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Worker shutting down");
    clearInterval(heartbeat);
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
