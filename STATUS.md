# Project Status

_Last updated: 2026-06-23_

## Current gate

Gate 4 — manual trading: **built** (quality gates green). Next: **Gate 4 owner review**.

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
- **Slice 3 — manual trading backend infrastructure (built).** Geoblock client (fail-closed,
  60s cache, `close_only` detection); AES-256-GCM per-user L2 CLOB credential encryption;
  three new DB tables (`user_clob_credentials`, `order_intents`, `runtime_flags`) + migration
  `0004_previous_ezekiel_stane.sql`; `AuthenticatedClobClient` (L2 HMAC, derive, balance,
  submit, cancel, open orders); trading routes (`GET /api/trade/status`,
  `POST /api/trade/credentials/setup`, `GET /api/trade/account`,
  `POST /api/trade/orders/preview`, `POST /api/trade/orders`, `DELETE /api/trade/orders/:id`,
  `GET /api/trade/orders`); admin kill-switch routes (`POST /api/admin/trading/pause`,
  `POST /api/admin/trading/resume`, `GET /api/admin/trading/status`); geoblock middleware;
  `APP_ENCRYPTION_MASTER_KEY` + `TRADING_ADMIN_SECRET` env vars. Quality gates: `format`,
  `lint` (0), `typecheck`, `test` (93/93).

## In progress

- **Gate 4 review:** owner acceptance of Slice 3 deliverables below.

## Blocked / owner input required

- **Staging CLOB credentials:** owner needs CLOB API credentials for a test wallet to prove
  the full end-to-end flow (credential derivation → balance → preview → sign → submit → cancel).
  This is an owner action: log into Polymarket with a test wallet, obtain L2 CLOB API key via
  `POST /api/trade/credentials/setup`, fund with a small pUSD amount on Polygon.
- **A-021 spike (ERC-7739 signing):** the client-side ERC-7739-wrapped order signing has NOT been
  proven in-browser yet. This is the critical path for a real staging trade. The backend accepts
  the signature field — what the frontend must produce is documented in the order preview response.
- **Legal sign-off** still advised before enabling **live** trading (Gate 4 live); does not block
  read-only or staging build work.
- **Allowlist seeding (Gate 3 prerequisite):** owner must add at least one test wallet address:
  `INSERT INTO allowlist (wallet_address, added_by, is_active) VALUES ('0x...', 'owner', true);`

## Gate 4 acceptance checklist (owner review)

- [ ] `pnpm db:migrate` applies migration `0004_previous_ezekiel_stane.sql` cleanly.
- [ ] `GET /api/trade/status` returns `{ tradingEnabled: false, featureFlag: false, geoblock: { status: "allowed"|"blocked" } }`.
- [ ] `POST /api/trade/credentials/setup` returns 401 without session cookie.
- [ ] `POST /api/trade/orders/preview` returns 401 without cookie, 403 from blocked IP, 200 with valid body.
- [ ] `POST /api/trade/orders` returns 503 `TRADING_DISABLED` (feature flag is off by default).
- [ ] `POST /api/admin/trading/pause` with `x-admin-secret` header returns `{ ok: true, tradingPaused: true }`.
- [ ] `POST /api/trade/orders` after pause returns 503 `TRADING_PAUSED`.
- [ ] `POST /api/admin/trading/resume` lifts kill switch; `GET /api/trade/status` shows `tradingEnabled=false` (flag still off).
- [ ] All 93 tests pass: `pnpm test`.
- [ ] `pnpm run format:check && pnpm run lint && pnpm run typecheck` all exit 0.
- [ ] (Staging, owner action) Credentials setup → account balance → order preview → sign (external) → submit → cancel all work end-to-end on staging CLOB.

## Next checkpoint

**Gate 5 — Slice 4:** conditional rules shadow mode (rule builder, state machine, evidence, deterministic replay, manual-confirm path).

## Delivery roadmap

| Slice                                                  | Gate   | Status    | Blocked by                                        |
| ------------------------------------------------------ | ------ | --------- | ------------------------------------------------- |
| 0 — scaffolding/CI/health/flags/audit skeleton         | —      | **Built** | —                                                 |
| 1 — read-only feed + market cockpit                    | Gate 2 | **Built** | —                                                 |
| 2 — wallet login + allowlist + profile/PnL (read-only) | Gate 3 | **Built** | Owner Gate 3 review                               |
| 3 — manual trading (staging-only, geo-gated, flagged)  | Gate 4 | **Built** | Owner Gate 4 review + staging creds + A-021 spike |
| 4 — conditional rules shadow mode                      | Gate 5 | Pending   | Gate 4                                            |
| 5 — beta hardening / release                           | Gate 6 | Pending   | prior slices                                      |
