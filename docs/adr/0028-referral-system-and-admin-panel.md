# ADR-0028 — Referral system, wallet-session admin panel, and public volume stats

- Status: Built (2026-07-28)
- Owner decision: approved 2026-07-28 (plan `i-need-you-to-sprightly-corbato`); four
  explicit choices recorded below

## Context

The private beta gated access with a manually seeded allowlist plus admin-minted,
single-use, SHA-256-hashed invitation codes (ADR era: migration 0021) managed over curl
with `x-admin-secret`. The owner wants the Lighter-style growth loop: access gated by
referral codes users can hand to friends/communities, an admin panel to issue/track codes
and caps, and per-user traded volume — internal columns, an in-app public leaderboard, and
a publicly verifiable Dune dashboard. Reference products reviewed: Hyperliquid (open
access; one vanity code per user, plaintext, attribution + fee share), Lighter
(invite-gated beta, quota-limited invites), friend.tech/Blur (scarcity invites).

## Decision

1. **Code model — one personal multi-use code per user with an admin-set seat cap.**
   Every allowlisted user gets an auto-generated 6-char code
   (alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, no 0/O/1/I/L) with
   `REFERRAL_DEFAULT_MAX_USES` (5) seats; the cap is the per-user "how many can they
   invite" knob, editable per code in the panel. Admin can additionally mint **vanity/VIP
   codes** (`ANSEM`) assigned to a wallet, and unassigned campaign codes. Schema:
   `referral_codes` + `referral_redemptions` (migration 0022); a wallet can be referred
   exactly once ever (`UNIQUE wallet_address`) — revoked users cannot re-enter through a
   second code, and attribution stays unambiguous.
2. **Plaintext codes — a deliberate posture change from the hashed invitations.**
   Referral codes are shareable marketing handles that must stay re-displayable in the
   profile and admin panel (every reference product stores them plaintext). Brute-force
   is mitigated by: 20/min-per-IP rate limit on `/api/auth/verify`, per-code seat caps,
   `referral.redemption_rejected` audit events, and revocability — a guessed code buys at
   most one capped, revocable beta seat, never funds or keys. Legacy hashed invitations
   keep redeeming through the same input field (referral lookup first, hash fallback).
3. **Admin panel auth — wallet session + `ADMIN_WALLET_ADDRESSES` env allowlist.**
   `/api/admin/panel/*` (codes, users, waitlist, overview) requires a full wallet session
   whose EOA is in the configured set; every action is audited with `admin:<wallet>` as
   the actor. The `x-admin-secret` curl endpoints remain unchanged as the
   emergency/script path. An empty admin set fails closed.
4. **Volume — worker rollups + public surfaces.** Hourly `volume-sync` worker loop pulls
   Data API `/activity` TRADE rows per user (proxy wallet derived via
   `deriveDepositWallet`, cursor = newest counted timestamp, fail-under on the boundary)
   into `user_volume_daily` + `user_volume_stats`. Surfaces: admin users/codes columns,
   `GET /api/referrals/leaderboard` (public, 5-min cache, rate-limited) + `/leaderboard`
   page, and a daily `dune-push` job (only with `DUNE_API_KEY`) uploading the
   pseudonymous mapping `code → referee wallets` for an on-chain-verifiable dashboard
   (docs/dune/README.md).

Everything is behind `FEATURE_REFERRALS` (default off). Grandfathered wallets keep access
untouched and receive a personal code lazily at next login. No trading, key, or
geoblocking paths were modified.

## Consequences

- The seamless join flow is `/r/CODE` → localStorage → auto-attached to the next
  EIP-712 sign-in; no typing, and the manual field stays as fallback.
- Publishing the wallet↔code mapping to Dune is public attribution of pseudonymous
  addresses (owner accepted; only referred users' addresses, no PII).
- Rewards/fee-share is deliberately out of scope; the redemption edge table preserves the
  full referral tree so a rewards program can be added without re-attribution.
- Rollback: turn off `FEATURE_REFERRALS` (routes and loops vanish; allowlist keeps
  working), migration rollback documented in 0022 header; Dune table deletable via API.
