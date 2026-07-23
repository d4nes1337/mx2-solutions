import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { NewAuditEvent } from "@mx2/core";
import type { AuditStore, WaitlistEntryRow, WaitlistStore } from "@mx2/db";
import { resetRateLimits } from "../middleware/rate-limit.js";
import { registerWaitlistRoutes } from "./waitlist.js";

const makeRow = (email: string | null): WaitlistEntryRow => ({
  id: "w-1",
  email,
  socialHandle: null,
  walletAddress: null,
  tradingFrequency: null,
  useCase: null,
  referral: null,
  consentAt: new Date(),
  status: "waiting",
  createdAt: new Date(),
  updatedAt: new Date(),
});

const build = () => {
  const submits: Parameters<WaitlistStore["submit"]>[0][] = [];
  const audits: NewAuditEvent[] = [];
  const waitlist: WaitlistStore = {
    submit: async (entry) => {
      submits.push(entry);
      return makeRow(entry.email);
    },
    list: async () => [],
    findById: async () => null,
    updateStatus: async () => null,
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
  registerWaitlistRoutes(app, { auditStore, waitlist });
  return { app, submits, audits };
};

const VALID = {
  email: "Trader@Example.com",
  socialHandle: "@trader",
  tradingFrequency: "weekly",
  useCase: "dip buys on election markets",
  consent: true,
};

beforeEach(() => resetRateLimits());

describe("POST /api/waitlist", () => {
  it("stores a valid submission (email lowercased) and audits without the email", async () => {
    const { app, submits, audits } = build();
    const res = await app.inject({ method: "POST", url: "/api/waitlist", payload: VALID });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: "waiting" });
    expect(submits).toHaveLength(1);
    expect(submits[0]!.email).toBe("trader@example.com");
    expect(submits[0]!.consentAt).toBeInstanceOf(Date);
    const joined = audits.find((a) => a.action === "waitlist.joined");
    expect(joined).toBeDefined();
    // PII posture: the email must never appear in audit records.
    expect(JSON.stringify(joined)).not.toContain("example.com");
    await app.close();
  });

  it("requires consent and at least an email or a wallet", async () => {
    const { app, submits } = build();
    const noConsent = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { ...VALID, consent: false },
    });
    expect(noConsent.statusCode).toBe(400);
    const badEmail = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { ...VALID, email: "not-an-email" },
    });
    expect(badEmail.statusCode).toBe(400);
    const neither = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { consent: true },
    });
    expect(neither.statusCode).toBe(400);
    expect(submits).toHaveLength(0);
    await app.close();
  });

  it("accepts a wallet-only join (no email)", async () => {
    const { app, submits } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: {
        walletAddress: "0x00000000000000000000000000000000000000AA",
        consent: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(submits).toHaveLength(1);
    expect(submits[0]!.email).toBeNull();
    expect(submits[0]!.walletAddress).toBe("0x00000000000000000000000000000000000000aa");
    await app.close();
  });

  it("rejects unknown fields (strict schema)", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { ...VALID, isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("silently drops honeypot submissions", async () => {
    const { app, submits, audits } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { ...VALID, website: "https://spam.example" },
    });
    // Bots see the same success a human would.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(submits).toHaveLength(0);
    expect(audits).toHaveLength(0);
    await app.close();
  });

  it("rate limits repeat submissions per IP", async () => {
    const { app } = build();
    for (let i = 0; i < 5; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/api/waitlist",
        payload: { ...VALID, email: `t${i}@example.com` },
      });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/waitlist", payload: VALID });
    expect(blocked.statusCode).toBe(429);
    await app.close();
  });
});
