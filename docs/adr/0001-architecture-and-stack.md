# ADR-0001: Architecture and stack

- Status: **Accepted** (Gate 1 approved by owner 2026-06-22)
- Date: 2026-06-22
- Decision owners: Technical Lead (proposes) / Product Owner (approves budget, timeline, vendor
  lock-in, product behaviour, risk)

## Context

Closed beta of a non-custodial Polymarket terminal for 50–100 users (10–20 concurrent target;
≤500 monitored outcome tokens; ≤1,000 active conditional rules). The product is read-first
(discovery feed + market cockpit), with manual non-custodial trading and shadow conditional rules
added behind feature flags at later gates. Official Polymarket integration is **TypeScript/Python
first**: the V2 CLOB client and the relayer/builder client exist in TS and Python only
(see `docs/INTEGRATION_VERIFIED.md`). Correctness, security, and reconnect-safe market data matter
more than sub-second latency.

## Decision drivers

- Minimise time-to-first-demo for a read-only vertical slice.
- Stay close to the **official SDK ecosystem** (V2 TS) to reduce signing/relayer risk.
- Fit the ~$120–130/mo infra target without premature distribution.
- Keep clean seams to later extract the WS-ingestion / rule-evaluator worker and to add live
  execution, multi-wallet, advanced PnL, and subscriptions without a rewrite.
- One deterministic, single-writer path for conditional-rule evaluation.

## Options considered

### Option A — TypeScript modular monolith + dedicated worker (RECOMMENDED)

- **Frontend:** Next.js (React).
- **API:** Fastify (or NestJS) modular monolith, single deployable. Modules: MarketData,
  Identity&Access, Portfolio/PnL, Trading, ConditionalRules, Ops/Admin.
- **Worker:** a separate long-running Node process (same repo/build) for CLOB WebSocket ingestion +
  the conditional-rule evaluator (single-writer per rule via DB advisory lock).
- **DB:** managed PostgreSQL. **Browser realtime:** SSE/WS from our backend.
- **Deploy:** single EU (Ireland) VPS (Lightsail per `…/docs/07`) + managed PG.
- Pros: one language end-to-end, shared types front↔back, direct use of `@polymarket/clob-client-v2`
  and `@polymarket/builder-relayer-client`, cheapest correct shape, easy local `docker-compose`.
- Cons: API and worker share a runtime culture — needs disciplined module boundaries to keep the
  evaluator isolated; Node numeric care needed for money math (use integer/decimal libs).

### Option B — Python backend (FastAPI) + TS frontend

- `py-clob-client-v2` + `py-builder-relayer-client`; FastAPI API + Python evaluator; Next.js front.
- Pros: Python strength for data/PnL analytics; official Python SDK exists.
- Cons: two languages, no shared types, more glue; the ERC-7739-wrapped `POLY_1271` order signing
  must happen **client-side in the browser** regardless, so a Python backend gains little on the
  hardest integration and adds a TS↔Py contract seam.

### Option C — Microservices + message queue

- Separate feed, trading, rule-engine services behind a gateway, Redis/NATS between them.
- Pros: independent scaling and strong evaluator isolation.
- Cons: heavy operational burden, more cost, slower delivery — unjustified at 10–20 concurrent
  users. Violates "avoid premature distributed systems."

## Recommendation

**Option A.** It matches the official SDK ecosystem, ships the read-only slice fastest, fits the
cost target, and preserves the seam to extract the worker into its own service later if scale
demands. The worker is already a separate process, so the future split is low-cost.

## Consequences

### Positive
- Fast first demo; shared types reduce contract drift; gasless relayer + V2 CLOB used natively.
- Evaluator runs as an isolated process from day one.

### Negative / risks
- Monolith discipline required (enforce module boundaries via lint/import rules).
- Node money math needs explicit decimal handling and tested rounding (tie to CLOB tick-size model).
- Single VPS is a single failure domain — acceptable for beta with daily backup + tested restore.

## Product-owner approval required for

- The stack/runtime choice (TS monolith + worker) and its vendor implications.
- Infra shape + budget (single EU VPS + managed PG, ~$120–130/mo).
- The deferral of EOA/legacy wallet paths and of a full PnL ledger to P1.

## Validation plan

- Slice 0 scaffolding proves: build, lint, type-check, tests, health/readiness, feature flags,
  `docker-compose` local run, append-only audit-event skeleton.
- Slice 1 proves the data path end-to-end (Gamma REST snapshot + CLOB WS deltas, reconnect/stale
  handling) against fixtures + contract tests — the riskiest read-path assumption.
