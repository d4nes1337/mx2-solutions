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
  OrderIntentStore,
  RuntimeFlagStore,
  RuleStore,
  TriggerStore,
} from "@mx2/db";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  AuthenticatedClobClient,
  GeoblockClient,
} from "@mx2/polymarket-client";
import { registerEventsRoutes } from "./routes/events.js";
import { registerMarketsRoutes } from "./routes/markets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerTradeRoutes } from "./routes/trade.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerRulesRoutes } from "./routes/rules.js";
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
  orderIntents: OrderIntentStore;
  runtimeFlags: RuntimeFlagStore;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  gammaClient: GammaClient;
  clobClient: ClobClient;
  dataClient: DataClient;
  tradingClobClient: AuthenticatedClobClient;
  geoblockClient: GeoblockClient;
}

/**
 * Builds the Fastify app with dependencies injected so it can be tested via
 * `app.inject(...)` without opening a socket or a real database connection.
 */
export const buildApp = (deps: AppDeps) => {
  const app = Fastify({ loggerInstance: deps.logger, disableRequestLogging: false });

  // Expose req.user on every request (null until auth middleware sets it).
  app.decorateRequest("user", null);

  // CORS: in development allow any localhost origin (needed for the test HTML page).
  // In staging/production the allowed origin must be set to the real frontend URL.
  void app.register(fastifyCors, {
    origin: deps.config.env === "development" ? (origin, cb) => cb(null, origin ?? true) : false,
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
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
  registerMarketsRoutes(fastifyApp, {
    gammaClient: deps.gammaClient,
    clobClient: deps.clobClient,
    marketSnapshots: deps.marketSnapshots,
  });
  registerAuthRoutes(fastifyApp, {
    config: deps.config,
    challenges: deps.challenges,
    users: deps.users,
    sessions: deps.sessions,
    allowlist: deps.allowlist,
    auditStore: deps.auditStore,
  });
  registerProfileRoutes(fastifyApp, {
    dataClient: deps.dataClient,
    sessions: deps.sessions,
  });
  registerTradeRoutes(fastifyApp, {
    config: deps.config,
    sessions: deps.sessions,
    auditStore: deps.auditStore,
    clobCredentials: deps.clobCredentials,
    orderIntents: deps.orderIntents,
    runtimeFlags: deps.runtimeFlags,
    tradingClobClient: deps.tradingClobClient,
    geoblockClient: deps.geoblockClient,
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
    marketSnapshots: deps.marketSnapshots,
  });

  return app;
};
