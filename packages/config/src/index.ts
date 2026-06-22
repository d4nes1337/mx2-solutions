import { z } from "zod";

/**
 * Centralised, validated application configuration. All env access goes through
 * here so the rest of the codebase consumes a typed, validated object and never
 * reads process.env directly.
 *
 * Security invariants enforced at load time (fail-closed):
 *  - Unattended conditional live execution is forbidden in MVP 0.1.
 */

const boolFromEnv = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  APP_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  API_PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://mx2:mx2_local_dev@localhost:5432/polymarket_terminal"),

  // Upstream Polymarket endpoints (verified defaults; override per environment).
  POLYMARKET_GAMMA_BASE_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_BASE_URL: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_MARKET_WS_URL: z
    .string()
    .url()
    .default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  POLYMARKET_USER_WS_URL: z
    .string()
    .url()
    .default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
  POLYMARKET_GEOBLOCK_URL: z.string().url().default("https://polymarket.com/api/geoblock"),
  // A-042: data-api.polymarket.com assumed working; not yet verified against live docs.
  POLYMARKET_DATA_BASE_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLYGON_CHAIN_ID: z.coerce.number().int().default(137),

  // Non-secret identifier. Optional until provided by the owner.
  POLYMARKET_BUILDER_CODE: z.string().optional(),

  // Session configuration. Derived cookieSecure from APP_ENV at runtime.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

  // Feature flags. All risk-bearing features default OFF (fail-closed).
  FEATURE_LIVE_TRADING: boolFromEnv(false),
  FEATURE_CONDITIONAL_RULES: boolFromEnv(true),
  FEATURE_CONDITIONAL_LIVE_EXECUTION: boolFromEnv(false),
  FEATURE_RELAYER: boolFromEnv(false),
});

export type AppConfig = {
  env: "development" | "staging" | "production";
  baseUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  apiPort: number;
  databaseUrl: string;
  polymarket: {
    gammaBaseUrl: string;
    clobBaseUrl: string;
    marketWsUrl: string;
    userWsUrl: string;
    geoblockUrl: string;
    dataBaseUrl: string;
    chainId: number;
    builderCode: string | undefined;
  };
  session: {
    ttlSeconds: number;
    cookieSecure: boolean;
  };
  features: {
    liveTrading: boolean;
    conditionalRules: boolean;
    conditionalLiveExecution: boolean;
    relayer: boolean;
  };
};

export class ConfigError extends Error {}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.message}`);
  }
  const e = parsed.data;

  // Fail-closed invariant: MVP 0.1 must never enable unattended live execution.
  if (e.FEATURE_CONDITIONAL_LIVE_EXECUTION) {
    throw new ConfigError(
      "FEATURE_CONDITIONAL_LIVE_EXECUTION must be false in MVP 0.1 (no unattended execution).",
    );
  }

  return {
    env: e.APP_ENV,
    baseUrl: e.APP_BASE_URL,
    logLevel: e.APP_LOG_LEVEL,
    apiPort: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    polymarket: {
      gammaBaseUrl: e.POLYMARKET_GAMMA_BASE_URL,
      clobBaseUrl: e.POLYMARKET_CLOB_BASE_URL,
      marketWsUrl: e.POLYMARKET_MARKET_WS_URL,
      userWsUrl: e.POLYMARKET_USER_WS_URL,
      geoblockUrl: e.POLYMARKET_GEOBLOCK_URL,
      dataBaseUrl: e.POLYMARKET_DATA_BASE_URL,
      chainId: e.POLYGON_CHAIN_ID,
      builderCode: e.POLYMARKET_BUILDER_CODE,
    },
    session: {
      ttlSeconds: e.SESSION_TTL_SECONDS,
      cookieSecure: e.APP_ENV !== "development",
    },
    features: {
      liveTrading: e.FEATURE_LIVE_TRADING,
      conditionalRules: e.FEATURE_CONDITIONAL_RULES,
      conditionalLiveExecution: e.FEATURE_CONDITIONAL_LIVE_EXECUTION,
      relayer: e.FEATURE_RELAYER,
    },
  };
};
