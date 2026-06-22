import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { Logger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import type { GammaClient, ClobClient } from "@mx2/polymarket-client";
import { registerEventsRoutes } from "./routes/events.js";
import { registerMarketsRoutes } from "./routes/markets.js";

/** Minimal surface the app needs from the database (keeps tests light). */
export interface DbProbe {
  ping(): Promise<boolean>;
}

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: DbProbe;
  marketSnapshots: MarketSnapshotStore;
  gammaClient: GammaClient;
  clobClient: ClobClient;
}

/**
 * Builds the Fastify app with dependencies injected so it can be tested via
 * `app.inject(...)` without opening a socket or a real database connection.
 */
export const buildApp = (deps: AppDeps) => {
  const app = Fastify({ loggerInstance: deps.logger, disableRequestLogging: false });

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
  registerMarketsRoutes(fastifyApp, {
    gammaClient: deps.gammaClient,
    clobClient: deps.clobClient,
    marketSnapshots: deps.marketSnapshots,
  });

  return app;
};
