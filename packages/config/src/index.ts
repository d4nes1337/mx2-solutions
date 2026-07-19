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
  POLYMARKET_BRIDGE_BASE_URL: z.string().url().default("https://bridge.polymarket.com"),
  POLYGON_CHAIN_ID: z.coerce.number().int().default(137),

  // Non-secret identifier. Optional until provided by the owner.
  POLYMARKET_BUILDER_CODE: z.string().optional(),
  // Builder relayer onboarding credentials (backend-only). Required when
  // FEATURE_RELAYER=true, never exposed to the browser.
  POLYMARKET_RELAYER_URL: z.string().url().optional(),
  POLYMARKET_BUILDER_API_KEY: z.string().optional(),
  POLYMARKET_BUILDER_SECRET: z.string().optional(),
  POLYMARKET_BUILDER_PASSPHRASE: z.string().optional(),

  // Session configuration. Derived cookieSecure from APP_ENV at runtime.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  // Set true when the frontend is served from a DIFFERENT origin than the API
  // (e.g. web on Vercel, API on Lightsail). Switches the session cookie to
  // SameSite=None; Secure so it flows cross-site. Keep false for same-domain deploys.
  COOKIE_CROSS_SITE: boolFromEnv(false),

  // Encryption master key for per-user L2 CLOB credentials stored in DB.
  // Must be a 64-char hex string (32 bytes). Required when FEATURE_LIVE_TRADING=true.
  APP_ENCRYPTION_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64-char hex")
    .optional(),

  // Secret header value for the /api/admin/* kill-switch endpoints.
  TRADING_ADMIN_SECRET: z.string().min(16).optional(),

  // ── Privy server-side signing (sign-once trading) ──────────────────────────
  // The embedded-wallet provider that signs orders server-side inside a secure
  // enclave. Required only when FEATURE_PRIVY_SIGNING=true (validated below).
  // The raw private key is NEVER held by this app — only these app credentials.
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_AUTHORIZATION_KEY: z.string().optional(),
  PRIVY_KEY_QUORUM_ID: z.string().optional(),
  // Privy policy id allowlisting only Polymarket contracts (destination backstop).
  PRIVY_TRADING_POLICY_ID: z.string().optional(),
  // Polygon RPC for reading allowances / building bootstrap txs (Slice C).
  POLYGON_RPC_URL: z.string().url().optional(),

  // Non-production escape hatch: a local test key the mock signer uses so the whole
  // server-signing path can run without Privy (the live-OFF dry-run). NEVER set in
  // production — config load rejects it there.
  MOCK_SIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64-char hex")
    .optional(),

  // Trading-session limits (owner-selected guardrails).
  // Delegation TTL: 14 days default, 30 days hard cap (D-019: armed auto
  // strategies must survive multi-day windows; kill switch + per-strategy
  // limits + disarm compensate for the longer authority).
  SESSION_SIGNER_TTL_SECONDS: z.coerce.number().int().positive().max(2_592_000).default(1_209_600),
  ORDER_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),

  // ── AI strategy generation (Anthropic) ─────────────────────────────────────
  // Secret API key for the NL→Smart Order endpoint. Required when
  // FEATURE_AI_CHAT=true (validated below). Never exposed to the browser.
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-sonnet-5"),

  // Feature flags. All risk-bearing features default OFF (fail-closed).
  FEATURE_LIVE_TRADING: boolFromEnv(false),
  FEATURE_CONDITIONAL_RULES: boolFromEnv(true),
  // Smart Order DSL v2 API surface (builder, draft evaluation, market search).
  // Not a spend-risk feature by itself — execution risk stays behind the flags
  // below — so it defaults ON like FEATURE_CONDITIONAL_RULES.
  FEATURE_SMART_ORDERS_V2: boolFromEnv(true),
  FEATURE_CONDITIONAL_LIVE_EXECUTION: boolFromEnv(false),
  FEATURE_RELAYER: boolFromEnv(false),
  // Server-side signing (manual no-popup orders). Independent of live trading.
  FEATURE_PRIVY_SIGNING: boolFromEnv(false),
  // Public NL→Smart Order generation (Anthropic). Not a spend-risk feature —
  // generated orders are always execution:"prepare" — but it calls a paid
  // upstream API, so it fails closed without a key (validated below).
  FEATURE_AI_CHAT: boolFromEnv(false),
  // Open beta: auto-allowlist every wallet that completes EIP-712 sign-in.
  // Allowlist table stays the source of truth (per-wallet revocation intact).
  FEATURE_OPEN_BETA: boolFromEnv(false),

  // Trading-wallet withdrawals — deposit-wallet USDC.e back to the OWNER's
  // login wallet only (destination is never client input). Cross-checked
  // below: requires the relayer stack.
  FEATURE_WALLET_WITHDRAW: boolFromEnv(false),
  // Polymarket Bridge funding: generates per-user deposit addresses whose only
  // possible destination is the user's own deposit wallet — no custody or spend
  // risk — so it defaults ON (owner decision 2026-07-18, D-033). Withdrawals
  // move pUSD out and stay separately gated + cross-checked below.
  FEATURE_BRIDGE_FUNDING: boolFromEnv(true),
  FEATURE_BRIDGE_WITHDRAWALS: boolFromEnv(false),

  // ── External notifications (Telegram/Discord) ─────────────────────────────
  // Master switch for the notification pipeline (outbox enqueue + linking API).
  // Delivery channels are gated separately below. No spend risk by itself, but
  // defaults OFF: it emits user activity to external services once a channel
  // flag is also on.
  FEATURE_NOTIFICATIONS: boolFromEnv(false),
  // Telegram bot: /start linking, outbox delivery, sign links. Requires the
  // bot credentials below (validated fail-closed).
  FEATURE_TELEGRAM_BOT: boolFromEnv(false),
  // Telegram Mini App auth (initData verification). Requires the bot.
  FEATURE_TELEGRAM_MINIAPP: boolFromEnv(false),
  // Discord bot delivery (notifications-only). Requires DISCORD_BOT_TOKEN.
  FEATURE_DISCORD_BOT: boolFromEnv(false),
  // Bot credentials — sensitive secrets (docs/05): secret manager only, never
  // logged, never committed, never exposed to the browser.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  // Discord OAuth2 app (identify scope) — the account-linking handshake.
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_GUILD_INVITE_URL: z.string().url().optional(),

  // Maker loop (RFC-0003): quote_loop creation + SHADOW quoting + cockpit UI.
  // Places no orders and moves no funds by itself.
  FEATURE_MAKER_LOOP: boolFromEnv(false),
  // Live maker-loop execution (orders + merges). Fail-closed cross-checked
  // below; additionally requires the verified CTF adapter addresses.
  FEATURE_MAKER_LOOP_LIVE: boolFromEnv(false),
  // CTF collateral-adapter addresses (standard + negRisk). NO defaults — the
  // official docs and the ctf-exchange-v2 README disagree (R-028), so these
  // must come from on-chain verification (apps/api verify-ctf-adapters).
  CTF_ADAPTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  NEG_RISK_CTF_ADAPTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export type AppConfig = {
  env: "development" | "staging" | "production";
  baseUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  apiPort: number;
  databaseUrl: string;
  encryptionMasterKey: string | undefined;
  tradingAdminSecret: string | undefined;
  polymarket: {
    gammaBaseUrl: string;
    clobBaseUrl: string;
    marketWsUrl: string;
    userWsUrl: string;
    geoblockUrl: string;
    dataBaseUrl: string;
    bridgeBaseUrl: string;
    chainId: number;
    builderCode: string | undefined;
    relayer: {
      url: string | undefined;
      builderApiKey: string | undefined;
      builderSecret: string | undefined;
      builderPassphrase: string | undefined;
    };
  };
  session: {
    ttlSeconds: number;
    cookieSecure: boolean;
    crossSite: boolean;
  };
  privy: {
    appId: string | undefined;
    appSecret: string | undefined;
    authorizationKey: string | undefined;
    keyQuorumId: string | undefined;
    tradingPolicyId: string | undefined;
  };
  polygonRpcUrl: string | undefined;
  mockSignerPrivateKey: string | undefined;
  ai: {
    model: string;
    anthropicApiKey: string | undefined;
  };
  limits: {
    sessionSignerTtlSeconds: number;
    orderRateLimitPerMin: number;
  };
  ctf: {
    adapterAddress: string | undefined;
    negRiskAdapterAddress: string | undefined;
  };
  notifications: {
    telegramBotToken: string | undefined;
    telegramBotUsername: string | undefined;
    discordBotToken: string | undefined;
    discordClientId: string | undefined;
    discordClientSecret: string | undefined;
    discordGuildInviteUrl: string | undefined;
  };
  features: {
    liveTrading: boolean;
    conditionalRules: boolean;
    smartOrdersV2: boolean;
    conditionalLiveExecution: boolean;
    relayer: boolean;
    privySigning: boolean;
    aiChat: boolean;
    openBeta: boolean;
    walletWithdraw: boolean;
    bridgeFunding: boolean;
    bridgeWithdrawals: boolean;
    makerLoop: boolean;
    makerLoopLive: boolean;
    notifications: boolean;
    telegramBot: boolean;
    telegramMiniapp: boolean;
    discordBot: boolean;
  };
};

