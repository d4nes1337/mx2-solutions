import { describe, expect, it } from "vitest";
import type { AllowlistStore, SessionRow, SessionStore } from "@mx2/db";
import { enforceAccessRevocationOnSessions } from "./allowlist-sessions.js";

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

const makeAllowlist = (revoked: Set<string>): AllowlistStore => ({
  isRevoked: async (w) => revoked.has(w),
  findEntry: async () => null,
  add: async () => {
    throw new Error("not used");
  },
  remove: async () => {},
});

describe("enforceAccessRevocationOnSessions", () => {
  it("passes a session through when the wallet is not revoked", async () => {
    const wrapped = enforceAccessRevocationOnSessions(
      makeSessions(row("0xaa")),
      makeAllowlist(new Set()),
    );
    expect(await wrapped.findByTokenHash("th")).toMatchObject({ userWallet: "0xaa" });
  });

  // The regression this file exists for: access is open, so a wallet with no
  // access record at all must NOT have its requests 401'd.
  it("passes through a wallet that has no access record", async () => {
    const wrapped = enforceAccessRevocationOnSessions(
      makeSessions(row("0xnever-seen")),
      makeAllowlist(new Set(["0xsomeone-else"])),
    );
    expect(await wrapped.findByTokenHash("th")).toMatchObject({ userWallet: "0xnever-seen" });
  });

  it("invalidates sessions the moment a wallet is revoked", async () => {
    const wrapped = enforceAccessRevocationOnSessions(
      makeSessions(row("0xaa")),
      makeAllowlist(new Set(["0xaa"])),
    );
    expect(await wrapped.findByTokenHash("th")).toBeNull();
  });

  it("does not consult the access record for unknown tokens", async () => {
    let asked = 0;
    const allowlist: AllowlistStore = {
      ...makeAllowlist(new Set()),
      isRevoked: async () => {
        asked += 1;
        return false;
      },
    };
    const wrapped = enforceAccessRevocationOnSessions(makeSessions(null), allowlist);
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
    const wrapped = enforceAccessRevocationOnSessions(sessions, makeAllowlist(new Set()));
    expect(await wrapped.revokeAllForWallet("0xaa")).toBe(3);
    expect(revoked).toBe("0xaa");
  });
});
