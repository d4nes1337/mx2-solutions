# Project Status

_Last updated: 2026-06-30_

## Recent

- **Home feed methodology + UI refresh (built).** Replaced the four-column raw-sort dashboard with
  three backend-ranked columns: **Now** (new + moving + resolving soon), **Top Markets** (deep,
  active, non-extreme overall markets), and **Favorites** suggestions with a stronger sign-in/watchlist
  prompt. New API routes: `GET /api/feed/home` and `GET /api/feed?kind=...`; ranking lives in
  `apps/api/src/feed/ranking.ts` with hard gates for 99/1 odds, nearly-ended markets, newborn
  no-liquidity markets, wide spreads, long horizons, duplicate event clusters, and tag over-concentration.
  The candidate pool uses Polymarket-like public signals (`competitive`, `volume_24hr`, `liquidity`,
  `start_date`, `end_date`) before applying stricter terminal quality filters. Tuning guide:
  `docs/FEED_TUNING.md`; ADR-0007; decision D-015. Quality gates: `format:check` ✓, `lint` ✓,
  root `typecheck` ✓, web `typecheck` ✓, root `test` **177 pass / 3 skipped**, web `test`
  **37 pass**. Live Gamma sample returned full 20-row `Now`, `Top Markets`, and Favorites-suggestion
  columns after applying the read-only `restricted` policy from D-004.

- **Server-side "sign once" trading + unattended conditional execution (built, behind flags).**
  Adopted **Privy embedded wallets + server session signers + in-enclave policy engine**
  (ADR-0006, RFC-0002) so users sign once and then trade — manual AND conditional — with no
  per-order popup. New signing seam `@mx2/trading-signer` (Privy adapter + mock for tests/dry-run);
  shared `buildAndSignEoaOrder` (`signatureType 0`) in `@mx2/polymarket-client`; new
  `privy_wallets` + `trading_delegations` tables (migration `0006`); `trading-wallet` routes
  (provision / delegate / status / revoke / bootstrap-allowances); `POST /api/trade/orders` gains
  a server-signing branch behind `FEATURE_PRIVY_SIGNING` (legacy browser path preserved when OFF).
  Conditional auto-execution: worker `auto-executor` builds + signs + submits on an "auto" rule
  trigger (states `EXECUTING/EXECUTED_AUTO/EXECUTION_FAILED`) behind a now-**gated**
  `FEATURE_CONDITIONAL_LIVE_EXECUTION` (replaces the old hard-fail). Guardrails: order rate limit,
  delegation expiry, kill switch, allowance fail-closed, and deterministic idempotency; crypto
  moved to `@mx2/core` so the worker can decrypt L2 creds. The raw key never touches our server.
  Quality gates: `format`/`lint`/`typecheck` ✓, backend `test` **172 pass / 3 skipped** (incl. new
  signer-seam, order-builder, allowance, auto-executor, and Privy-route suites). All flags default
  OFF; live enablement pending **Gate 6** (owner review + low-value staging test).

- **Frontend redesign → "arima" (built).** Rebranded the web app to **arima** with a sharp dark
  design system (brand `#2A36FF`): new CSS tokens + Tailwind radius/colour scale, upgraded UI
  primitives (`Button`/`Badge`/`Segmented`/`Stat`/`Skeleton`/`LiveDot`), responsive header with a
  mobile nav strip. Added dependency-free interactive SVG charts (`components/charts/AreaChart` with
  crosshair/tooltip/axes + `MiniSparkline`); the market cockpit now has a live price chart
  (6H/1D/1W/1M/ALL ranges, 15s refetch) and the markets feed shows an on-hover price-movement preview
  card (portal-based). `/profile` is now a dashboard (KPIs + equity chart + allocation/exposure +
  movers + tabbed tables). No backend/contract changes; charts reuse the existing
  `/api/markets/:id/prices-history` (interval/outcome) endpoint. Quality gates: web `typecheck` ✓,
  `test` (36/36); all routes compile clean (HTTP 200) and price-history returns ~168 points.

- **Portfolio page rework (built).** `/profile` (nav: **Portfolio**) redesigned as a terminal-style
  dashboard: hero equity/PnL metrics, approximate activity-derived equity sparkline (7D/30D/ALL),
  tabbed Positions / Open orders / History, wallet override popover, collapsed PnL methodology.
  New API routes: `GET /api/profile/overview`, `/equity-history`, `/open-orders` (read-only CLOB
  snapshot without live-trading flag); extended `/profile/history` filters; `GET /api/markets/resolve`.
  Gamma client: `findMarket` by condition or token id. Quality gates: backend `test` (135 pass),
  web `test` (36/36), `typecheck` ✓.

