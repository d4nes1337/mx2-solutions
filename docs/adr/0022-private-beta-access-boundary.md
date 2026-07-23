# ADR-0022 — Private-beta access boundary: waitlist, one-time invitations, request-time enforcement

- **Status:** Accepted (owner-approved plan, 2026-07-23; Slice 1 of the private-beta release brief)
- **Date:** 2026-07-23
- **Decision id:** D-045

## Context

The brief (`docs/plans/ARIMA_PRIVATE_BETA_RELEASE_BRIEF.md` §4) replaces the binary
allowlist-at-login model with: public draft/simulate surfaces, a waitlist, one-time invitation
codes, and backend-enforced invite gating with immediate revocation. Before this change the
allowlist was consulted exactly once (login); a session outlived allowlist revocation, and no
waitlist/invite infrastructure existed.

## Decision

1. **The allowlist table remains the single source of "may hold a session".** Invitations sit on
   top: redemption `allowlist.add`s the wallet with provenance `invite:<id>`. Existing active
   allowlist rows are grandfathered untouched (owner decision Q1) — no migration action needed.
2. **Invitation codes mirror the sign-link token posture:** 128-bit random, `arima-` prefixed,
   shown exactly once at mint; only `SHA256(code)` is stored (`invitations.code_hash` unique).
   Redemption is one atomic `UPDATE … WHERE redeemed_at IS NULL AND revoked_at IS NULL AND
expires_at > now()` binding the code to the **signature-verified** wallet inside
   `POST /api/auth/verify` — a client can never redeem for a different wallet, and a replay by
   the same wallet is an idempotent success (mid-login retry safety). All outcomes are audited
   (`invite.redeemed` / `invite.redemption_rejected`).
3. **Request-time enforcement lives in ONE choke point:** `enforceAllowlistOnSessions` wraps the
   session store inside `buildApp`, so every auth gate (full and scoped, all route modules)
   treats a session as valid only while its wallet keeps an active allowlist row. Revoking an
   invitation also `allowlist.remove`s the redeeming wallet and revokes all its sessions
   (`SessionStore.revokeAllForWallet`) — cut-off is immediate, satisfying brief §4.4, and this
   closes the pre-existing "revoked allowlist keeps live session" gap.
4. **Waitlist is deliberately tiny (owner decisions, 2026-07-23 mid-review):** joining needs an
   email OR a connected wallet (or both) plus an explicit consent checkbox with a minimal privacy
   note; the remaining profile fields (handle, frequency, use case, referral) stay in the schema
   and API as optional enrichment but are not in the form. The waitlist UI is a **global pop-up**
   (`WaitlistModal` in AppChrome, `waitlist-ui` zustand store, funds-ui pattern); `/waitlist`
   is a deep link that opens the modal over the home page. Email is nullable with a plain UNIQUE
   (multiple NULLs fine); wallet-only entries dedupe in the store.
5. **Owner tooling:** `POST/GET /api/admin/invitations` + `/:id/revoke` + `GET /api/admin/waitlist`
   behind the existing `x-admin-secret` header, hardened with `timingSafeEqual`. Codes are never
   listed after mint. Email sending stays manual for the first cohort (brief §4.3.4).
6. **`FEATURE_OPEN_BETA` stays as an explicit future decision** (default false, branch intact,
   local launch config flipped to false); it is no longer the deployment assumption.

## Consequences

- Public surfaces (drafting, simulation, AI with existing limits, markets, waitlist) work
  signed-out; every private surface fails closed at the API even for stale sessions.
- One extra indexed PK lookup per authenticated request (allowlist re-check) — negligible at
  5–10 users; if it ever matters, add a short TTL cache inside the wrapper (single choke point).
- Enumeration resistance comes from 128-bit codes + the wallet-signature requirement on the
  redemption path (each attempt costs a signed challenge) + audit on every rejection; the
  in-memory per-IP limiter additionally brakes the public waitlist route (5/min + 20/day).
- PII footprint: email/handle live only in `waitlist_entries` (admin-gated reads); never in
  logs or audit metadata (asserted by tests). Deletion on request is a manual owner action for
  the beta; full ToS/privacy/risk documents are required before Stage C (R-047).
- Migration `0021` is additive; rollback = drop the two tables (documented in the SQL header).

## Verification (2026-07-23, local live run)

Scripted EIP-712 wallet against the running API + Postgres: unknown wallet → 403 with
waitlist/invite hints; waitlist join 200 (email, wallet-only, and neither→400 variants);
DB-seeded invite redemption → session; private routes 401 without session; same code rejected
for a second wallet (`INVITE_INVALID`); allowlist deactivation kills the live session on the
next request. Browser: pop-up waitlist submits end-to-end (POST 200 → success state), deep link
`/waitlist` opens the modal over home. Suites: 759 root + 295 web tests green, typecheck/lint/
format clean.
