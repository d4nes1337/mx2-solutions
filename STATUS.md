# Project Status

_Last updated: 2026-06-22_

## Current gate

Gate 1 — Architecture & stack: **approved** (owner, 2026-06-22; ADR-0001 Option A + ADR-0002).
**Slice 0 (scaffolding) built** — quality gates green. Next: **Slice 1** (read-only feed + cockpit).

## Completed

- Product and MVP brief reviewed; full requirements kit read.
- Polymarket integration verified against primary sources → `docs/INTEGRATION_VERIFIED.md`.
- Architecture options + recommendation → `docs/adr/0001-architecture-and-stack.md`.
- Wallet/signing path → `docs/adr/0002-wallet-and-signing-path.md`.
- Assumptions register → `docs/ASSUMPTIONS.md`.
- Repository initialised and synced to `origin/main`; requirements kit kept as gitignored inbox.
- Owner decisions captured (geo, trading scope, wallet path, repo layout) → `DECISIONS.md`.

## In progress

- **Slice 0 — backend scaffolding (built).** pnpm monorepo (`apps/api`, `apps/worker`,
  `packages/{core,config,observability,db}`); Fastify health/readiness + feature-flag endpoints;
  Zod config with fail-closed flags; pino logging with secret redaction; Drizzle append-only
  `audit_events` table + first migration; ESLint module-boundary rules; Vitest (11 tests);
  GitHub Actions CI; docker-compose Postgres.
  - Verified locally: install, `format:check`, `lint` (0), `typecheck`, `test` (11/11),
    `db:generate`.
  - **Pending:** live-DB smoke test (`compose:up` + `db:migrate` + `/readyz`) — needs the Docker
    daemon running on the dev machine.

## Blocked / owner input required

- **Legal sign-off** still advised before enabling **live** trading (Gate 4); does not block
  read-only or staging build work.

## Next checkpoint

**Gate 2 — read-only vertical slice** (Slice 1): event feed + one market cockpit on public
Polymarket data (Gamma REST snapshot + CLOB WebSocket deltas, orderbook/trades/chart,
stale/reconnect handling), with fixtures + contract tests.

## Delivery roadmap

| Slice                                                  | Gate   | Status              | Blocked by                                           |
| ------------------------------------------------------ | ------ | ------------------- | ---------------------------------------------------- |
| 0 — scaffolding/CI/health/flags/audit skeleton         | —      | **Built**           | — (live-DB smoke test pending Docker)                |
| 1 — read-only feed + market cockpit                    | Gate 2 | **Next**            | —                                                    |
| 2 — wallet login + allowlist + profile/PnL (read-only) | Gate 3 | Ready after Slice 1 | —                                                    |
| 3 — manual trading (staging-only, geo-gated, flagged)  | Gate 4 | Pending             | integration spike + security review + legal sign-off |
| 4 — conditional rules shadow mode                      | Gate 5 | Pending             | Slice 1                                              |
| 5 — beta hardening / release                           | Gate 6 | Pending             | prior slices                                         |