## Current gate

Gate 6 — server-side signing + unattended execution (Privy): **built behind flags** (quality
gates green; default OFF). Delivers the owner's "sign once, no per-order popup" request for both
manual and conditional orders, with the raw key held only in Privy's enclave. **Next: Gate 6 owner
review + the security review (RFC-0002 threat model) + a low-value staging test** (real Privy test
app, a Privy wallet funded with $5–20, bootstrap allowances, one tiny manual order + one tiny auto
rule, and the policy negative test) before flipping `FEATURE_PRIVY_SIGNING` /
`FEATURE_CONDITIONAL_LIVE_EXECUTION`. The `@privy-io/node` client + policy schema is the remaining
staging integration step (the signer seam + all guard logic are done and tested via the mock).

Gate 5 — conditional rules (shadow / alert / manual-confirm): **built** (quality gates green).
The pure `@mx2/rules` engine + worker evaluator + rules API + web rule-builder/alert/confirm are
delivered; a trigger only alerts + prepares an order for manual signature — unattended execution is
structurally impossible (`FEATURE_CONDITIONAL_LIVE_EXECUTION` throws). Hardest robustness (multi-worker
leasing, durable event log, full 13-failure-mode replay) is deliberately deferred (RISK R-011).
Next: **Gate 5 owner review** (live demo: build a rule → watch it accumulate → trigger → manual confirm).

Gate 4 — manual trading: **built** (quality gates green). Slice 5 (A-021 client-side order
signing) **built**; trading submit is now wired but still fail-closed behind `FEATURE_LIVE_TRADING`.
Next: **Gate 4 owner review** + a low-value staging trade once CLOB creds + a funded test wallet are
available.

> ⚠️ **Temporary local deviation:** route-level geoblock is commented out in
> `apps/api/src/routes/trade.ts` (and its 3 route tests skipped) for local testing —
> search `TODO(geoblock)`. **Restore `[requireAuth, geoblockCheck]` before any staging/live use.**

> 🔴 **LIVE TRADING ENABLED locally (owner manual test, 2026-06-23).** Root `.env` (gitignored) sets
> `FEATURE_LIVE_TRADING=true` + a generated `APP_ENCRYPTION_MASTER_KEY` + `TRADING_ADMIN_SECRET`. The
> API dev/start scripts now load `.env` via `--env-file-if-exists`. Added the client CLOB
> credential-setup flow (L1 `ClobAuth` signing → `lib/clob-auth.ts`, "Set up trading credentials"
> button in the order ticket) and made backend `deriveApiKey` create-or-derive. To turn live trading
> off again: set `FEATURE_LIVE_TRADING=false` in `.env` (or `POST /api/admin/trading/pause`).

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

- **Slice 4 (web) — frontend MVP (built).** `apps/web`: Next.js 15 App Router + Tailwind +
  wagmi/RainbowKit + React Query. Markets feed (`/`), market cockpit (`/markets/[id]`:
  orderbook poll, hand-rolled SVG price sparkline, stale fail-closed banner, **preview-only**
  order ticket), profile (`/profile`: positions, activity, PnL with methodology + limitations).
  EIP-712 sign-in via the wallet's EIP-1193 provider, exactly mirroring `docs/test-auth.html`.
  `/api` reverse-proxied through Next rewrites (no CORS, first-party session cookie). New
  `pnpm db:seed:allowlist <addr>` helper. Decision + scope → `docs/adr/0004-frontend-stack-and-integration.md`
  (D-010). Quality gates: web `typecheck` (0), web `test` (21/21), `next build` ✓, backend
  `test` (94/94 — +1 Gamma regression). Web is isolated from root `tsc -b` / ESLint; both web
  `typecheck`+`test` appended to `pnpm check`. Trading submit remains disabled (A-021 still open).
  **Verified end-to-end live** (feed, market detail + orderbook, trade/status) via the Next proxy.
