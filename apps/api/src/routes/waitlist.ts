import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditStore, WaitlistStore } from "@mx2/db";
import { makeRateLimit } from "../middleware/rate-limit.js";

export interface WaitlistRoutesDeps {
  auditStore: AuditStore;
  waitlist: WaitlistStore;
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Public waitlist submission. Joining needs an email OR a wallet address (or
 * both) — the form is deliberately that short (owner decision 2026-07-23); the
 * remaining fields stay accepted for future enrichment but are never required.
 * PII posture: the email lives only in the waitlist row (owner-visible via the
 * admin queue); it is never copied into logs or audit metadata — audit
 * references the entry id.
 */
const WaitlistBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    /** X or Telegram handle. */
    socialHandle: z.string().trim().min(1).max(80).optional(),
    walletAddress: z.string().regex(ETH_ADDRESS_RE, "invalid Ethereum address").optional(),
    tradingFrequency: z.enum(["daily", "weekly", "monthly", "rarely", "new"]).optional(),
    useCase: z.string().trim().min(1).max(280).optional(),
    referral: z.string().trim().min(1).max(120).optional(),
    /** Explicit consent to be contacted about the beta; timestamp recorded. */
    consent: z.literal(true),
    /** Honeypot: humans never see or fill this field (accepted, then dropped). */
    website: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.email || b.walletAddress), {
    message: "an email or a wallet address is required",
  });

export const registerWaitlistRoutes = (app: FastifyInstance, deps: WaitlistRoutesDeps): void => {
  const burstLimit = makeRateLimit({ scope: "waitlist", limit: 5, windowMs: 60_000 });
  const dailyLimit = makeRateLimit({
    scope: "waitlist-daily",
    limit: 20,
    windowMs: 24 * 60 * 60 * 1000,
  });

  app.post("/api/waitlist", { preHandler: [burstLimit, dailyLimit] }, async (req, reply) => {
    const parsed = WaitlistBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: "consent and an email or wallet address are required",
      };
    }
    const body = parsed.data;

    // Honeypot tripped: report success without storing so bots learn nothing.
    if (body.website !== undefined && body.website.length > 0) {
      return { ok: true, status: "waiting" };
    }

    const row = await deps.waitlist.submit({
      email: body.email ?? null,
      socialHandle: body.socialHandle ?? null,
      walletAddress: body.walletAddress?.toLowerCase() ?? null,
      tradingFrequency: body.tradingFrequency ?? null,
      useCase: body.useCase ?? null,
      referral: body.referral ?? null,
      consentAt: new Date(),
    });

    await deps.auditStore.emit({
      actor: body.walletAddress?.toLowerCase() ?? `anon:${req.ip}`,
      action: "waitlist.joined",
      subject: `waitlist:${row.id}`,
      metadata: { status: row.status },
    });

    return { ok: true, status: row.status };
  });
};
