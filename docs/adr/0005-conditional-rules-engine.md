# ADR-0005 — Conditional Rules Engine (Slice 5 / Gate 5 — shadow / alert / manual-confirm)

Date: 2026-06-24
Status: **Accepted (MVP slice built; Gate 5 owner review pending)**
Deciders: Owner (PM/BA), Senior Technical Lead

---

## Context

Conditional orders are the product's marquee feature (`docs/04_CONDITIONAL_ORDERS_RU.md`,
MVP scope §2.6, Gate 5) and the owner wants the same engine to later underpin an "idle
rebate farming" product — a delta-neutral, two-sided market-making strategy that farms
Polymarket maker rewards on stable pre-event markets. The security invariants and the
config (`FEATURE_CONDITIONAL_LIVE_EXECUTION` is forced **off**, throwing if set true)
forbid any unattended real-money execution in MVP 0.1. A rule may only **observe**, prove
a **trigger**, **alert**, and prepare an order for **manual confirmation + wallet signature**.

## Decision

### One engine, five layers

The conditional-order feature and the future rebate farmer are modelled as the same
machine with two swappable layers:

| Layer | Responsibility                                                   | MVP                                       | Rebate farmer (future)                            |
| ----- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| L1    | Normalized market-event stream (staleness/reconnect-aware)       | reuse `MarketWsClient`                    | shared                                            |
| L2    | Pure predicate evaluator                                         | `@mx2/rules`                              | shared                                            |
| L3    | Continuous-duration state machine (single-writer, deterministic) | `@mx2/rules`                              | shared                                            |
| L4    | **Action**                                                       | `PrepareOrderAction` (one order → manual) | `QuoteStrategyAction` (continuous 2-sided quotes) |
| L5    | **Execution**                                                    | manual confirm + fresh wallet signature   | scoped _unattended_ signer (gated RFC)            |

L1–L3 + evidence + replay + kill-switch are shared. Only L4/L5 differ — see
`docs/rfc/0001-rebate-farming-and-scoped-signing.md`.

### Engine in a new pure package `@mx2/rules`

Predicates, evaluator, state machine, evidence, and replay are pure functions with **no
I/O** (`packages/rules`). Purity makes them deterministic and replayable (docs/04 §8) and
keeps the dangerous concerns (persistence, signing, submission) outside the core. The L4
`RuleAction` is a discriminated union so a future `QuoteStrategyAction` slots in without
touching L1–L3.

### State machine + fail-closed timer

States per docs/04 §4 (`DRAFT → ACTIVE_WAITING → ACTIVE_ACCUMULATING →
TRIGGERED_AWAITING_USER → EXECUTED_MANUALLY`, plus `PAUSED/EXPIRED/CANCELLED/INVALIDATED/
ERROR`). During accumulation, **any** of {predicate false, data stale, reconnect, market
pause, tick-size change} resets the window; market close/resolve → `INVALIDATED`. Recurrence
defaults `once`; `TRIGGERED_AWAITING_USER` is terminal until explicit re-arm, so a rule
triggers at most once.

### Single-writer in the worker; compare-and-set for control

The evaluator runs only in `apps/worker` (one process, D-001), giving single-writer
semantics for evaluation state. The API owns user-control transitions (pause/resume/
cancel). Coordination uses **compare-and-set**: the worker's `updateEvaluationState`
only applies while the rule is still `ACTIVE_*`, so a concurrent user pause/cancel wins
and the worker drops the rule. This also enforces single-trigger at the DB layer.

### Manual confirmation reuses the existing trading path

A trigger writes a `rule_triggers` evidence row + audit event — **never** an order. The
confirm flow fetches a fresh snapshot, recomputes whether the condition still holds, shows
a fresh preview, and reuses the existing `POST /api/trade/orders` (idempotency key
`trigger:<id>`), then links the order intent back to the trigger. No new signing path
exists; unattended submission has no code path and `FEATURE_CONDITIONAL_LIVE_EXECUTION`
throws.

## Consequences

- **Positive:** ~70% of the rebate farmer's substrate is built with no speculative code;
  the hard correctness (L2/L3) is pure and unit/replay-tested; unattended execution is
  structurally impossible; reuses worker, WS staleness/reconnect, audit, kill-switch,
  idempotency, and the preview/submit path.
- **Negative / deferred (see RISK R-003, R-011):** single-worker is a correctness crutch —
  multi-worker leasing, durable per-event log, and exhaustive 13-failure-mode replay are
  deferred; MVP evaluates on full `book` messages (markets emitting mostly deltas may
  under-accumulate — fail-closed, safe); the live view uses the local receive clock for
  staleness (upstream clock-skew handling deferred); neg-risk triggered orders default
  `negRisk=false` in the confirm modal (gated behind the live-trading flag).

## Alternatives considered

- **Fold the engine into `packages/core`** — rejected; mixes the pure rule engine with
  unrelated shared types and weakens the reuse seam the brief asks to preserve.
- **Evaluate inside the API** — rejected; the API is multi-instance-capable and stateless,
  which would break single-writer determinism. The worker is the correct host.
- **Persist every book event for replay** — rejected for MVP; docs/04 §5 only requires
  replay of the active window. We keep an in-memory window and materialize evidence at
  the trigger; a durable event log is a future-loop item.