- **Slice 5 — A-021 client-side order signing + deposit-wallet auto-derivation (built).**
  - **Deposit wallet auto-derivation.** Polymarket keys positions/PnL off the per-user **deposit
    (Gnosis Safe) wallet**, not the signer EOA. Added a pure CREATE2 derivation
    (`packages/polymarket-client/src/wallet/derive.ts`, `deriveDepositWallet`), verified against the
    owner's real EOA→deposit pair. `GET /api/auth/me` now returns `depositWallet`; profile routes
    default queries to it; the web profile loads the portfolio automatically (the manual field is now
    an optional override). No DB migration (derivation is pure). See `docs/INTEGRATION_VERIFIED.md` §9.
  - **A-021 order signing.** Client builds + EIP-712-signs the full CTF Exchange order
    (`apps/web/lib/order-sign.ts`) with the EOA and submits the signed struct; the backend forwards it
    verbatim to the CLOB (`{ order, owner=apiKey, orderType }`) — `submitOrder` rewritten,
    `POST /api/trade/orders` now takes a signed `order`. Order ticket wired preview→sign→submit, gated
    on `/api/trade/status.tradingEnabled`. See `docs/INTEGRATION_VERIFIED.md` §10.
  - **signatureType bug fixed.** Slice 3 hardcoded `signatureType: 3` ("POLY_1271"); the canonical
    enum is `EOA=0, POLY_PROXY=1, POLY_GNOSIS_SAFE=2` (no type 3). Corrected to **2** everywhere.
  - Quality gates: `format`, `lint` (0), `typecheck`, `test` (98 pass / 3 skipped — the skips are the
    temporarily-disabled geoblock route tests), web `test` (29/29), `next build` ✓.
  - **Remaining (owner action):** a real staging trade still needs CLOB creds
    (`POST /api/trade/credentials/setup`) + a small pUSD-funded test wallet, plus enabling
    `FEATURE_LIVE_TRADING`. In-browser MetaMask sign-in + portfolio auto-load is an owner live check
    (data path is covered by tests; not driveable headlessly).

