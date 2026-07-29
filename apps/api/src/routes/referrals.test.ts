import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { loadConfig } from "@mx2/config";
import type { ReferralCodeRow, ReferralStore, SessionStore } from "@mx2/db";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { registerReferralsRoutes } from "./referrals.js";

const WALLET = `0x${"a".repeat(40)}`;

const codeRow = (over: Partial<ReferralCodeRow> = {}): ReferralCodeRow => ({
  id: "0f000000-0000-4000-8000-000000000001",
  code: "K7Q3D2",
  ownerWallet: WALLET,
  maxUses: 5,
  usedCount: 2,
  note: null,
  createdBy: "system:auto",
  expiresAt: null,
  disabledAt: null,
  disabledBy: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

const sessions: SessionStore = {
  create: async () => {
    throw new Error("not used");
  },
  findByTokenHash: async (tokenHash) => ({
    id: "sess-1",
    userWallet: WALLET,
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
    scope: null,
    createdAt: new Date(),
    revokedAt: null,
  }),
  revoke: async () => {},
  revokeAllForWallet: async () => 0,
};

const buildApp = async (referrals: ReferralStore) => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    APP_BASE_URL: "https://app.example.test",
    FEATURE_REFERRALS: "true",
  });
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerReferralsRoutes(app, { config, sessions, referrals });
  return app;
};

const notUsed = () => {
  throw new Error("not used");
};

describe("GET /api/referrals/me", () => {
  it("401s without a session", async () => {
    const app = await buildApp({} as ReferralStore);
    const res = await app.inject({ method: "GET", url: "/api/referrals/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns owned codes with statuses, redemptions, and the share base", async () => {
    const ensured: string[] = [];
    const referrals: ReferralStore = {
      ensurePersonalCode: async (wallet) => {
        ensured.push(wallet);
        return codeRow();
      },
      codesForOwner: async () => [
        codeRow(),
        codeRow({
          id: "0f000000-0000-4000-8000-000000000002",
          code: "ANSEM",
          createdBy: "admin:owner",
          usedCount: 5,
          maxUses: 5,
        }),
      ],
      redemptionsForCode: async (codeId) =>
        codeId === "0f000000-0000-4000-8000-000000000001"
          ? [
              {
                id: "r1",
                codeId,
                walletAddress: `0x${"b".repeat(40)}`,
                referrerWallet: WALLET,
                redeemedAt: new Date("2026-07-20T12:00:00Z"),
              },
            ]
          : [],
      redemptionForWallet: async () => null,
      redeem: notUsed,
      createCode: notUsed,
      findById: async () => null,
      findByCode: async () => null,
      setMaxUses: async () => null,
      setNote: async () => null,
      setDisabled: async () => null,
      reassignOwner: async () => null,
      list: async () => [],
      listRedemptions: async () => [],
    };
    const app = await buildApp(referrals);
    const res = await app.inject({
      method: "GET",
      url: "/api/referrals/me",
      cookies: { [SESSION_COOKIE_NAME]: "tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(ensured).toEqual([WALLET]);
    expect(body.shareBaseUrl).toBe("https://app.example.test");
    expect(body.codes).toHaveLength(2);
    expect(body.codes[0]).toMatchObject({
      code: "K7Q3D2",
      status: "active",
      usedCount: 2,
      maxUses: 5,
    });
    expect(body.codes[0].redemptions).toEqual([
      { walletAddress: `0x${"b".repeat(40)}`, redeemedAt: "2026-07-20T12:00:00.000Z" },
    ]);
    expect(body.codes[1]).toMatchObject({ code: "ANSEM", status: "exhausted" });
    await app.close();
  });
});
