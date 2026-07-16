import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  PrivyWalletStore,
  QuoterStore,
  RuleStore,
  SessionStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import type { ClobClient, GammaClient, GeoblockClient } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeGeoblockCheck } from "../middleware/geoblock.js";
import { makeRateLimit } from "../middleware/rate-limit.js";
import type { AllowanceReader } from "../trade/allowance-bootstrap.js";
import { depositWalletSpenders, findMissingGrants } from "../trade/deposit-wallet-allowances.js";

export interface QuoterRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  ruleStore: RuleStore;
  quoterStore: QuoterStore;
  auditStore: AuditStore;
  gammaClient: GammaClient;
  clobClient: ClobClient;
  geoblockClient: GeoblockClient;
  /** Readiness-panel inputs (optional so light test apps stay light). */
  privyWallets?: PrivyWalletStore;
  tradingAccounts?: TradingAccountStore;
  accountClobCredentials?: TradingAccountClobCredentialStore;
  allowanceReader?: AllowanceReader | null;
  relayerEnabled?: boolean;
}

// ── Farmability scanner (15-min cache) ──────────────────────────────────────

export interface ScannerMarket {
  conditionId: string;
  title: string;
  yesTokenId: string | null;
  noTokenId: string | null;
  ratePerDayUsd: number;
  minSize: number | null;
  maxSpreadCents: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadCents: number | null;
  liquidityUsd: number | null;
  negRisk: boolean;
  /** Headroom between the live spread and the rewards band (bigger = easier). */
  spreadHeadroomCents: number | null;
}

const SCANNER_TTL_MS = 15 * 60_000;
let scannerCache: { at: number; value: { markets: ScannerMarket[]; fetchedAt: string } } | null =
  null;

const parseTokenIds = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* malformed clobTokenIds */
  }
  return [];
};

const buildScanner = async (
  deps: QuoterRoutesDeps,
): Promise<{ markets: ScannerMarket[]; fetchedAt: string }> => {
  const page = await deps.clobClient.getRewardsMarketsCurrent();
  if (!page.ok) return { markets: [], fetchedAt: new Date().toISOString() };

  const withRates = page.value
    .map((r) => ({
      row: r,
      conditionId: r.condition_id ?? r.market ?? "",
      rate: r.rewards_config?.reduce((max, c) => Math.max(max, c.rate_per_day ?? 0), 0) ?? 0,
    }))
    .filter((r) => r.conditionId !== "" && r.rate > 0)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 20);

  const markets = (
    await Promise.all(
      withRates.map(async ({ row, conditionId, rate }): Promise<ScannerMarket | null> => {
        const gamma = await deps.gammaClient.getMarket(conditionId);
        if (!gamma.ok || gamma.value.closed || !gamma.value.active) return null;
        const m = gamma.value;
        const tokens = parseTokenIds(m.clobTokenIds);
        const bestBid = Number(m.bestBid) > 0 ? Number(m.bestBid) : null;
        const bestAsk = Number(m.bestAsk) > 0 ? Number(m.bestAsk) : null;
        const spreadCents =
          bestBid !== null && bestAsk !== null ? Math.round((bestAsk - bestBid) * 1000) / 10 : null;
        const maxSpreadCents = row.rewards_max_spread ?? m.rewardsMaxSpread ?? null;
        return {
          conditionId,
          title: m.question,
          yesTokenId: tokens[0] ?? null,
          noTokenId: tokens[1] ?? null,
          ratePerDayUsd: rate,
          minSize: row.rewards_min_size ?? m.rewardsMinSize ?? null,
          maxSpreadCents,
          bestBid,
          bestAsk,
          spreadCents,
          liquidityUsd: Number(m.liquidity) > 0 ? Number(m.liquidity) : null,
          negRisk: m.neg_risk ?? false,
          spreadHeadroomCents:
            maxSpreadCents !== null && spreadCents !== null
              ? Math.round((maxSpreadCents - spreadCents / 2) * 10) / 10
              : null,
        };
      }),
    )
  ).filter((m): m is ScannerMarket => m !== null);

  return { markets, fetchedAt: new Date().toISOString() };
};

const ModeSchema = z.object({ mode: z.enum(["shadow", "confirm", "live"]) });

/**
 * Maker-loop session controls (RFC-0003). Everything here is wallet-scoped
 * via the owning Smart Order; mode escalation is audited and fail-closed:
 * confirm/live modes require FEATURE_MAKER_LOOP_LIVE (which config-load
 * refuses without relayer + signer + verified adapters), and today the worker
 * only constructs the SHADOW executor regardless (checkpoint 2 lifts that).
 */
