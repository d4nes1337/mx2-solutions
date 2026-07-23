import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppConfig } from "@mx2/config";
import type {
  AllowlistStore,
  AuditStore,
  InvitationRow,
  InvitationStore,
  SessionStore,
  WaitlistStore,
} from "@mx2/db";
import { WAITLIST_STATUSES, type WaitlistStatus } from "@mx2/db";
import { generateInviteCode, hashInviteCode } from "../auth/invite-code.js";

export interface AdminInvitesRoutesDeps {
  config: AppConfig;
  auditStore: AuditStore;
  invitations: InvitationStore;
  waitlist: WaitlistStore;
  allowlist: AllowlistStore;
  sessions: SessionStore;
}

const secretsEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const MintBodySchema = z
  .object({
    /** Invitation lifetime; the first cohort default matches a manual-outreach cadence. */
    expiresInDays: z.number().int().min(1).max(90).default(14),
    note: z.string().trim().min(1).max(200).optional(),
    waitlistEntryId: z.string().uuid().optional(),
  })
  .strict();

/** Derived display status — the row itself stays append-ish (no destructive edits). */
const invitationStatus = (row: InvitationRow): "active" | "redeemed" | "revoked" | "expired" => {
  if (row.revokedAt !== null) return "revoked";
  if (row.redeemedAt !== null) return "redeemed";
  if (row.expiresAt < new Date()) return "expired";
  return "active";
};

const serializeInvitation = (row: InvitationRow) => ({
  id: row.id,
  status: invitationStatus(row),
  issuedBy: row.issuedBy,
  note: row.note,
  waitlistEntryId: row.waitlistEntryId,
  expiresAt: row.expiresAt.toISOString(),
  redeemedBy: row.redeemedBy,
  redeemedAt: row.redeemedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Owner-only invitation management for the first cohort (brief §4.3.4: an
 * admin endpoint is enough; email sending stays manual). Same header secret as
 * the kill-switch routes, but with a constant-time comparison.
 */
export const registerAdminInvitesRoutes = (
  app: FastifyInstance,
  deps: AdminInvitesRoutesDeps,
): void => {
  const requireAdminSecret = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const secret = deps.config.tradingAdminSecret;
    if (!secret) {
      reply.code(503);
      await reply.send({
        error: "ADMIN_NOT_CONFIGURED",
        message: "Admin endpoint is not configured.",
      });
      return;
    }
    const provided = req.headers["x-admin-secret"];
    if (typeof provided !== "string" || !secretsEqual(provided, secret)) {
      reply.code(401);
      await reply.send({ error: "UNAUTHORIZED", message: "Invalid admin secret." });
      return;
    }
  };

  const actorOf = (req: FastifyRequest): string =>
    `admin:${(req.headers["x-admin-actor"] as string | undefined) ?? "owner"}`;

  // Mint a one-time invitation. The raw code appears ONLY in this response.
  app.post("/api/admin/invitations", { preHandler: requireAdminSecret }, async (req, reply) => {
    const parsed = MintBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "invalid invitation options" };
    }
    const { expiresInDays, note, waitlistEntryId } = parsed.data;

    if (waitlistEntryId) {
      const entry = await deps.waitlist.findById(waitlistEntryId);
      if (!entry) {
        reply.code(404);
        return { error: "NOT_FOUND", message: "waitlist entry not found" };
      }
    }

    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const row = await deps.invitations.create({
      codeHash: hashInviteCode(code),
      issuedBy: actorOf(req),
      note: note ?? null,
      expiresAt,
      waitlistEntryId: waitlistEntryId ?? null,
    });
    if (waitlistEntryId) await deps.waitlist.updateStatus(waitlistEntryId, "invited");

    await deps.auditStore.emit({
      actor: actorOf(req),
      action: "invite.created",
      subject: `invitation:${row.id}`,
      metadata: {
        expiresAt: expiresAt.toISOString(),
        waitlistEntryId: waitlistEntryId ?? null,
      },
    });

    // The code is intentionally not persisted anywhere in plaintext.
    return { id: row.id, code, expiresAt: expiresAt.toISOString(), note: row.note };
  });

  app.get("/api/admin/invitations", { preHandler: requireAdminSecret }, async () => {
    const rows = await deps.invitations.list();
    return { invitations: rows.map(serializeInvitation) };
  });

  // Revoke an invitation. If it was already redeemed, beta access for the
  // redeeming wallet is removed and every live session is cut immediately;
  // audit history is preserved (nothing is deleted).
  app.post(
    "/api/admin/invitations/:id/revoke",
    { preHandler: requireAdminSecret },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = await deps.invitations.revoke(id, actorOf(req));
      if (!row) {
        const existing = await deps.invitations.findById(id);
        if (!existing) {
          reply.code(404);
          return { error: "NOT_FOUND", message: "invitation not found" };
        }
        // Already revoked — idempotent.
        return { ok: true, invitation: serializeInvitation(existing), sessionsRevoked: 0 };
      }

      let sessionsRevoked = 0;
      if (row.redeemedBy) {
        await deps.allowlist.remove(row.redeemedBy);
        sessionsRevoked = await deps.sessions.revokeAllForWallet(row.redeemedBy);
      }

      await deps.auditStore.emit({
        actor: actorOf(req),
        action: "invite.revoked",
        subject: `invitation:${row.id}`,
        metadata: { redeemedBy: row.redeemedBy, sessionsRevoked },
      });

      return { ok: true, invitation: serializeInvitation(row), sessionsRevoked };
    },
  );

  // Owner view of the waitlist queue (PII stays behind the admin secret).
  app.get("/api/admin/waitlist", { preHandler: requireAdminSecret }, async (req, reply) => {
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
