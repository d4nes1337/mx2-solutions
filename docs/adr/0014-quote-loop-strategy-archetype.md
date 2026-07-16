# ADR-0014 — `quote_loop` strategy archetype

- Status: Built shadow-only (2026-07-15) behind `FEATURE_MAKER_LOOP`; live enablement gated by RFC-0003
- Owner decision: maker-loop path approved 2026-07-15 (see DECISIONS D-024, RFC-0003)

## Context

RFC-0001 sketched rebate farming (phases D/E) as a future `QuoteStrategyAction` with its
own state machine, and the owner has now approved building the full auto maker quoting
loop — shadow-first, dark behind flags (D-024). The structural question: is a continuous
quoting loop a **new entity** (own table, own API, maybe own service), or a **strategy
archetype** on the existing `conditional_rules` machinery that already carries
immutability, evidence hashing, wallet scoping, audit, kill flags, and a list UI?

## Decision

1. **A fourth ActionV2 kind, not a new entity.** `quote_loop` rows live in
   `conditional_rules` beside alert/order/auto strategies and inherit definition
   immutability, `definitionHash` evidence, wallet scoping, append-only audit, the
   Smart Orders list UI, and every existing kill flag — no parallel
   auth/immutability/audit surface to build or get wrong.
2. **The expression tree is an optional GATE.** An empty expression means always-on
   quoting; `EXPR_EMPTY`/`GROUP_EMPTY` validation is relaxed **only** for `quote_loop`
   (still enforced for every other kind). A non-empty tree gates quoting on live market
   conditions (e.g. spread band, time window before kickoff) using the unchanged v2
   evaluator semantics.
3. **Worker routing.** The rule evaluator explicitly **skips** `quote_loop` rows; a new
   `QuoterManager` (`apps/worker/src/quoter/{engine,executor,manager}.ts`) owns their
   lifecycle on its own cycle cadence. One worker remains the single writer (D-001).
4. **Pure engine, anti-runaway by construction.** `computeDesiredQuotes` produces a
   YES bid at `mid − s` plus a NO bid at `(1 − mid) − s` (both postOnly-style — the
   delta-neutral two-sided shape, INTEGRATION_VERIFIED §22); `diffQuotes` computes the
   cancel/place set with the **idempotence property `diff(x, x) = ∅` as the
   anti-runaway invariant**, property-tested across the whole quotable range — a stable
   book can never generate churn; `inventoryPlan` merges accumulated YES+NO pairs once
   they reach a quarter-quote threshold; capital and daily-loss caps are computed inside
   the engine, not the executor.
5. **Shadow executor only today.** The executor records every intended
   place/cancel/merge as events; nothing signs, submits, or touches the relayer. The
   live executor is a later RFC-0003 checkpoint, not part of this ADR's build.
6. **DB: migration `0010_quote_sessions.sql`.** `quote_sessions` (per-rule scoreboard:
   mode, status, inventory, committed capital, realized PnL, daily loss, rewards
   accrued), `quote_events` **append-only** with UNIQUE idempotency keys
   `quoter:<ruleId>:<cycleMs>:<action>:<token>` (the DB-level anti-replay guard), and
   `reward_accruals` (the economics-validation dataset for RFC-0003 checkpoint 5).
7. **API** (`apps/api/src/routes/quoter.ts`): `GET /api/quoter/sessions/:ruleId`
   (+ `/events` cursor), `POST …/mode`, `POST …/halt`, `POST …/resume`. Mode escalation
   beyond shadow is audited (`quoter.mode_changed`) and **blocked without
   `FEATURE_MAKER_LOOP_LIVE`** — and config itself refuses to boot with that flag on
   unless every underlying flag plus the on-chain-verified adapter addresses are present
   (R-028).

## Alternatives considered

- **Separate table/entity for quoting strategies:** rejected — duplicates
  auth, audit, immutability, kill-switch plumbing, and the list UI for zero isolation
  benefit; the archetype gets all of it by construction.
- **Separate quoting service/process:** rejected — a premature distributed system
  (D-001); the single worker is already the single-writer host, and the manager is a
  clean seam if quoting ever needs to move out.
- **Reusing the auto-executor path per tick:** rejected — quoting is a continuous
  diff-and-reconcile loop, not a trigger→order edge; forcing it through trigger
  semantics would corrupt both state machines.

## Consequences

- Quote loops appear in the Smart Orders list beside ordinary strategies for free;
  pause/cancel/kill controls behave uniformly.
- The relaxed empty-expression validation is scoped to `quote_loop` only and covered by
  tests; every other kind still rejects empty groups.
- Live enablement is deliberately **not** a flag flip: the RFC-0003 rollout ladder,
  adapter verification (R-028), and shadow accrual validation (R-030) all sit in front
  of it. The live executor additionally depends on the W4 deposit-wallet order path or
  a CLOB-creds scoping decision (RFC-0003 §7).
- `quote_events` grows with cycle cadence; append-only with an id cursor — prune/archive
  policy is an ops item before long shadow soaks on many markets.