- **Three pre-existing backend bugs found + fixed during web e2e verification:**
  1. **Migration journal ordering** — `0003_auth_chain_id` had an inflated `when`
     (`1782200000000`) greater than `0004`'s, so `pnpm db:migrate` silently skipped 0004 and never
     created `runtime_flags` / `order_intents` / `user_clob_credentials` (every `/api/trade/*` DB
     call 500'd; Gate 4 checklist item would have failed). Fixed by bumping 0004's `when` above
     0003's in `packages/db/drizzle/meta/_journal.json`.
  2. **Gamma schema drift** — the live Gamma API now returns `lastTradePrice`/`bestBid`/`spread`/etc.
     as JSON **numbers**; `GammaMarketSchema` declared them `z.string()`, so the entire feed 502'd
     (`PARSE_ERROR`). Fixed with a number|string→string coercion in
     `packages/polymarket-client/src/gamma/schema.ts` + a regression test. Fixture-based contract
     tests had not caught the drift.
  3. **Price history wrong endpoint** — `getPricesHistory` hit the **Gamma** host with the
     **conditionId** and a bare-array schema, so `/api/markets/:id/prices-history` returned empty
     for every market (cockpit always showed "No price history"). Polymarket's price history is a
     **CLOB** endpoint keyed by the **CLOB token id**, wrapping the series in `{ history: [...] }`.
     Moved `getPricesHistory` to `ClobClient` (token-based, `interval=max` default, unwraps
     `history`), updated the route to resolve the outcome's token id, + a regression test. Verified
     live: 743 points for a liquid market (was 0).

- **Slice 6 — conditional rules engine (Gate 5, shadow / alert / manual-confirm) (built).**
  - **`packages/rules` (new, pure, no I/O):** predicate evaluator (`price`, `cumulative_notional`,
    `visible_levels`; notional rounding pinned to USDC 6dp), deterministic continuous-duration state
    machine (states per docs/04 §4; fail-closed window reset on predicate-false / stale / reconnect /
    tick-size-change / market-pause; INVALIDATED on close/resolve; single trigger via terminal
    `TRIGGERED_AWAITING_USER`), evidence builder (FNV-1a definition hash), and a deterministic replay
    harness. 22 unit/replay tests covering the canonical 10-min trigger + negatives.
  - **DB:** `conditional_rules` + `rule_triggers` tables (`conditional-store.ts`, compare-and-set
    evaluation updates so user pause/cancel wins over the worker) + migration `0005_naive_shaman.sql`.
  - **Worker:** single-writer `rule-evaluator.ts` — reloads evaluable rules, drives WS subscriptions,
    feeds book/tick/reconnect/tick-size events, persists transitions, writes triggers + audit. A
    trigger never submits an order. `market-feed.ts` now also emits normalized views/reconnect/
    tick-size to the evaluator.
  - **API (`routes/rules.ts`, gated by `FEATURE_CONDITIONAL_RULES`):** CRUD + pause/resume/cancel,
    `GET /:id/evaluate-now` (live "would-trigger-now"), triggers list, `GET /triggers/:id` (fresh
    preview + still-holds), `POST /triggers/:id/confirm|dismiss`. Confirm reuses the existing
    `POST /api/trade/orders` (idempotency key `trigger:<id>`) — no new signing path.
  - **Web (`apps/web`):** RuleBuilder (with live client-side would-trigger-now), RuleList (status +
    accumulation progress + live eval), TriggerAlert + TriggerConfirm modal (fresh preview, loud
    "condition no longer holds", reuses the order sign+submit path), `/rules` dashboard, builder
    integrated into the market cockpit, Rules nav link.
  - **Governance:** ADR-0005 (engine), RFC-0001 stub (rebate farming + scoped signer — seam only),
    R-003 mitigated / R-011 added, D-012.
  - Quality gates: `format`, `lint` (0), `typecheck`, backend `test` (131 pass / 3 skipped — the
    skips are the temporarily-disabled geoblock route tests), web `typecheck` (0) + `test` (27/27),
    `db:generate` (migration `0005_naive_shaman.sql`).
  - **Deferred (future loops, see RFC-0001 + R-011):** multi-worker leasing, durable per-event log,
    full 13-failure-mode replay, compound/recurring/position-aware predicates, and the entire
    rebate-farming L4/L5 (reward-data adapter, quoting strategy, scoped unattended signer).

## In progress

- **Favorites persistence — planned, not built:** needs `user_favorites` table (wallet + market/event id),
  `GET/POST/DELETE /api/favorites`, authenticated CRUD, and the Favorites column switching from
  ranked suggestions to the user's saved list after sign-in.
- **Gate 5 review:** owner acceptance of the conditional-rules slice (live demo path below).
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
- **Allowlist seeding (Gate 3 prerequisite):** owner must add at least one test wallet address.
  Easiest path: `pnpm db:seed:allowlist 0xYourEoaAddress`. Equivalent SQL:
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

## Gate 5 acceptance checklist (owner review)

- [ ] `pnpm db:migrate` applies migration `0005_naive_shaman.sql` cleanly.
- [ ] `pnpm test` green (131 pass / 3 skipped) incl. the `@mx2/rules` replay suite; `pnpm check` exits 0.
- [ ] `FEATURE_CONDITIONAL_LIVE_EXECUTION=true` makes `loadConfig` **throw** (no unattended bypass) — covered by `packages/config` test.
- [ ] Live demo: create a rule on a market → watch the "would-trigger-now" panel + accumulation progress → on trigger see the alert → open confirm modal (fresh preview + "still holds") → submission stays blocked fail-closed unless `FEATURE_LIVE_TRADING=true`.
- [ ] Pause/resume/cancel transition the rule; a cancelled/triggered rule rejects further control (409).
- [ ] Audit log shows `rule.created`, `rule.triggered`, `rule.trigger.confirmed|dismissed`.

## Next checkpoint

**Gate 6 — beta hardening / release**, OR a future-loop **B** (conditional-rule robustness: leasing,
durable event log, full failure-mode replay) per RFC-0001 — owner to prioritise.

## Delivery roadmap

| Slice                                                   | Gate   | Status    | Blocked by                                        |
| ------------------------------------------------------- | ------ | --------- | ------------------------------------------------- |
| 0 — scaffolding/CI/health/flags/audit skeleton          | —      | **Built** | —                                                 |
| 1 — read-only feed + market cockpit                     | Gate 2 | **Built** | —                                                 |
| 2 — wallet login + allowlist + profile/PnL (read-only)  | Gate 3 | **Built** | Owner Gate 3 review                               |
| 3 — manual trading (staging-only, geo-gated, flagged)   | Gate 4 | **Built** | Owner Gate 4 review + staging creds + A-021 spike |
| 4 (web) — frontend MVP (read-only + preview-only)       | —      | **Built** | —                                                 |
| 6 — conditional rules (shadow / alert / manual-confirm) | Gate 5 | **Built** | Owner Gate 5 review                               |
| 7 — beta hardening / release                            | Gate 6 | Pending   | prior slices                                      |
