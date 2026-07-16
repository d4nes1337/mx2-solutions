# Project Status

_Last updated: 2026-07-16_

## Recent

- **Round-4: workspace redesign + `price_move` + execution styles/fee engine + maker-loop shadow
  foundations (built; D-024, ADR-0013/0014, RFC-0003).** Owner's round-4 scope executed end-to-end:
  - **Workspace redesign.** Focus-ring fix + **paper is now the default theme**; the builder
    becomes a resizable tabbed workspace — full-height AI chat, Simulate tab, and a Market tab
    (chart + orderbook) — with inline canvas editing (edit-in-place + delete on nodes) and an
    add-market search directly on the canvas.
  - **`price_move` momentum condition end-to-end**: engine predicate + worker rolling price
    windows + API + AI tooling + builder UI, with fail-closed window-coverage semantics (an
    under-covered window never satisfies) and backtest support including a `window_too_fine`
    honesty guard (refuses to fake sub-resolution momentum from coarse history).
  - **Execution styles + fee engine (ADR-0013).** Per-step `orderType` GTC/GTD/FOK/FAK +
    `postOnly` + GTD entry windows (trigger-anchored, +60 s wire compensation, 180 s floor →
    sub-3-min windows use FAK). **Fee Structure V2 verified live** (taker-only, makers never
    pay; INTEGRATION_VERIFIED §16–§17); pure fee math in `packages/rules/src/fees.ts`; new
    public `GET /api/markets/:conditionId/economics` (5-min cache); projections/backtests are
    fee-aware for taker entries; the MakerEstimator now shows **real $/day pool rates** from
    CLOB `/rewards/markets/*` (A-050 resolved).
  - **Templates single source of truth** in `@mx2/rules` (renames: re-entry → "Dip buy",
    maker-reward → "Maker efficiency"; new spike-reversal; cross-market kept) with AI few-shot
    sync tests so the prompt examples can never drift from the real templates.
  - **Maker-loop foundations — SHADOW-ONLY behind `FEATURE_MAKER_LOOP`** (ADR-0014, RFC-0003):
    `quote_loop` strategy archetype on `conditional_rules`; pure quoter engine with the
    anti-runaway idempotence property (`diff(x,x)=∅`, property-tested); migration `0010`
    (`quote_sessions` / append-only `quote_events` with UNIQUE idempotency keys /
    `reward_accruals`); relayer `execute` seam + CTF merge calldata builder +
    `verify-ctf-adapters` script (adapter addresses config-required, no defaults — R-028);
    quoter API (sessions/events/mode/halt/resume, escalation blocked without
    `FEATURE_MAKER_LOOP_LIVE`). RFC-0003 records the **owner-approved rollout ladder** —
    shadow soak → adapter verification → confirm on one $20–50 market → live minimum caps +
    kill-switch drill → GA only if real accrual data proves rewards ≥ costs (R-027..R-030).
  - Quality gates: repo typecheck ✓, root **353 pass** + web **98 pass** ✓, lint ✓; live
    verification of the economics endpoint + `price_move` draft evaluation against real
    markets. Known (pre-existing, not round-4): CLOB REST `/book` fallback 422s app-wide
    (spawned as a separate task); builder page dev-mode hydration lag.

