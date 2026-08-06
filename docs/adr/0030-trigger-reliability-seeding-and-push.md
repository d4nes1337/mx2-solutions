# ADR-0030: Trigger reliability — price-window seeding, atomic commits, and push notifications

- **Status:** Accepted (owner-approved plan, 2026-08-06)
- **Context:** docs/TRIGGER_RELIABILITY_AUDIT.md (the 2026-08-06 missed-trigger incident)

## Context

A `price_move` strategy on a 5-minute instant market missed a real 10¢ drop: the worker's
rolling price window starts empty at arm/restart, was wiped globally on every WS
reconnect, and was never backfilled — so the strategy was structurally blind for its full
lookback, longer than the market's life. Three surfaces (worker, `/evaluate-now`,
`/overview`) evaluated the same predicate from three different data sources and disagreed
in exactly the failure case. Trigger persistence was a non-atomic three-write sequence
with silent-loss modes, and the browser learned about signing prompts only by 4–9 s
polling. Live verification additionally exposed phantom mids from worst-first book
ordering and a missing client-side WS keepalive that upstream mandates.

## Decisions

1. **Seed price windows from upstream history; never let a seed outrank live data.**
   At arm, restart, and after reconnect gaps, the worker backfills each price_move
   token's window from CLOB `/prices-history` (1-min bars, lookback = windowMs + 5 min).
   `PriceWindowStore.merge` inserts seeds only strictly behind the newest live sample and
   never overwrites a live timestamp, so seeding can reveal a real move earlier but never
   fabricate one, and the newest observation (`last` in the predicate) is live the moment
   any live tick exists. A strategy armed during a still-in-window qualifying move fires
   immediately — consistent with the predicate's trailing-window definition and with what
   `/evaluate-now` already told the user. Reconnects gap-mark (discard pre-gap samples)
   instead of wiping all tokens; the gap heals from upstream history, which is
   authoritative for the dark span. `packages/rules` semantics are untouched — all fixes
   are data-supply fixes in the worker, so worker and panel converge by construction.

2. **Trigger commit is one transaction with DB-level idempotency.**
   `commitTriggerAtomically` (packages/db): rule-status CAS + `rule_triggers` insert
   (`ON CONFLICT DO NOTHING` against a partial unique index on
   `(rule_id, (evidence->>'triggerNumber')::int)`) + notification-outbox insert +
   `pg_notify` — all-or-nothing. A lost CAS (user pause/cancel wins) and a twice-failed
   persist are AUDITED (`rule.trigger_dropped`) instead of silent; the failed-persist path
   drops in-memory state so the reload pass resyncs from DB truth (kills the zombie mode).
   Audit emits stay outside the transaction: an audit hiccup must never roll back a
   signing proposal.

3. **Push via Postgres LISTEN/NOTIFY → per-wallet SSE; polling stays as the floor.**
   The NOTIFY rides inside the commit transaction, so listeners can only observe
   committed triggers. The API holds one reconnecting LISTEN connection
   (`packages/db/notify-listener.ts`) and fans out on `GET /api/realtime/stream` (same
   hijack/keepalive pattern as the shipped AI SSE route); the web app invalidates its
   action-center/strategy queries on events. Measured commit→SSE ≈ 30 ms vs 4–9 s
   worst-case polling. Every poll remains untouched — the stream is an accelerator, never
   a dependency; its failure degrades to exactly the pre-SSE product.

4. **REST freshness verification is not gated on WS health.**
   A just-fetched REST book is fresh data regardless of the socket's state; the old gate
   disabled the fallback precisely during reconnect storms and boot. Fail-closed still
   holds: with WS and REST both dark, views age out and staleness suppresses triggering
   exactly as before (regression-tested). REST verify results also feed price windows.

5. **WS transport follows the documented contract** (verified against
   docs.polymarket.com 2026-08-06; INTEGRATION_VERIFIED §5): client text `PING` every
   10 s; membership deltas via `{assets_ids, operation: subscribe|unsubscribe}`; initial
   `{assets_ids, type: "market"}` on open; 30 s total-silence terminate-and-reconnect;
   single reconnect timer. Data staleness is per-token in the feed manager (the old
   socket-global timer marked every token stale together). Mid prices are computed from
   the true best levels — upstream lists book levels worst-first, and raw `[0]` reads had
   been poisoning windows and snapshot midPrice with ~0.50 phantoms. Raw level prices are
   never price observations.

6. **Market resolution is detected, not inferred from silence.** A 60 s Gamma poll maps
   `closed → resolved` / `active:false → paused` into the state machine's (previously
   unreachable) `market_status` path — INVALIDATED with `MARKET_RESOLVED` — and stamps
   `market_snapshots.market_status` so the UI can say "market resolved" instead of
   "no fresh data".

## Alternatives considered

- _Weaken staleness so incomplete windows can fire_ — rejected: violates fail-closed;
  seeding fixes availability without touching safety.
- _A separate "worker view" table (or worker-computed leaf state) for UI freshness_ —
  rejected: new schema and readers for data the evaluator already owns; persisting the
  patched snapshot (1/s/token) reuses the existing read path.
- _WebSockets to the browser_ — rejected for MVP: SSE needs no new infrastructure,
  rides existing auth/cookies, and Postgres NOTIFY already provides the fan-in.
- _pg-mem / testcontainers for all DB tests_ — rejected: fakes with the real CAS/unique
  contract stay fast; one env-gated integration suite against the compose Postgres proves
  the transaction, the expression index, and NOTIFY-on-commit.

## Consequences

- A fired condition now always yields exactly one signing proposal (DB-enforced), with a
  full audit trail for every non-recorded computation.
- Blindness windows shrink from "≥ windowMs, often forever" to "one REST round-trip".
- The three surfaces read converging data; remaining divergence is presentation-only.
- New residual risks (seed-bar coarseness, trade-vs-mid mixing, 60 s Gamma lag) are
  disclosed in the audit doc; all degrade fail-closed.
- Single-writer topology assumptions unchanged (D-001/R-011).
