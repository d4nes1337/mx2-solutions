import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { loadConfig } from "@mx2/config";
import type { NewAuditEvent } from "@mx2/core";
import type {
  AllowlistStore,
  AuditStore,
  InvitationRow,
  InvitationStore,
  SessionStore,
  WaitlistStore,
} from "@mx2/db";
import { hashInviteCode } from "../auth/invite-code.js";
import { registerAdminInvitesRoutes } from "./admin-invites.js";

const SECRET = "test-admin-secret-16chars";
const WALLET = "0x00000000000000000000000000000000000000aa";

const makeRow = (over: Partial<InvitationRow> = {}): InvitationRow => ({
  id: "inv-1",
  codeHash: "hash-1",
  issuedBy: "admin:owner",
  note: null,
  waitlistEntryId: null,
  expiresAt: new Date(Date.now() + 60_000),
  redeemedBy: null,
  redeemedAt: null,
  revokedAt: null,
  revokedBy: null,
  createdAt: new Date(),
  ...over,
});

const build = (opts: { secret?: boolean; revokeRow?: InvitationRow | null } = {}) => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    ...(opts.secret === false ? {} : { TRADING_ADMIN_SECRET: SECRET }),
  });
  const audits: NewAuditEvent[] = [];
  const creates: Parameters<InvitationStore["create"]>[0][] = [];
  const removed: string[] = [];
  const revokedWallets: string[] = [];
  const waitlistStatusCalls: { id: string; status: string }[] = [];

  const invitations: InvitationStore = {
    create: async (o) => {
      creates.push(o);
      return makeRow({ codeHash: o.codeHash, note: o.note, expiresAt: o.expiresAt });
    },
    findById: async (id) => (id === "inv-1" ? makeRow({ revokedAt: new Date() }) : null),
    findByCodeHash: async () => null,
    redeem: async () => ({ outcome: "rejected", reason: "not_found" }),
    revoke: async () => opts.revokeRow ?? null,
    list: async () => [makeRow()],
  };
  const waitlist: WaitlistStore = {
    submit: async () => {
      throw new Error("not used");
    },
    list: async () => [],
    findById: async (id) =>
      id === "0f000000-0000-4000-8000-000000000ce1"
        ? {
            id: "0f000000-0000-4000-8000-000000000ce1",
            email: "t@example.com",
            socialHandle: null,
            walletAddress: null,
            tradingFrequency: null,
            useCase: null,
            referral: null,
            consentAt: new Date(),
            status: "waiting",
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
    updateStatus: async (id, status) => {
      waitlistStatusCalls.push({ id, status });
      return null;
    },
  };
  const allowlist: AllowlistStore = {
    isRevoked: async () => false,
    findEntry: async () => null,
    add: async () => {
      throw new Error("not used");
    },
    remove: async (w) => {
      removed.push(w);
    },
  };
  const sessions: SessionStore = {
    create: async () => {
      throw new Error("not used");
    },
    findByTokenHash: async () => null,
    revoke: async () => {},
    revokeAllForWallet: async (w) => {
      revokedWallets.push(w);
      return 2;
    },
  };
  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push(e);
      return { ...e, subject: e.subject ?? null, id: "a-1", createdAt: new Date() };
    },
    recent: async () => [],
    forActor: async () => [],
    forSubject: async () => [],
  };

  const app = Fastify({ logger: false });
  registerAdminInvitesRoutes(app, {
    config,
    auditStore,
    invitations,
    waitlist,
    allowlist,
    sessions,
  });
  return { app, audits, creates, removed, revokedWallets, waitlistStatusCalls };
};

const H = { "x-admin-secret": SECRET, "x-admin-actor": "owner" };

describe("admin invitations", () => {
  it("503s when no admin secret is configured and 401s on a wrong secret", async () => {
    const { app: noSecret } = build({ secret: false });
    const res1 = await noSecret.inject({ method: "POST", url: "/api/admin/invitations" });
    expect(res1.statusCode).toBe(503);
    await noSecret.close();

    const { app } = build();
    const res2 = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { "x-admin-secret": "wrong-secret-000000" },
    });
    expect(res2.statusCode).toBe(401);
    await app.close();
  });

  it("mints a code, stores only its hash, audits, and marks the waitlist entry invited", async () => {
    const { app, creates, audits, waitlistStatusCalls } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: H,
      payload: {
        expiresInDays: 7,
        note: "first cohort",
        waitlistEntryId: "0f000000-0000-4000-8000-000000000ce1",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; code: string };
    expect(body.code).toMatch(/^arima-[0-9a-f]{32}$/);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.codeHash).toBe(hashInviteCode(body.code));
    expect(creates[0]!.codeHash).not.toContain(body.code);
    expect(waitlistStatusCalls).toEqual([
      { id: "0f000000-0000-4000-8000-000000000ce1", status: "invited" },
    ]);
    const created = audits.find((a) => a.action === "invite.created");
    expect(created).toBeDefined();
    // The raw code must never reach the audit trail.
    expect(JSON.stringify(created)).not.toContain(body.code);
    await app.close();
  });

  it("404s minting against an unknown waitlist entry", async () => {
    const { app, creates } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: H,
      payload: { waitlistEntryId: "0f000000-0000-4000-8000-00000000dead" },
    });
    expect(res.statusCode).toBe(404);
    expect(creates).toHaveLength(0);
    await app.close();
  });

  it("lists invitations without exposing code hashes", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/api/admin/invitations", headers: H });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("hash-1");
    await app.close();
  });

  it("revoking a redeemed invitation removes beta access and cuts every session", async () => {
    const { app, removed, revokedWallets, audits } = build({
      revokeRow: makeRow({
        redeemedBy: WALLET,
        redeemedAt: new Date(),
        revokedAt: new Date(),
        revokedBy: "admin:owner",
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/invitations/inv-1/revoke",
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sessionsRevoked: 2 });
    expect(removed).toEqual([WALLET]);
    expect(revokedWallets).toEqual([WALLET]);
    expect(audits.map((a) => a.action)).toContain("invite.revoked");
    await app.close();
  });

  it("revoke is idempotent and 404s unknown invitations", async () => {
    const { app, removed } = build({ revokeRow: null });
    const already = await app.inject({
      method: "POST",
      url: "/api/admin/invitations/inv-1/revoke",
      headers: H,
    });
    expect(already.statusCode).toBe(200);
    expect(already.json()).toMatchObject({ ok: true, sessionsRevoked: 0 });
    expect(removed).toHaveLength(0);

    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/invitations/inv-unknown/revoke",
      headers: H,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