- **Round-3 UX polish: wallet lifecycle self-healing + cockpit intelligence + themes + onboarding
  (built; D-023).** Owner's round-3 brief executed end-to-end:
  - **Wallet lifecycle fixed (the "deleted my Privy wallet, can't re-create" bug).** Provisioning
    now verifies the mapped wallet still exists at Privy: a definitive provider 404 archives the
    ghost `internal_privy` account, re-issues a fresh wallet and overwrites the mapping (audit:
    `trading_wallet.ghost_detected` / `.reissued`); a transient verification failure re-links
    untouched (fail-closed — nothing is ever destroyed on a flake). New
    `POST /api/trading-wallet/reissue` (409 `WALLET_STILL_ACTIVE` when alive, 502 when
    unverifiable) + `GET /api/trading-wallet?verify=1` → `walletHealth`. Web: warn banner +
    "Re-create trading wallet" in WalletsSection; auto-provision on login self-heals silently.
    7 new route tests cover exactly the deletion/reissue matrix.
  - **Header account UX.** RainbowKit's stock account modal replaced by a first-party
    `AccountMenu` (ConnectButton.Custom): identity + beta badge, trading-wallet USDC balance with
    one-click **Top up** (deep link `/wallet?topup=1` auto-opens the TopUpSheet; top-up is now
    always reachable once a deposit wallet exists), portfolio/wallet links, sign out, disconnect.
  - **Three-theme system.** `data-theme` tokens in globals.css — light (default), **paper**
    (warm-grey, Claude-style) and dark — with `--brand-rgb` glow re-tinting, anti-flash inline
    script, localStorage persistence, RainbowKit theme sync, and a header switcher.
  - **Hero carousel.** Rotates the top backtested showcases (auto-advance 7s, dots/arrows,
    reduced-motion aware); each slide shows the server-generated chat **prompt** that builds it
    ("Try this prompt" seeds the AI box). `Showcase.prompt` added to `/api/showcases`.
  - **Market cockpit rework.** "Preview order" button AND `POST /api/trade/orders/preview`
    removed (client-side validation + payoff stay; `builderCode` now served by
    `GET /api/trade/status`; submit signs directly, still fail-closed behind
    `FEATURE_LIVE_TRADING`). Default view now shows: **entry scenarios** under the chart
    (`GET /api/markets/:id/scenarios` — dip-buy/breakout/patient-limit backtested per market via
    the shared simulator, 15-min per-market cache, R-023 honesty labels, "Open in builder" deep
    links via `?scenarioMarket=&scenario=`), the **order book**, **real latest trades**
    (`GET /api/markets/:id/trades`, Data-API taker fills) and **top holders**
    (`GET /api/markets/:id/holders`) — upstream shapes verified against the official reference
    (INTEGRATION_VERIFIED §15, R-026 tracks live confirmation). Advanced tab keeps tape/queue/
    classic rule form.
  - **Onboarding.** Dependency-free spotlight tour engine (skips missing targets, Esc/arrows,
    localStorage flags, low-key first-visit invite): home tour (6 steps) + builder tour (4 steps),
    replayable from a header "?" button.
  - **Canvas smoothness.** React Flow now owns positions in local state; doc changes and 3s eval
    polls RECONCILE into the arrays preserving node identity (a poll can no longer rebuild or
    snap the graph mid-drag); node bodies memoized; ProjectionCard's 30-day backtest and
    SentenceBar memoized; `transition-all` dropped from nodes.
  - **AI-unlock runbook** (prod "AI still locked" root cause): the key alone does nothing —
    set `FEATURE_AI_CHAT=true` in `.env.production` (exact lowercase) **and recreate** containers
    (`docker compose -f docker-compose.prod.yml up -d`; `restart` does not re-read env_file).
    Verify: `curl <api>/api/feature-flags` → `"aiChat":true`. `.env.production.example` now
    documents the trap inline; dead `CLOSED_BETA_ALLOWLIST` var removed.
  - Quality gates: format ✓, lint ✓, root typecheck ✓, backend **280 pass / 3 skipped** (incl.
    7 wallet-reissue, 9 markets-data/scenarios, 4 signer), web **82 pass** (incl. 4 theme,
    2 carousel), `next build` ✓; verified in-browser against live Polymarket data (hero carousel +
    prompts, 3 themes + anti-flash reload, both tours, cockpit scenarios/book/trades/holders on a
    liquid market, scenario→builder hydration, canvas drag with zero console errors).

- **Round-2 growth: real examples everywhere + calm feed + @-mentions + Haiku (built; D-022,
  ADR-0012).** Owner's round-2 brief executed: the pure trigger simulator moved to
  `packages/rules/simulate.ts` (shared web+api); new **showcase engine**
  (`GET /api/showcases`, public 30/min, 15-min cached) backtests a dip-buy grid over 30 days
  of real prices on trending liquid markets and serves only winners — labeled "hypothetical,
  past ≠ future" on every surface (R-023/R-025) — powering the home **ShowcaseGallery**
  (replaces the template gallery, which stays as fallback), a **live hero showcase** (replaces
  the hardcoded mock), showcase-derived prompt examples, per-card **backtest teasers**, and
  `?showcase=` deep links that open the exact validator-checked once/prepare definition in the
  builder. `/markets` rebuilt as a calm Polymarket-style **card grid** (Trending/Top/Favorites
  tabs + filter; activity tape, movers strip and the 3-column terminal removed; per-card
  "Automate →"; drag-and-drop evaluated and rejected for v1). Cockpit: payoff-if-fills line in
  the trade ticket + **BacktestTeaser** under Automate. Builder: **"Projected: +$X if Yes
  wins"** chip beside the live verdict; ProjectionCard moved to the top of the rail.
  **@-mention market pinning** in the AI panel (live search dropdown, chips, ≤4 pins) — the
  server re-resolves pinned conditionIds via `findMarket` and seeds pre-verified candidates,
  so the model skips search rounds and still never sees market ids. Beta AI model switched to
  **claude-haiku-4-5** via env; the generate loop now gates `output_config.effort` off for
  haiku tiers (they 400 on it — caught in planning review before it could break prod).
  Quality gates: format/lint/typecheck ✓, backend **272 pass / 3 skipped** (showcases 5, AI
  pinned+effort 3 new), web **76 pass** (@-mention, Hero live-showcase/fallback new); combined
  rounds 1+2 deploy + live smoke pending.

