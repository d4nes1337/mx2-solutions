import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "@mx2/config";
import type {
  AdminViewsStore,
  AllowlistStore,
  AuditStore,
  ReferralCodeRow,
  ReferralStore,
  SessionStore,
  WaitlistStore,
} from "@mx2/db";
import { isValidReferralCode, normalizeReferralCode } from "@mx2/db";
import { WAITLIST_STATUSES, type WaitlistStatus } from "@mx2/db";
import { makeRequireAdminWallet } from "../middleware/require-admin.js";
import type {} from "../auth/types.js";

export interface AdminPanelRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  referrals: ReferralStore;
  adminViews: AdminViewsStore;
  allowlist: AllowlistStore;
  waitlist?: WaitlistStore;
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const MintCodeSchema = z
  .object({
    /** Vanity code (VIP handles like "ANSEM"); omitted = auto-generated. */
    code: z.string().trim().min(3).max(20).optional(),
    /** Personal/VIP owner; omitted = unassigned campaign code. */
    ownerWallet: z.string().regex(ETH_ADDRESS_RE).optional(),
    maxUses: z.number().int().min(0).max(100_000),
    note: z.string().trim().min(1).max(200).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const PatchCodeSchema = z
  .object({
    maxUses: z.number().int().min(0).max(100_000).optional(),
    note: z.string().trim().max(200).nullable().optional(),
    disabled: z.boolean().optional(),
    ownerWallet: z.string().regex(ETH_ADDRESS_RE).nullable().optional(),
  })
  .strict();

const codeStatus = (row: ReferralCodeRow): "active" | "disabled" | "expired" | "exhausted" => {
  if (row.disabledAt !== null) return "disabled";
  if (row.expiresAt !== null && row.expiresAt <= new Date()) return "expired";
  if (row.usedCount >= row.maxUses) return "exhausted";
  return "active";
};

const serializeCode = (row: ReferralCodeRow) => ({
  id: row.id,
  code: row.code,
  status: codeStatus(row),
  ownerWallet: row.ownerWallet,
  usedCount: row.usedCount,
  maxUses: row.maxUses,
  note: row.note,
  createdBy: row.createdBy,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  disabledAt: row.disabledAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Wallet-session admin panel (owner decision 2026-07-28): referral codes,
 * users, and the waitlist behind ADMIN_WALLET_ADDRESSES. The legacy
 * x-admin-secret endpoints stay untouched as the curl/emergency path.
 */
export const registerAdminPanelRoutes = (
  app: FastifyInstance,
  deps: AdminPanelRoutesDeps,
): void => {
  const requireAdmin = makeRequireAdminWallet({
    sessions: deps.sessions,
    adminWallets: deps.config.referrals.adminWallets,
  });

  const actorOf = (req: FastifyRequest): string => `admin:${req.user!.walletAddress}`;

  // ── Overview ────────────────────────────────────────────────────────────────
  app.get("/api/admin/panel/overview", { preHandler: requireAdmin }, async () => {
    const [overview, waitlistEntries] = await Promise.all([
      deps.adminViews.overview(),
      deps.waitlist ? deps.waitlist.list() : Promise.resolve([]),
    ]);
    return {
      ...overview,
      waitlistWaiting: waitlistEntries.filter((e) => e.status === "waiting").length,
    };
  });

  // ── Codes ───────────────────────────────────────────────────────────────────
  app.get("/api/admin/panel/codes", { preHandler: requireAdmin }, async () => {
    const [codes, stats] = await Promise.all([deps.referrals.list(), deps.adminViews.codeStats()]);
    const statsById = new Map(stats.map((s) => [s.codeId, s]));
    return {
      codes: codes.map((row) => ({
        ...serializeCode(row),
        refereeCount: statsById.get(row.id)?.refereeCount ?? 0,
        attributedVolumeUsd: statsById.get(row.id)?.attributedVolumeUsd ?? "0",
      })),
    };
  });

  app.post("/api/admin/panel/codes", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = MintCodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "invalid code options" };
    }
    const { code, ownerWallet, maxUses, note, expiresInDays } = parsed.data;

    if (code !== undefined) {
      const canonical = normalizeReferralCode(code);
      if (!isValidReferralCode(canonical)) {
        reply.code(400);
        return {
          error: "INVALID_CODE",
          message: "Codes are 3–20 letters/digits (e.g. ANSEM).",
        };
      }
      const existing = await deps.referrals.findByCode(canonical);
      if (existing) {
        reply.code(409);
        return { error: "CODE_TAKEN", message: "This code already exists." };
      }
    }

    try {
      const row = await deps.referrals.createCode({
        ...(code !== undefined ? { code } : {}),
        ownerWallet: ownerWallet?.toLowerCase() ?? null,
        maxUses,
        note: note ?? null,
        createdBy: actorOf(req),
        expiresAt: expiresInDays
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
          : null,
      });
      await deps.auditStore.emit({
        actor: actorOf(req),
        action: "referral.code_created",
        subject: `referral_code:${row.id}`,
        metadata: { code: row.code, ownerWallet: row.ownerWallet, maxUses: row.maxUses },
      });
      return { code: serializeCode(row) };
    } catch (error) {
      // Unique-violation race with the pre-check above.
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23505"
      ) {
        reply.code(409);
        return { error: "CODE_TAKEN", message: "This code already exists." };
      }
      throw error;
    }
  });

  app.patch("/api/admin/panel/codes/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchCodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "invalid code update" };
    }
    const existing = await deps.referrals.findById(id);
    if (!existing) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "code not found" };
    }

    const { maxUses, note, disabled, ownerWallet } = parsed.data;
    let row = existing;
    if (maxUses !== undefined) row = (await deps.referrals.setMaxUses(id, maxUses)) ?? row;
    if (note !== undefined) row = (await deps.referrals.setNote(id, note)) ?? row;
    if (ownerWallet !== undefined) {
      row = (await deps.referrals.reassignOwner(id, ownerWallet)) ?? row;
    }
    if (disabled !== undefined) {
      row = (await deps.referrals.setDisabled(id, disabled, actorOf(req))) ?? row;
    }

    await deps.auditStore.emit({
      actor: actorOf(req),
      action: "referral.code_updated",
      subject: `referral_code:${id}`,
      metadata: { changes: parsed.data },
    });
    return { code: serializeCode(row) };
  });

  app.get(
    "/api/admin/panel/codes/:id/redemptions",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const code = await deps.referrals.findById(id);
      if (!code) {
        reply.code(404);
        return { error: "NOT_FOUND", message: "code not found" };
      }
      const redemptions = await deps.referrals.redemptionsForCode(id);
      return {
        redemptions: redemptions.map((r) => ({
          walletAddress: r.walletAddress,
          referrerWallet: r.referrerWallet,
          redeemedAt: r.redeemedAt.toISOString(),
        })),
      };
    },
  );

  // ── Users ───────────────────────────────────────────────────────────────────
  app.get("/api/admin/panel/users", { preHandler: requireAdmin }, async () => {
    const rows = await deps.adminViews.listUsers();
    return {
      users: rows.map((r) => ({
        walletAddress: r.walletAddress,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        allowlisted: r.allowlisted,
        allowlistAddedBy: r.allowlistAddedBy,
        referredByCode: r.referredByCode,
        referrerWallet: r.referrerWallet,
        referredAt: r.referredAt?.toISOString() ?? null,
        lifetimeVolumeUsd: r.lifetimeVolumeUsd ?? "0",
        tradeCount: r.tradeCount ?? 0,
        lastTradeAt: r.lastTradeAt?.toISOString() ?? null,
      })),
    };
  });

  // Ban a wallet: access record off + every live session cut. Access is open
  // by default, so this row is the ONLY thing that keeps a wallet out — and it
  // does so on its next request, not at session expiry. The referral
  // redemption row is preserved so the wallet cannot re-enter with another
  // code (UNIQUE wallet_address).
  app.post(
    "/api/admin/panel/users/:wallet/revoke-access",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { wallet } = req.params as { wallet: string };
      if (!ETH_ADDRESS_RE.test(wallet)) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "invalid wallet address" };
      }
      const address = wallet.toLowerCase();
      await deps.allowlist.remove(address);
      const sessionsRevoked = await deps.sessions.revokeAllForWallet(address);
      await deps.auditStore.emit({
        actor: actorOf(req),
        action: "referral.access_revoked",
        subject: `wallet:${address}`,
        metadata: { sessionsRevoked },
      });
      return { ok: true, sessionsRevoked };
    },
  );

  // Re-grant access (undo of the above; also handles manual VIP onboarding).
  app.post(
    "/api/admin/panel/users/:wallet/grant-access",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { wallet } = req.params as { wallet: string };
      if (!ETH_ADDRESS_RE.test(wallet)) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "invalid wallet address" };
      }
      const address = wallet.toLowerCase();
      await deps.allowlist.add(address, actorOf(req), "granted via admin panel");
      await deps.auditStore.emit({
        actor: actorOf(req),
        action: "allowlist.auto_added",
        subject: `wallet:${address}`,
        metadata: { via: "admin_panel" },
      });
      return { ok: true };
    },
  );

  // ── Waitlist ────────────────────────────────────────────────────────────────
  app.get("/api/admin/panel/waitlist", { preHandler: requireAdmin }, async (req, reply) => {
    if (!deps.waitlist) return { entries: [] };
    const q = req.query as Record<string, string | undefined>;
    const status = q["status"];
    if (status !== undefined && !WAITLIST_STATUSES.includes(status as WaitlistStatus)) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "unknown waitlist status" };
    }
    const rows = await deps.waitlist.list(status as WaitlistStatus | undefined);
    return { entries: rows };
  });
};