export class ConfigError extends Error {}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.message}`);
  }
  const e = parsed.data;

  // Gated enablement (formerly a blanket ban): unattended conditional execution is
  // permitted only with server-side signing AND the live-trading master switch on.
  // Still fail-closed — a half-enabled configuration throws rather than running.
  if (e.FEATURE_CONDITIONAL_LIVE_EXECUTION) {
    if (!e.FEATURE_PRIVY_SIGNING || !e.FEATURE_LIVE_TRADING) {
      throw new ConfigError(
        "FEATURE_CONDITIONAL_LIVE_EXECUTION requires FEATURE_PRIVY_SIGNING=true and " +
          "FEATURE_LIVE_TRADING=true (the signer + real-money switch).",
      );
    }
  }

  // Fail-closed: server-side signing must have a usable signer backend. Either the
  // full Privy credentials, or (non-production only) a mock signer key for the dry-run.
  // We refuse to start half-configured, where the signer would fail at request time.
  if (e.FEATURE_PRIVY_SIGNING) {
    const hasPrivy =
      e.PRIVY_APP_ID && e.PRIVY_APP_SECRET && e.PRIVY_AUTHORIZATION_KEY && e.PRIVY_KEY_QUORUM_ID;
    const hasMock = e.MOCK_SIGNER_PRIVATE_KEY && e.APP_ENV !== "production";
    if (!hasPrivy && !hasMock) {
      throw new ConfigError(
        "FEATURE_PRIVY_SIGNING=true requires Privy creds (PRIVY_APP_ID, PRIVY_APP_SECRET, " +
          "PRIVY_AUTHORIZATION_KEY, PRIVY_KEY_QUORUM_ID) — or MOCK_SIGNER_PRIVATE_KEY in a " +
          "non-production env for the dry-run.",
      );
    }
  }

  if (e.FEATURE_RELAYER) {
    const hasBuilderCreds =
      e.POLYMARKET_BUILDER_API_KEY &&
      e.POLYMARKET_BUILDER_SECRET &&
      e.POLYMARKET_BUILDER_PASSPHRASE;
    if (
      !e.FEATURE_PRIVY_SIGNING ||
      !e.POLYMARKET_RELAYER_URL ||
      !e.POLYGON_RPC_URL ||
      !hasBuilderCreds
    ) {
      throw new ConfigError(
        "FEATURE_RELAYER=true requires FEATURE_PRIVY_SIGNING=true, POLYGON_RPC_URL, " +
          "POLYMARKET_RELAYER_URL, " +
          "POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, and " +
          "POLYMARKET_BUILDER_PASSPHRASE.",
      );
    }
  }

  // Fail-closed: the AI endpoint calls a paid upstream — refuse to start
  // half-configured rather than 500 at request time.
  if (e.FEATURE_AI_CHAT && !e.ANTHROPIC_API_KEY) {
    throw new ConfigError("FEATURE_AI_CHAT=true requires ANTHROPIC_API_KEY.");
  }

  // Fail-closed ladder for external notifications: a delivery channel needs the
  // master switch plus its own credentials, or the bot would fail per-message.
  if (e.FEATURE_TELEGRAM_BOT) {
    if (!e.FEATURE_NOTIFICATIONS || !e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_BOT_USERNAME) {
      throw new ConfigError(
        "FEATURE_TELEGRAM_BOT=true requires FEATURE_NOTIFICATIONS=true, TELEGRAM_BOT_TOKEN, " +
          "and TELEGRAM_BOT_USERNAME.",
      );
    }
  }
  if (e.FEATURE_TELEGRAM_MINIAPP && !e.FEATURE_TELEGRAM_BOT) {
    throw new ConfigError(
      "FEATURE_TELEGRAM_MINIAPP=true requires FEATURE_TELEGRAM_BOT=true (initData is " +
        "verified against the bot token).",
    );
  }
  if (
    e.FEATURE_DISCORD_BOT &&
    (!e.FEATURE_NOTIFICATIONS ||
      !e.DISCORD_BOT_TOKEN ||
      !e.DISCORD_CLIENT_ID ||
      !e.DISCORD_CLIENT_SECRET)
  ) {
    throw new ConfigError(
      "FEATURE_DISCORD_BOT=true requires FEATURE_NOTIFICATIONS=true, DISCORD_BOT_TOKEN " +
        "(DM delivery), and DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET (OAuth linking).",
    );
  }

  // Fail-closed: withdrawals execute through the deposit-wallet relayer.
  if (e.FEATURE_WALLET_WITHDRAW && !e.FEATURE_RELAYER) {
    throw new ConfigError(
      "FEATURE_WALLET_WITHDRAW=true requires FEATURE_RELAYER=true (withdrawals execute " +
        "through the deposit-wallet relayer batch).",
    );
  }

  if (e.FEATURE_BRIDGE_WITHDRAWALS && !e.FEATURE_WALLET_WITHDRAW) {
    throw new ConfigError(
      "FEATURE_BRIDGE_WITHDRAWALS=true requires FEATURE_WALLET_WITHDRAW=true (bridge " +
        "withdrawals still execute from the owner-controlled deposit wallet).",
    );
  }

  // Fail-closed ladder for the maker loop (RFC-0003): live quoting requires
  // every underlying capability plus the ON-CHAIN-VERIFIED adapter addresses.
  if (e.FEATURE_MAKER_LOOP_LIVE) {
    if (
      !e.FEATURE_MAKER_LOOP ||
      !e.FEATURE_LIVE_TRADING ||
      !e.FEATURE_PRIVY_SIGNING ||
      !e.FEATURE_RELAYER ||
      !e.CTF_ADAPTER_ADDRESS ||
      !e.NEG_RISK_CTF_ADAPTER_ADDRESS
    ) {
      throw new ConfigError(
        "FEATURE_MAKER_LOOP_LIVE=true requires FEATURE_MAKER_LOOP, FEATURE_LIVE_TRADING, " +
          "FEATURE_PRIVY_SIGNING, FEATURE_RELAYER, and the verified CTF_ADAPTER_ADDRESS + " +
          "NEG_RISK_CTF_ADAPTER_ADDRESS (run verify-ctf-adapters first — R-028).",
      );
    }
  }

  return {
    env: e.APP_ENV,
    baseUrl: e.APP_BASE_URL,
    logLevel: e.APP_LOG_LEVEL,
    apiPort: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    encryptionMasterKey: e.APP_ENCRYPTION_MASTER_KEY,
    tradingAdminSecret: e.TRADING_ADMIN_SECRET,
    polymarket: {
      gammaBaseUrl: e.POLYMARKET_GAMMA_BASE_URL,
      clobBaseUrl: e.POLYMARKET_CLOB_BASE_URL,
      marketWsUrl: e.POLYMARKET_MARKET_WS_URL,
      userWsUrl: e.POLYMARKET_USER_WS_URL,
      geoblockUrl: e.POLYMARKET_GEOBLOCK_URL,
      dataBaseUrl: e.POLYMARKET_DATA_BASE_URL,
      bridgeBaseUrl: e.POLYMARKET_BRIDGE_BASE_URL,
      chainId: e.POLYGON_CHAIN_ID,
      builderCode: e.POLYMARKET_BUILDER_CODE,
      relayer: {
        url: e.POLYMARKET_RELAYER_URL,
        builderApiKey: e.POLYMARKET_BUILDER_API_KEY,
        builderSecret: e.POLYMARKET_BUILDER_SECRET,
        builderPassphrase: e.POLYMARKET_BUILDER_PASSPHRASE,
      },
    },
    session: {
      ttlSeconds: e.SESSION_TTL_SECONDS,
      // SameSite=None requires Secure; force it on when cross-site.
      cookieSecure: e.APP_ENV !== "development" || e.COOKIE_CROSS_SITE,
      crossSite: e.COOKIE_CROSS_SITE,
    },
    privy: {
      appId: e.PRIVY_APP_ID,
      appSecret: e.PRIVY_APP_SECRET,
      authorizationKey: e.PRIVY_AUTHORIZATION_KEY,
      keyQuorumId: e.PRIVY_KEY_QUORUM_ID,
      tradingPolicyId: e.PRIVY_TRADING_POLICY_ID,
    },
    polygonRpcUrl: e.POLYGON_RPC_URL,
    mockSignerPrivateKey: e.MOCK_SIGNER_PRIVATE_KEY,
    ai: {
      model: e.AI_MODEL,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
    },
    limits: {
      sessionSignerTtlSeconds: e.SESSION_SIGNER_TTL_SECONDS,
      orderRateLimitPerMin: e.ORDER_RATE_LIMIT_PER_MIN,
    },
    ctf: {
      adapterAddress: e.CTF_ADAPTER_ADDRESS,
      negRiskAdapterAddress: e.NEG_RISK_CTF_ADAPTER_ADDRESS,
    },
    notifications: {
      telegramBotToken: e.TELEGRAM_BOT_TOKEN,
      telegramBotUsername: e.TELEGRAM_BOT_USERNAME,
      discordBotToken: e.DISCORD_BOT_TOKEN,
      discordClientId: e.DISCORD_CLIENT_ID,
      discordClientSecret: e.DISCORD_CLIENT_SECRET,
      discordGuildInviteUrl: e.DISCORD_GUILD_INVITE_URL,
    },
    features: {
      liveTrading: e.FEATURE_LIVE_TRADING,
      conditionalRules: e.FEATURE_CONDITIONAL_RULES,
      smartOrdersV2: e.FEATURE_SMART_ORDERS_V2,
      conditionalLiveExecution: e.FEATURE_CONDITIONAL_LIVE_EXECUTION,
      relayer: e.FEATURE_RELAYER,
      privySigning: e.FEATURE_PRIVY_SIGNING,
      aiChat: e.FEATURE_AI_CHAT,
      openBeta: e.FEATURE_OPEN_BETA,
      walletWithdraw: e.FEATURE_WALLET_WITHDRAW,
      bridgeFunding: e.FEATURE_BRIDGE_FUNDING,
      bridgeWithdrawals: e.FEATURE_BRIDGE_WITHDRAWALS,
      makerLoop: e.FEATURE_MAKER_LOOP,
      makerLoopLive: e.FEATURE_MAKER_LOOP_LIVE,
      notifications: e.FEATURE_NOTIFICATIONS,
      telegramBot: e.FEATURE_TELEGRAM_BOT,
      telegramMiniapp: e.FEATURE_TELEGRAM_MINIAPP,
      discordBot: e.FEATURE_DISCORD_BOT,
    },
  };
};