- **AI "vibe-trading" onboarding + open beta (built; D-021, ADR-0011).** Growth slice per the
  owner's brief: the landing hero becomes a prompt box ("Type a thought. Watch it become a
  strategy.") that deep-links into the builder where a new `AiPanel` auto-fires
  `POST /api/ai/generate-strategy` — a PUBLIC, per-IP rate-limited (5/min + 15/day) Anthropic
  tool-use loop (`claude-sonnet-5` via `AI_MODEL`, fail-closed `FEATURE_AI_CHAT` requiring
  `ANTHROPIC_API_KEY`) that searches live markets server-side, binds real `MarketRef`s by
  candidate index (the model never sees conditionId/tokenIds), validates with the shared
  `validateStrategyDefinition` (+1 repair round), and hard-forces `execution:"prepare"`. The
  canvas assembles with a staged node reveal; follow-up messages refine the doc in place
  (stateless server, client-held ≤6-turn history). New **instant PnL projection** right-rail
  card (`ProjectionCard`): deterministic payoff math (shares semantics; hypothetical $100 for
  alert-only), exit-price PnL curve, and a "would have triggered N× → ±$X" backtest over real
  30-day CLOB history (new public token-keyed `GET /api/markets/prices-history`, 60/min) with
  estimates-only disclaimers, plus a fund-your-wallet CTA. **Open beta**: `FEATURE_OPEN_BETA`
  auto-allowlists any wallet completing a valid EIP-712 sign-in (`allowlist.auto_added` audit,
  revocable). Found+fixed in browser verification: auto-fired mutations lost their settle
  notification under React StrictMode (deferred-timer fix, regression-tested). Both flags
  default OFF; risks R-022..24 registered. Quality gates: format/lint/typecheck ✓, backend
  **265 pass / 3 skipped** (16 new: AI route 11, auth open-beta 4, config), web **84 pass**
  (23 new: projection 8, backtest 11, AiPanel 4 incl. StrictMode regression, Hero 3); full
  wow-flow verified in-browser against live Polymarket data (hero → prompt → builder →
  projection with correct mark-to-market; AI error path graceful with template fallback —
  live generation smoke happens at prod deploy once the owner sets the real key).

