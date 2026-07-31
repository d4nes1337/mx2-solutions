import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { loadConfig } from "@mx2/config";
import type { NewAuditEvent } from "@mx2/core";
import type {
  AdminViewsStore,
  AllowlistStore,
  AuditStore,
  ReferralCodeRow,
  ReferralStore,
  SessionStore,
} from "@mx2/db";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { registerAdminPanelRoutes } from "./admin-panel.js";

const ADMIN = `0x${"a".repeat(40)}`;
const OUTSIDER = `0x${"b".repeat(40)}`;
const TARGET = `0x${"c".repeat(40)}`;

const codeRow = (over: Partial<ReferralCodeRow> = {}): ReferralCodeRow => ({
  id: "0f000000-0000-4000-8000-000000000001",
  code: "K7Q3D2",
  ownerWallet: TARGET,
  maxUses: 5,
  usedCount: 1,
  note: null,
  createdBy: "system:auto",
  expiresAt: null,
  disabledAt: null,
  disabledBy: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

const notUsed = () => {
  throw new Error("not used");
};

const buildApp = async (opts: {
  sessionWallet?: string;
  referrals?: Partial<ReferralStore>;
  allowlistRemoveCalls?: string[];
  sessionsRevoked?: { count: number };
  audits?: NewAuditEvent[];
}) => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    FEATURE_REFERRALS: "true",
    ADMIN_WALLET_ADDRESSES: ADMIN,
  });

  const sessions: SessionStore = {
    create: notUsed,
    findByTokenHash: async (tokenHash) =>
      opts.sessionWallet
        ? {
            id: "sess-1",
            userWallet: opts.sessionWallet,
            tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
            scope: null,
            createdAt: new Date(),
            revokedAt: null,
          }
        : null,
    revoke: async () => {},
    revokeAllForWallet: async () => {
      return opts.sessionsRevoked?.count ?? 0;
    },
  };

  const referrals: ReferralStore = {
    ensurePersonalCode: notUsed,
    redeem: notUsed,
    createCode: async ({ code, ownerWallet, maxUses, note, createdBy, expiresAt }) =>
      codeRow({
        code: code ? code.toUpperCase() : "GENER8",
        ownerWallet,
        maxUses,
        note,
        createdBy,
        expiresAt,
        usedCount: 0,
      }),
    findById: async () => null,
    findByCode: async () => null,
    codesForOwner: async () => [],
    setMaxUses: async () => null,
    setNote: async () => null,
    setDisabled: async () => null,
    reassignOwner: async () => null,
    list: async () => [codeRow()],
    redemptionsForCode: async () => [],
    redemptionForWallet: async () => null,
    listRedemptions: async () => [],
    ...opts.referrals,
  };

  const adminViews: AdminViewsStore = {
    listUsers: async () => [
      {
        walletAddress: TARGET,
        createdAt: new Date("2026-07-10T00:00:00Z"),
        lastSeenAt: new Date("2026-07-27T00:00:00Z"),
        allowlisted: true,
        allowlistAddedBy: "referral:xyz",
        referredByCode: "K7Q3D2",
        referrerWallet: ADMIN,
        referredAt: new Date("2026-07-10T00:00:00Z"),
        lifetimeVolumeUsd: "1234.56",
        tradeCount: 42,
        lastTradeAt: new Date("2026-07-26T00:00:00Z"),
      },
    ],
    codeStats: async () => [
      {
        codeId: "0f000000-0000-4000-8000-000000000001",
        refereeCount: 1,
        attributedVolumeUsd: "1234.56",
      },
    ],
    overview: async () => ({
      totalUsers: 3,
      allowlistedActive: 2,
      totalCodes: 1,
      seatsUsed: 1,
      seatsTotal: 5,
      redemptionsByDay: [{ day: "2026-07-10", count: 1 }],
    }),
  };

  const allowlist: AllowlistStore = {
    isRevoked: async () => false,
    findEntry: async () => null,
    add: async (walletAddress, addedBy, note) => ({
      walletAddress,
      addedBy,
      note,
      isActive: true,
      addedAt: new Date(),
      removedAt: null,
    }),
    remove: async (walletAddress) => {
      opts.allowlistRemoveCalls?.push(walletAddress);
    },
  };

  const auditStore: AuditStore = {
    emit: async (e) => {
      opts.audits?.push(e);
      return { ...e, subject: e.subject ?? null, id: "audit-1", createdAt: new Date() };
    },
    recent: async () => [],
    forActor: async () => [],
    forSubject: async () => [],
  };

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerAdminPanelRoutes(app, { config, sessions, auditStore, referrals, adminViews, allowlist });
  return app;
};