export const registerQuoterRoutes = (app: FastifyInstance, deps: QuoterRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });
  // Geoblock applies wherever real orders can start flowing: on escalation
  // out of shadow and on every confirm-mode approval (RFC-0003 §6.5).
  const geoblockCheck = makeGeoblockCheck({
    geoblockClient: deps.geoblockClient,
    auditStore: deps.auditStore,
  });

  const requireEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.makerLoop) {
      await reply.code(503).send({
        error: "MAKER_LOOP_DISABLED",
        message: "Maker loops are not enabled on this server.",
      });
    }
  };

  const guard = { preHandler: [requireAuth, requireEnabled] };

  // PUBLIC, flag-gated, rate-limited: markets ranked by rewards farmability.
  app.get(
    "/api/rewards/scanner",
    {
      preHandler: [
        requireEnabled,
        makeRateLimit({ scope: "rewards-scanner", limit: 30, windowMs: 60_000 }),
      ],
    },
    async () => {
      if (scannerCache && Date.now() - scannerCache.at < SCANNER_TTL_MS) {
        return scannerCache.value;
      }
      const value = await buildScanner(deps);
      // Don't cache empty results (upstream hiccup) — retry on the next call.
      if (value.markets.length > 0) scannerCache = { at: Date.now(), value };
      return value;
    },
  );

  // ── GET /api/quoter/readiness ──────────────────────────────────────────────
  // The live-farming ladder as PRESENCE/STATE BOOLEANS ONLY — flag states,
  // configured-or-not, on-chain grant status. Never a credential value, never
  // an address that isn't already public to the signed-in owner.
  app.get("/api/quoter/readiness", guard, async (req) => {
    const user = req.user!;
    const cfg = deps.config;

    const wallet = deps.privyWallets ? await deps.privyWallets.find(user.walletAddress) : null;
    const account =
      wallet && deps.tradingAccounts
        ? (await deps.tradingAccounts.listByOwner(user.walletAddress)).find(
            (a) =>
              a.kind === "internal_privy" &&
              a.archivedAt === null &&
              a.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase(),
          )
        : null;
    const credsRow =
      account && deps.accountClobCredentials
        ? await deps.accountClobCredentials.find(account.id)
        : null;

    // On-chain allowance status per spender (chain = source of truth).
    let allowances: { label: string; kind: string; granted: boolean }[] | null = null;
    if (deps.allowanceReader && account?.depositWalletAddress) {
      const spenders = depositWalletSpenders(cfg);
      const missing = await findMissingGrants(
        deps.allowanceReader,
        account.depositWalletAddress,
        spenders,
      );
      const missingKeys = new Set(missing.map((m) => `${m.spender.label}:${m.kind}`));
      allowances = spenders.flatMap((s) =>
        (["collateral", "ctf"] as const)
          .filter((kind) => s[kind])
          .map((kind) => ({
            label: s.label,
            kind,
            granted: !missingKeys.has(`${s.label}:${kind}`),
          })),
      );
    }

    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip;
    const geo = await deps.geoblockClient.check(ip);

    return {
      flags: {
        makerLoop: cfg.features.makerLoop,
        makerLoopLive: cfg.features.makerLoopLive,
        liveTrading: cfg.features.liveTrading,
        privySigning: cfg.features.privySigning,
        relayer: cfg.features.relayer,
      },
      relayerEnabled: deps.relayerEnabled ?? false,
      rpcConfigured: Boolean(deps.allowanceReader),
      adapters: {
        ctfConfigured: Boolean(cfg.ctf.adapterAddress),
        negRiskConfigured: Boolean(cfg.ctf.negRiskAdapterAddress),
      },
      wallet: {
        provisioned: wallet !== null,
        depositWalletActive: Boolean(account?.depositWalletAddress),
        clobCredentials: credsRow !== null,
      },
      allowances,
      geoblock: geo.ok
        ? { status: geo.value.status, country: geo.value.country }
        : { status: "unknown" },
    };
  });

  const ownedSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user!;
    const { ruleId } = req.params as { ruleId: string };
    const rule = await deps.ruleStore.findByIdForWallet(ruleId, user.walletAddress);
    if (!rule) {
      reply.code(404);
      await reply.send({ error: "NOT_FOUND", message: "Smart Order not found" });
      return null;
    }
    const session = await deps.quoterStore.findSessionByRuleId(ruleId);
    if (!session) {
      reply.code(404);
      await reply.send({
        error: "NO_SESSION",
        message:
          "No quoting session yet — the worker attaches armed maker loops within a few seconds.",
      });
      return null;
    }
    return session;
  };

  app.get("/api/quoter/sessions/:ruleId", guard, async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const events = await deps.quoterStore.listEvents(session.id, undefined, 50);
    return { session, recentEvents: events };
  });

  app.get("/api/quoter/sessions/:ruleId/events", guard, async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const q = req.query as Record<string, string>;
    const after = q["after"] ? new Date(q["after"]) : undefined;
    const limit = q["limit"] ? Number(q["limit"]) : 100;
    const events = await deps.quoterStore.listEvents(session.id, after, limit);
    return { events };
  });

  app.post("/api/quoter/sessions/:ruleId/mode", guard, async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const parsed = ModeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "mode must be shadow | confirm | live" };
    }
    const mode = parsed.data.mode;
    if (mode === "shadow" && session.mode !== "shadow" && session.status !== "halted") {
      // De-escalation guard: a shadow executor cannot manage (or cancel) real
      // resting orders. Halt first — that cancels everything — then switch.
      reply.code(409);
      return {
        error: "HALT_BEFORE_SHADOW",
        message: "Halt the session first — live orders must be cancelled before shadow mode.",
      };
    }
    if (mode !== "shadow") {
      if (!deps.config.features.makerLoopLive) {
        reply.code(503);
        return {
          error: "MAKER_LOOP_LIVE_DISABLED",
          message:
            "Confirm/live modes require FEATURE_MAKER_LOOP_LIVE (relayer, signer and verified CTF adapters) — see RFC-0003.",
        };
      }
      // Escalation out of shadow = real orders may start. Geoblock, fail-closed.
      await geoblockCheck(req, reply);
      if (reply.sent) return reply;
    }
    const updated = await deps.quoterStore.setMode(session.id, mode);
    await deps.auditStore.emit({
      actor: req.user!.walletAddress,
      action: "quoter.mode_changed",
      subject: `rule:${(req.params as { ruleId: string }).ruleId}`,
      metadata: { from: session.mode, to: mode },
    });
    return { session: updated };
  });

  // ── POST /api/quoter/sessions/:ruleId/confirm ──────────────────────────────
  // Confirm-mode approval (RFC-0003 checkpoint 3). The client approves the
  // EXACT pending batch by hash; the store's WHERE guard rejects anything but
  // the current proposal (409 BATCH_STALE → refetch, prices moved). The worker
  // then executes only if the hash it recomputes from the live book still
  // matches — a stale approval is structurally inert.
  app.post("/api/quoter/sessions/:ruleId/confirm", guard, async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const parsed = z.object({ batchHash: z.string().min(16).max(128) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "batchHash is required" };
    }
    if (session.mode !== "confirm") {
      reply.code(409);
      return {
        error: "WRONG_MODE",
        message: "Batch approval only applies to sessions in confirm mode.",
      };
    }
    // Every approval green-lights real orders — geoblock each one.
    await geoblockCheck(req, reply);
    if (reply.sent) return reply;

    const updated = await deps.quoterStore.approveBatch(session.id, parsed.data.batchHash);
    if (!updated) {
      reply.code(409);
      return {
        error: "BATCH_STALE",
        message:
          "The market moved and the proposed batch changed — review the new proposal and approve again.",
      };
    }
    await deps.auditStore.emit({
      actor: req.user!.walletAddress,
      action: "quoter.batch_approved",
      subject: `rule:${(req.params as { ruleId: string }).ruleId}`,
      metadata: { batchHash: parsed.data.batchHash },
    });
    return { session: updated };
  });

  app.post("/api/quoter/sessions/:ruleId/halt", guard, async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const updated = await deps.quoterStore.updateSession(session.id, {
      status: "halted",
      haltedReason: "user",
    });
    await deps.auditStore.emit({
      actor: req.user!.walletAddress,
      action: "quoter.halted",
      subject: `rule:${(req.params as { ruleId: string }).ruleId}`,
      metadata: { reason: "user" },
    });
    return { session: updated };
  });

  app.post("/api/quoter/sessions/:ruleId/resume", guard, async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const updated = await deps.quoterStore.updateSession(session.id, {
      status: "idle",
      haltedReason: null,
    });
    await deps.auditStore.emit({
      actor: req.user!.walletAddress,
      action: "quoter.resumed",
      subject: `rule:${(req.params as { ruleId: string }).ruleId}`,
      metadata: {},
    });
    return { session: updated };
  });
};
