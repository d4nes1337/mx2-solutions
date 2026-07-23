import { describe, expect, it } from "vitest";
import type { AllowlistStore, SessionRow, SessionStore } from "@mx2/db";
import { enforceAllowlistOnSessions } from "./allowlist-sessions.js";

const row = (userWallet: string): SessionRow => ({
  id: "s-1",
  userWallet,
  tokenHash: "th",
  expiresAt: new Date(Date.now() + 60_000),
  scope: null,
  createdAt: new Date(),
  revokedAt: null,
});

const makeSessions = (found: SessionRow | null): SessionStore => ({
  create: async () => row("0xabc"),
  findByTokenHash: async () => found,
  revoke: async () => {},
  revokeAllForWallet: async () => 0,
});

const makeAllowlist = (allowed: Set<string>): AllowlistStore => ({
  isAllowed: async (w) => allowed.has(w),
  findEntry: async () => null,
  add: async () => {
    throw new Error("not used");
  },
  remove: async () => {},
});

describe("enforceAllowlistOnSessions", () => {
  it("passes sessions of allowlisted wallets through", async () => {
    const wrapped = enforceAllowlistOnSessions(
      makeSessions(row("0xaa")),
      makeAllowlist(new Set(["0xaa"])),
    );
    expect(await wrapped.findByTokenHash("th")).toMatchObject({ userWallet: "0xaa" });
  });

  it("invalidates sessions the moment the wallet loses beta access", async () => {
    const wrapped = enforceAllowlistOnSessions(makeSessions(row("0xaa")), makeAllowlist(new Set()));
    expect(await wrapped.findByTokenHash("th")).toBeNull();
  });

  it("does not consult the allowlist for unknown tokens", async () => {
    let asked = 0;
    const allowlist: AllowlistStore = {
      ...makeAllowlist(new Set()),
      isAllowed: async () => {
        asked += 1;
        return true;
      },
    };
    const wrapped = enforceAllowlistOnSessions(makeSessions(null), allowlist);
    expect(await wrapped.findByTokenHash("missing")).toBeNull();
    expect(asked).toBe(0);
  });

  it("passes non-lookup methods through unchanged", async () => {
    let revoked: string | null = null;
    const sessions: SessionStore = {
      ...makeSessions(null),
      revokeAllForWallet: async (w) => {
        revoked = w;
        return 3;
      },
    };
    const wrapped = enforceAllowlistOnSessions(sessions, makeAllowlist(new Set()));
    expect(await wrapped.revokeAllForWallet("0xaa")).toBe(3);
    expect(revoked).toBe("0xaa");
  });
});
