# mx2-solutions — Polymarket Terminal (MVP 0.1)

Non-custodial trading terminal for Polymarket — closed beta. This repository contains the
application; the owner's requirements kit lives in the gitignored `polymarket_claude_mvp_kit_v1/`
inbox (not committed).

> **Status:** Slice 0 (backend scaffolding). Live trading and unattended conditional execution are
> **off by default** behind feature flags. See [`STATUS.md`](STATUS.md), [`DECISIONS.md`](DECISIONS.md),
> [`RISK_REGISTER.md`](RISK_REGISTER.md), and [`docs/adr/`](docs/adr).

## Architecture

TypeScript modular monolith + a dedicated worker process, PostgreSQL, single EU VPS target
(ADR-0001). Risk-bearing features are fail-closed.

```
apps/
  api/      Fastify HTTP API (health, feature flags; feed/trading routes in later slices)
  worker/   long-running process: WS ingestion + conditional-rule evaluator (later slices)
packages/
  core/          domain types: Result, branded ids, audit vocabulary
  config/        Zod-validated env + feature flags (fail-closed invariants)
  observability/ pino logger with secret redaction
  db/            Drizzle schema + client + append-only audit store + migrations
```

Module boundaries are enforced by ESLint (`apps` may use `packages`; `packages` must not import
`apps`; the two apps must not import each other).

## Prerequisites

- Node 22 (`.nvmrc`) — Node 20+ supported.
- pnpm via corepack (managed by `"packageManager": "pnpm@9.15.0"` in `package.json`).
- Docker (for local PostgreSQL).

## Local run

> **Important:** all `pnpm` commands must be run from the project root (`mx2-solutions/`), not from
> your home directory. Corepack reads the `packageManager` field from `package.json` and pins pnpm
> to the correct version — running from `~` picks up the system default instead.

```bash
# 0. Navigate to the project root (required)
cd /path/to/mx2-solutions

# 1. Enable corepack and install (must be run from this directory)
corepack enable
pnpm install

# 2. Copy env template (only needed once; optional — localhost defaults are built-in)
cp .env.example .env

# 3. Start PostgreSQL
pnpm compose:up

# 4. Apply migrations
pnpm db:migrate

# 5. Run the API and worker (separate terminals)
pnpm dev:api       # http://localhost:3001/healthz , /readyz , /api/feature-flags
pnpm dev:worker
```

Configuration comes from environment variables (validated in `packages/config`). Copy `.env.example`
to a local `.env` and adjust — **never commit real secrets**. Sensible localhost defaults are built
in, so the app runs against `docker-compose` Postgres with no `.env`.

## Quality gates

```bash
pnpm run check   # prettier --check + eslint + tsc -b + vitest
```

CI (`.github/workflows/ci.yml`) runs the same on every push/PR to `main`.

## Security notes

- The app never holds a user's primary private key or seed (see ADR-0002).
- `FEATURE_LIVE_TRADING`, `FEATURE_RELAYER`, and `FEATURE_CONDITIONAL_LIVE_EXECUTION` default to
  `false`; the last must remain `false` in MVP 0.1 (enforced at config load).
- Logs redact credentials, signatures, and wallet material (`packages/observability`).
