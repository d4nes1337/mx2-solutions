# Project Status

_Last updated: 2026-06-22_

## Current gate

Gate 2 — read-only vertical slice: **built** (quality gates green). Next: **Gate 2 owner review**,
then Slice 2 (wallet login + allowlist).

## Completed

- Product and MVP brief reviewed; full requirements kit read.
- Polymarket integration verified against primary sources → `docs/INTEGRATION_VERIFIED.md`.
- Architecture options + recommendation → `docs/adr/0001-architecture-and-stack.md`.
- Wallet/signing path → `docs/adr/0002-wallet-and-signing-path.md`.
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

## In progress

- **Gate 2 review:** owner acceptance of Slice 1 deliverables below.

## Blocked / owner input required

- **Legal sign-off** still advised before enabling **live** trading (Gate 4); does not block
  read-only or staging build work.

## Gate 2 acceptance checklist (owner review)

- [ ] `pnpm compose:up && pnpm db:migrate` applies both migrations cleanly.
- [ ] `pnpm dev:api` starts; `GET /api/events` returns Gamma feed (or 502 if upstream unreachable).
- [ ] `GET /api/markets/:id` returns market metadata + `_live.orderbook` section.
- [ ] `pnpm dev:worker` starts; logs show WS state transitions.
- [ ] All 35 tests pass: `pnpm test`.
- [ ] `pnpm run format:check && pnpm run lint && pnpm run typecheck` all exit 0.

## Next checkpoint

**Gate 3 — Slice 2:** wallet login + allowlist + read-only portfolio/PnL.

## Delivery roadmap

| Slice                                                  | Gate   | Status              | Blocked by                                           |
| ------------------------------------------------------ | ------ | ------------------- | ---------------------------------------------------- |
| 0 — scaffolding/CI/health/flags/audit skeleton         | —      | **Built**           | —                                                    |
| 1 — read-only feed + market cockpit                    | Gate 2 | **Built**           | Owner Gate 2 review                                  |
| 2 — wallet login + allowlist + profile/PnL (read-only) | Gate 3 | Ready after Gate 2  | —                                                    |
| 3 — manual trading (staging-only, geo-gated, flagged)  | Gate 4 | Pending             | integration spike + security review + legal sign-off |
| 4 — conditional rules shadow mode                      | Gate 5 | Pending             | Slice 1                                              |
| 5 — beta hardening / release                           | Gate 6 | Pending             | prior slices                                         |