const asAdmin = { cookies: { [SESSION_COOKIE_NAME]: "tok" } };

describe("admin panel authz", () => {
  it("401s without a session", async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: "GET", url: "/api/admin/panel/overview" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a signed-in non-admin wallet", async () => {
    const app = await buildApp({ sessionWallet: OUTSIDER });
    const res = await app.inject({ method: "GET", url: "/api/admin/panel/overview", ...asAdmin });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("serves the overview to an admin wallet", async () => {
    const app = await buildApp({ sessionWallet: ADMIN });
    const res = await app.inject({ method: "GET", url: "/api/admin/panel/overview", ...asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalUsers: 3, seatsUsed: 1, seatsTotal: 5 });
    await app.close();
  });
});

describe("admin panel codes", () => {
  it("lists codes with referee counts and attributed volume", async () => {
    const app = await buildApp({ sessionWallet: ADMIN });
    const res = await app.inject({ method: "GET", url: "/api/admin/panel/codes", ...asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.json().codes[0]).toMatchObject({
      code: "K7Q3D2",
      refereeCount: 1,
      attributedVolumeUsd: "1234.56",
    });
    await app.close();
  });

  it("mints a vanity VIP code and audits it", async () => {
    const audits: NewAuditEvent[] = [];
    const app = await buildApp({ sessionWallet: ADMIN, audits });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/panel/codes",
      ...asAdmin,
      payload: { code: "ansem", ownerWallet: TARGET, maxUses: 50, note: "VIP" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatchObject({ code: "ANSEM", maxUses: 50 });
    expect(
      audits.some((a) => a.action === "referral.code_created" && a.actor === `admin:${ADMIN}`),
    ).toBe(true);
    await app.close();
  });

  it("rejects malformed vanity codes", async () => {
    const app = await buildApp({ sessionWallet: ADMIN });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/panel/codes",
      ...asAdmin,
      payload: { code: "AN SEM!", maxUses: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CODE");
    await app.close();
  });

  it("409s a duplicate vanity code", async () => {
    const app = await buildApp({
      sessionWallet: ADMIN,
      referrals: { findByCode: async () => codeRow({ code: "ANSEM" }) },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/panel/codes",
      ...asAdmin,
      payload: { code: "ANSEM", maxUses: 5 },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("patches the seat cap (the per-user quota knob)", async () => {
    const setCalls: { id: string; maxUses: number }[] = [];
    const app = await buildApp({
      sessionWallet: ADMIN,
      referrals: {
        findById: async () => codeRow(),
        setMaxUses: async (id, maxUses) => {
          setCalls.push({ id, maxUses });
          return codeRow({ maxUses });
        },
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/panel/codes/0f000000-0000-4000-8000-000000000001",
      ...asAdmin,
      payload: { maxUses: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code.maxUses).toBe(25);
    expect(setCalls).toEqual([{ id: "0f000000-0000-4000-8000-000000000001", maxUses: 25 }]);
    await app.close();
  });
});

describe("admin panel users", () => {
  it("lists users with referral attribution and volume", async () => {
    const app = await buildApp({ sessionWallet: ADMIN });
    const res = await app.inject({ method: "GET", url: "/api/admin/panel/users", ...asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.json().users[0]).toMatchObject({
      walletAddress: TARGET,
      referredByCode: "K7Q3D2",
      lifetimeVolumeUsd: "1234.56",
    });
    await app.close();
  });

  it("revokes access: allowlist off + sessions cut + audited", async () => {
    const removed: string[] = [];
    const audits: NewAuditEvent[] = [];
    const app = await buildApp({
      sessionWallet: ADMIN,
      allowlistRemoveCalls: removed,
      sessionsRevoked: { count: 2 },
      audits,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/panel/users/${TARGET}/revoke-access`,
      ...asAdmin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sessionsRevoked: 2 });
    expect(removed).toEqual([TARGET]);
    expect(audits.some((a) => a.action === "referral.access_revoked")).toBe(true);
    await app.close();
  });
});