- **Product pivot → "Smart Orders" visual builder (built; UX track U1–U7 + engine track E3–E4).**
  Owner-approved pivot (2026-07-07) from terminal-first UX to an accessible visual
  algo-trading builder. Shipped: light-first design system relight (dark palette parked under
  `.dark`); new IA (Home / Markets / Smart Orders / Wallet + account menu) with a hero homepage,
  template gallery and market search; `/wallet` two-mode page (sign-each-trade vs Arima trading
  wallet) with a Create→Top up→Activate→Trade readiness stepper; **Smart Order DSL v2**
  (ADR-0010: AND/OR/NOT expression trees, cross-market @market conditions, spread/time-window
  blocks, repeat+cooldown recurrence, per-strategy spend limits; migration `0009`, additive) with
  an 8-scenario v1-parity proof and ONE worker evaluation path via a pure compat reader;
  `/api/smart-orders` (CRUD/controls/multi-market evaluate-now) + **public** rate-limited
  `evaluate-draft` and `/api/markets/search` (Gamma `/public-search` verified live 2026-07-08);
  the **visual builder** (`@xyflow/react` canvas + zustand doc store, clickable plain-English
  sentence, inspector, @market search with previews, live "Would trigger now?", validation
  checklist, public playground with sign-in-gated save, edit = new version + cancel old);
  Smart Orders monitor with user-language status groups and per-card live state; market cockpit
  simplified (Overview/Advanced tabs, "Automate this market" template deep links);
  `/rules → /smart-orders` redirect. Also fixed in passing: audit metadata no longer stores the
  raw L2 apiKey (fingerprint only; R-019 closed). Quality gates: `format:check` ✓, `lint` ✓,
  root `typecheck` ✓, backend test **231 pass / 3 skipped**, web test **54 pass**, web `build` ✓;
  builder verified in-browser against live Polymarket data (search → bind → live per-condition
  actuals → correct verdict). Auto-mode safety track also landed (W1, W5–W8): delegation TTL
  14 d default / 30 d cap with a refresh-within-grant endpoint and a `delegation.expiring`
  audit seam; the auto-executor now enforces the full fail-closed guard chain (per-strategy
  kill via `rule_auto_disabled:<id>` + user disarm/rearm routes, per-order / daily / lifetime
  notional caps with restart-surviving accounting, repeat limits, funding-wallet balance
  pre-check) — 16 executor tests cover every guard; `GET /api/trading-wallet/balance` reads
  on-chain USDC.e for the top-up stepper. U8 shipped the reward-aware maker template
  estimator-first (live `rewardsMinSize`/`rewardsMaxSpread` from Gamma, honest "no dollar
  reward promised" posture, prepare-only quotes). **Remaining before live auto-mode:** W2–W4
  (relayer allowances + server-side ClobAuth + deposit-wallet order submission — needs the
  owner's builder/relayer credentials and a signatureType live-docs check) and W9 (low-value
  staging verification + explicit Gate 6 owner sign-off). Final totals: backend test
  **243 pass / 3 skipped**, web test **58 pass**, build/typecheck/lint/format ✓.

- **Deposit-wallet relayer activation slice (built, behind `FEATURE_RELAYER`).** Added the official
  builder-relayer integration seam and API wiring for internal Privy wallets: backend-only relayer
  config (`POLYMARKET_RELAYER_URL`, builder API key/secret/passphrase, `POLYGON_RPC_URL`) now fails
  closed at config load; `apps/api` constructs a Polymarket `RelayClient` with a Privy-backed minimal
  viem wallet-client adapter; `POST /api/trading-wallet/activate-deposit-wallet` checks/submits
  deposit-wallet deployment and persists the deposit wallet on the internal `trading_account`; the
  account selector UI now exposes an **Activate deposit wallet** action. Added a tested
  `DepositWalletRelayer` adapter in `@mx2/polymarket-client` and route tests for disabled + confirmed
  deployment states. Important compatibility finding: `builder-relayer-client@0.0.10` currently
  types against `builder-signing-sdk@^0.0.8`, so the API pins `@polymarket/builder-signing-sdk@0.0.8`
  even though the standalone signing package has a newer npm release. Quality gates:
  `format:check` ✓, `lint` ✓, root `typecheck` ✓, backend `test` **183 pass / 3 skipped**,
  web `typecheck` ✓, web `test` **37 pass**.

- **Trading account selection + deposit-wallet fail-closed rewrite (built).** Owner approved a
  two-mode UX: users may trade from any added external Polymarket wallet with browser signatures,
  while every login can auto-provision an internal Privy trading wallet that becomes no-popup only
  after Polymarket deposit-wallet/relayer activation. Added `trading_accounts` and
  `trading_account_clob_credentials` (migration `0007`), account-scoped CLOB credential setup,
  account-aware preview/submit/cancel routes, restored trading-layer geoblock preHandlers, and
  updated the order ticket / trigger confirmation to use the selected primary account. The old
  Privy bare-EOA `signatureType 0` submit and embedded-EOA allowance bootstrap paths now fail closed
  with relayer/deposit-wallet errors. Quality gates: DB build ✓, API build ✓, web typecheck ✓,
  focused trading route tests **46 pass / 3 skipped**.

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

Gate 6 — selectable trading accounts + server-side signing: **in progress; safe slices built on
2026-06-30**. The product now distinguishes external wallet trading (manual signatures) from internal
Privy trading wallets (no-popup target). Deposit-wallet activation is wired behind `FEATURE_RELAYER`,
but **🔴 BLOCKER (R-017/R-001)** remains for actual no-popup orders until the next slices complete:
relayer allowance batches, top-up/funding UX, official SDK `signatureType 3 / POLY_1271` order
creation, withdrawal/return-funds flow, and a low-value staging order + cancel + monitoring review.
Bare Privy EOA `signatureType 0` remains intentionally disabled.
`FEATURE_LIVE_TRADING=false` and `FEATURE_CONDITIONAL_LIVE_EXECUTION=false` remain the safe defaults.

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

> Trading-layer geoblock preHandlers are restored on preview, submit, account, and cancel routes.

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

- **Portfolio PnL refactor (2026-07-01): Built, pending owner visual acceptance.**
  - Backend now resolves the Polymarket public profile/proxy wallet, fetches profile avatar/name,
    account-level all-time PnL from Data API leaderboard, current open positions, recent closed
    positions, raw activity, and CLOB cash balance when credentials are configured.
  - Top stats now expose equity, total PnL, unrealized, realized, exposure, and cash. Equity =
    exposure + known cash; when CLOB credentials are missing, cash remains unknown rather than
    inferred.
  - PnL chart now walks closed-position realized PnL and anchors to account-level leaderboard PnL.
    It no longer charts raw BUY/SELL USDC flows.
  - Portfolio page includes avatar/name and a new Market PnL tab with open/won/lost/sold in
    profit/loss rows plus per-market PNG export cards carrying the profile avatar.
  - Verified against public address `0x77117F39dc33292c657a366643Dd995010b7E36d` → proxy
    `0x997c95d8be61d5779edfb49aaf5dd83d85f31434`; public leaderboard all-time PnL observed near
    `$400.27` on 2026-07-01.
  - Quality gates: `pnpm run typecheck`, `pnpm run test`, `pnpm --filter @mx2/web run typecheck`,
    `pnpm --filter @mx2/web run test`, `pnpm run lint`.

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
