import type { AllowlistStore, SessionStore } from "@mx2/db";

/**
 * Wraps the session store so a session is only valid while its wallet keeps
 * beta access (an active allowlist row). Every auth gate — full and scoped,
 * across all route modules — resolves sessions through `findByTokenHash`, so
 * this is the single request-time enforcement point the private beta needs:
 * revoking a wallet (invite revocation, allowlist removal) cuts off its live
 * sessions on the very next request instead of at session expiry (brief §4.4).
 *
 * Cost: one indexed primary-key lookup per authenticated request — fine at
 * beta scale (D-001 single process, 5–10 users). The extra query is on the
 * allowlist PK; if it ever shows up in traces, add a short in-process TTL
 * cache here (single choke point) rather than at call sites.
 */
export const enforceAllowlistOnSessions = (
  sessions: SessionStore,
  allowlist: AllowlistStore,
): SessionStore => ({
  ...sessions,
  async findByTokenHash(tokenHash) {
    const session = await sessions.findByTokenHash(tokenHash);
    if (!session) return null;
    const allowed = await allowlist.isAllowed(session.userWallet);
    return allowed ? session : null;
  },
});
