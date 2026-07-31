import type { AllowlistStore, SessionStore } from "@mx2/db";

/**
 * Wraps the session store so an admin revocation cuts a wallet's live sessions
 * on the very next request instead of at session expiry.
 *
 * Access is OPEN: this used to require an *active allowlist row* and returned
 * null for anything else, so a wallet that was simply never allowlisted had
 * every authenticated request 401 — including mid-flow, between signing an
 * order and submitting it. Now only an explicit revocation invalidates a
 * session; an unknown wallet passes through.
 *
 * Every auth gate — full and scoped, across all route modules — resolves
 * sessions through `findByTokenHash`, so this stays the single request-time
 * enforcement point for bans.
 *
 * Cost: one indexed primary-key lookup per authenticated request — fine at
 * beta scale. If it ever shows up in traces, add a short in-process TTL cache
 * here (single choke point) rather than at call sites.
 */
export const enforceAccessRevocationOnSessions = (
  sessions: SessionStore,
  allowlist: AllowlistStore,
): SessionStore => ({
  ...sessions,
  async findByTokenHash(tokenHash) {
    const session = await sessions.findByTokenHash(tokenHash);
    if (!session) return null;
    const revoked = await allowlist.isRevoked(session.userWallet);
    return revoked ? null : session;
  },
});
