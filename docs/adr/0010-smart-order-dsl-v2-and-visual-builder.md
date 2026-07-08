# ADR-0010 — Smart Order DSL v2 and the visual builder

- Status: Built (slices U1–U6/E3–E4, 2026-07-07..09); live auto-execution still gated (Gate 6)
- Owner decision: product pivot approved 2026-07-07 (see DECISIONS D-019)

## Context

The product pivoted from a dense trading terminal to an accessible **visual algo-trading
builder** ("Smart Orders", see the 2026-07-07 owner brief). The v1 conditional-rule engine
(ADR-0005) was single-market, AND-only, once-only, and its UI was a raw technical form. The
pivot requires: AND/OR/NOT logic, cross-market (@market) conditions, spread/time-window
blocks, repeat-with-cooldown recurrence, per-strategy spend limits for auto mode, a public
builder playground, and a plain-English rendering of every strategy.

## Decision

1. **DSL v2 in place, never rewriting stored rows.** `StrategyDefinition` (`version: 2`)
   lives beside v1 in the same `conditional_rules` table (additive migration `0009`). Stored
   v1 JSON and its `definition_hash` are untouched; a pure `normalizeDefinition(v1|v2) → v2`
   reader (`packages/rules/src/compat.ts`) feeds ONE evaluation path. An 8-scenario parity
   suite proves v1 rules behave identically under the v2 engine (`engine-v2.test.ts`).
2. **Expression tree over typed conditions.** `ExprNode = condition | group(and|or|not)`;
   conditions: price, spread, cumulative_notional, visible_levels, time_window — each
   market-bound condition carries its own `MarketRef`. Caps: depth ≤ 3, ≤ 12 conditions,
   ≤ 4 markets. The hold-for duration stays root-level (per-group timers deferred: they
   multiply accumulator state and make evidence much harder to explain).
3. **Fail-closed multi-market staleness.** If ANY referenced market's data is missing or
   older than `maxDataAgeMs`, the whole expression is unsatisfied and an in-progress hold
   window resets — even inside an OR whose other branch is fresh-and-true, and even under
   NOT inversion. Deliberately conservative; per-branch staleness is a possible future
   relaxation with its own ADR.
4. **Recurrence with worker-persisted bookkeeping.** `repeat {maxRepeats, cooldownMs}`:
   the state machine re-arms into a cooldown-gated ACTIVE_WAITING between triggers and ends
   in `COMPLETED` (alerts) or the v1 executor handoff (orders). `trigger_count` and
   `cooldown_until` are persisted so a worker restart can never reset repeat limits.
5. **Trigger evidence v2** adds per-market summaries + the full evaluation result tree while
   keeping the v1 flat fields; the hash stays tied to the ORIGINAL stored definition.
6. **API surface** (`apps/api/src/routes/smart-orders.ts`, `FEATURE_SMART_ORDERS_V2`):
   CRUD + controls + multi-token evaluate-now; **public** `POST /evaluate-draft` and
   `GET /api/markets/search` behind an in-repo per-IP sliding-window rate limiter
   (deliberate deviation from `@fastify/rate-limit`: single-process API per D-001, no new
   dependency, swap for a shared store before multi-instance). Arm-time validation
   re-checks structural caps, auto-mode limits, and tokenId↔conditionId consistency via
   Gamma (fail-closed on lookup errors). Gamma `/public-search` verified live 2026-07-08
   (`{events, tags}`), with a filtered `/events` scan fallback.
7. **Builder frontend**: `@xyflow/react` canvas (route-level dynamic import; the repo's one
   deliberate dependency addition — a drag/zoom node editor is months of bespoke work) +
   `zustand` draft store. One `StrategyDoc` is the single source of truth; the canvas, the
   clickable plain-English sentence, and the inspector are projections. The web app imports
   `@mx2/rules` directly (types + validator), eliminating type mirroring. Draft evaluation
   is server-side (snapshot-first, CLOB REST fallback) so the public playground shows live
   "would trigger now" state without an account; sign-in + allowlist gate saving only.
8. **Editing = create new + cancel old.** Definitions stay immutable once armed so evidence
   remains verifiable; the edit route rehydrates the builder from `definitionV2`.

## Consequences

- The worker subscribes to every token a strategy references (≤ 4), and one book event
  evaluates the full view map; WS fan-out grows with cross-market adoption (monitor at beta
  load; R-018 pattern applies).
- The legacy `/api/rules` surface only lists v1 rows; v2 lives at `/api/smart-orders`. The
  shared trigger-confirm flow is version-aware.
- Prepared-order strategies remain single-trigger; repeat is restricted to alert/auto by
  validation (each prepared order needs its own signature).
- Auto-mode remains fail-closed behind FEATURE_PRIVY_SIGNING + FEATURE_LIVE_TRADING +
  FEATURE_CONDITIONAL_LIVE_EXECUTION + relayer wiring (W-track) and per-strategy limits
  enforcement at execution time (W5) before any live enablement (Gate 6).
