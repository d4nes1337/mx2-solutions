# Project Status

_Last updated: 2026-06-22_

## Current gate

Gate 3 — identity + portfolio: **built** (quality gates green). Next: **Gate 3 owner review**.

## Completed

- Product and MVP brief reviewed; full requirements kit read.
- Polymarket integration verified against primary sources → `docs/INTEGRATION_VERIFIED.md`.
- Architecture options + recommendation → `docs/adr/0001-architecture-and-stack.md`.
- Wallet/signing path → `docs/adr/0002-wallet-and-signing-path.md`.
- Auth + session design → `docs/adr/0003-auth-and-session-design.md`.
- Assumptions register → `docs/ASSUMPTIONS.md`.
- Repository initialised and synced to `origin/main`; requirements kit kept as gitignored inbox.
- Owner decisions captured (geo, trading scope, wallet path, repo layout, builderCode) → `DECISIONS.md`.
- **Slice 0 — backend scaffolding.** pnpm monorepo, Fastify health/readiness/feature-flag endpoints,
  Zod config with fail-closed flags, pino logging with secret redaction, Drizzle `audit_events`
  append-only table + migration, ESLint module-boundary rules, Vitest, GitHub Actions CI,
  docker-compose Postgres. Quality gates: `format`, `lint` (0), `typecheck`, `test` (11/11).
- **Slice 1 — read-only feed + market cockpit (built).** `packages/polymarket-client`: typed Gamma
  REST + CLOB REST adapters + Market WebSocket client with stale/reconnect handling; `market_snapshots`
  DB table (UPSERT, staleness flag); API routes `GET /api/events`, `/api/events/:id`,
  `/api/markets/:id`, `/api/markets/:id/orderbook`, `/api/markets/:id/prices-history`; Worker WS
  ingestion → DB snapshots; contract tests + schema tests. Quality gates: `format`, `lint` (0),
  `typecheck`, `test` (35/35), `db:generate` (migration `0001_black_thing.sql`).
- **Slice 2 — wallet login + allowlist + portfolio/PnL (built).** EIP-712 challenge-response
  login (viem `recoverTypedDataAddress`); DB-backed httpOnly sessions (SHA256-hashed token);
  allowlist gating with `allowlist.checked` + `auth.login` audit events; Data API client
  (`packages/polymarket-client`): `DataClient` for positions + activity; API routes
  `GET /api/auth/challenge`, `POST /api/auth/verify`, `POST /api/auth/logout`, `GET /api/auth/me`,
  `GET /api/profile/positions`, `GET /api/profile/history`, `GET /api/profile/pnl` (with embedded
  methodology + limitations); four new DB tables + migration `0002_cultured_dragon_man.sql`;
  `AppConfig.session` (TTL, cookieSecure). Quality gates: `format`, `lint` (0), `typecheck`,
  `test` (49/49), `db:generate` (migration `0002_...sql`).

## In progress

- **Gate 3 review:** owner acceptance of Slice 2 deliverables below.

## Blocked / owner input required

- **Allowlist seeding:** owner must add at least one test wallet address before Gate 3 demo:
  `INSERT INTO allowlist (wallet_address, added_by, is_active) VALUES ('0x...', 'owner', true);`
- **Legal sign-off** still advised before enabling **live** trading (Gate 4); does not block
  read-only or staging build work.

## Gate 3 acceptance checklist (owner review)

- [ ] `pnpm db:migrate` applies migration `0002_cultured_dragon_man.sql` cleanly (3 new migrations total).
- [ ] `GET /api/auth/challenge?address=0x<wallet>` returns a `typedData` object to sign.
- [ ] `POST /api/auth/verify` with valid EIP-712 signature from allowlisted wallet sets `mx2_session` cookie and returns `{ ok: true, address }`.
- [ ] `POST /api/auth/verify` from a non-allowlisted wallet returns 403 `NOT_ALLOWLISTED`.
- [ ] `GET /api/auth/me` with session cookie returns `{ address, allowlisted: true }`.
- [ ] `GET /api/profile/positions`, `/history`, `/pnl` all return 401 without session cookie.
- [ ] `GET /api/profile/pnl` with session returns response with `summary`, `methodology`, and `limitations` fields.
- [ ] All 49 tests pass: `pnpm test`.
- [ ] `pnpm run format:check && pnpm run lint && pnpm run typecheck` all exit 0.

## Next checkpoint

**Gate 4 — Slice 3:** manual trading (staging-only, geo-gated, CLOB L2 credentials + relayer).

## Delivery roadmap

| Slice                                                  | Gate   | Status    | Blocked by                                           |
| ------------------------------------------------------ | ------ | --------- | ---------------------------------------------------- |
| 0 — scaffolding/CI/health/flags/audit skeleton         | —      | **Built** | —                                                    |
| 1 — read-only feed + market cockpit                    | Gate 2 | **Built** | —                                                    |
| 2 — wallet login + allowlist + profile/PnL (read-only) | Gate 3 | **Built** | Owner Gate 3 review                                  |
| 3 — manual trading (staging-only, geo-gated, flagged)  | Gate 4 | Pending   | integration spike + security review + legal sign-off |
| 4 — conditional rules shadow mode                      | Gate 5 | Pending   | Slice 2                                              |
| 5 — beta hardening / release                           | Gate 6 | Pending   | prior slices                                         |
