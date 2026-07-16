# RFC-0003 — Maker-loop live quoting ("rebate farming")

Status: **Approved for shadow build; live enablement gated per the checkpoints below**
Date: 2026-07-15
Author: Senior Technical Lead
Depends on: ADR-0014 (`quote_loop` archetype), ADR-0013 (fee engine), RFC-0002 (signing/guardrails)
Supersedes: RFC-0001 phases D/E for the rebate-farming path

This is the rollout-governance RFC for the full auto maker quoting loop the owner
approved in the round-4 session (D-024). It defines what shipped (shadow-only), the
scoped lift of the MVP unattended-execution restriction, the kill switches and caps, and
the checkpoint ladder that gates every step toward live quoting.

## 1. Goal & economics

Run a **delta-neutral two-sided quoting loop** per market that farms Polymarket
**liquidity rewards** (minutely-sampled, midpoint-proximity-scored daily USDC pools —
INTEGRATION_VERIFIED §19) and **maker rebates** (daily pro-rata redistribution of
15–25% of collected taker fees — §18). The shape: bid YES at `mid − s` and bid NO at
`(1 − mid) − s`; filled pairs cost `1 − 2s` combined and merge back to $1 of collateral
via the CTF adapters (§21), so each merged pair nets `+2s` before adverse selection —
and **makers pay no fees at all** under Fee Structure V2 (§16). Bidding YES and NO this
way IS two-sided quoting on the unified book (§22); official Polymarket MM docs teach
split/merge as inventory management, and wash-trading rules target self-dealing, not
two-sided quoting.

## 2. What shipped (shadow-only, behind `FEATURE_MAKER_LOOP`)

Per ADR-0014: the `quote_loop` strategy archetype on `conditional_rules`; the pure
quoter engine (`computeDesiredQuotes` / `diffQuotes` with the property-tested
anti-runaway invariant `diff(x, x) = ∅` / `inventoryPlan` / cap math); the **shadow
executor** (records intended place/cancel/merge actions, signs nothing); migration
`0010` (`quote_sessions` scoreboard, append-only `quote_events` with UNIQUE idempotency
keys, `reward_accruals`); the quoter API (session/events/mode/halt/resume); the relayer
`execute({to, data, value}[])` seam + CTF merge calldata builder; and the read-only
on-chain verification script `apps/api/src/scripts/verify-ctf-adapters.ts`
(`getCode` + simulated merge against the configured adapter addresses).

## 3. The lifted restriction (owner-approved, scoped)

The MVP invariant "no unattended conditional execution in MVP 0.1" is **lifted
specifically and only for the maker loop**, by explicit owner approval (D-024,
2026-07-15), **conditional on the checkpoint ladder in §6** — each rung requires its own
owner sign-off recorded in `DECISIONS.md`. Ordinary conditional rules keep their
existing posture (RFC-0002 gating unchanged). Config enforces the ladder mechanically:
`FEATURE_MAKER_LOOP_LIVE=true` refuses to boot unless `FEATURE_MAKER_LOOP`,
`FEATURE_LIVE_TRADING`, `FEATURE_PRIVY_SIGNING`, `FEATURE_RELAYER`, and both verified
CTF adapter addresses are present.

## 4. Kill switches (checked every cycle)

1. `runtime_flags.trading_paused` — the global kill switch halts quoting like all trading.
2. `runtime_flags.quoter_paused` — halts every quote loop without touching manual trading.
3. `rule_auto_disabled:<id>` — per-strategy kill, shared with the auto-executor.
4. **Per-session halt/resume** (`POST /api/quoter/sessions/:ruleId/halt|resume`) — user
   and operator control.
5. **Halted-on-breach is terminal**: any cap breach cancels all quotes and halts the
   session; it stays halted until the user explicitly resumes. No automatic restart.

## 5. Caps (validated at arm time)

`maxInventoryShares`, `maxCapitalUsd`, and `maxDailyLossUsd` are required on every
`quote_loop` definition and validated at arm time; the engine computes headroom against
the session scoreboard every cycle and shrinks or withdraws quotes rather than exceed a
cap. Daily-loss accounting survives restarts (persisted on `quote_sessions`).

## 6. Rollout ladder (owner sign-off per checkpoint, recorded in DECISIONS.md)

1. **Shadow soak ≥ 1 week on production data.** Exit criteria: drift metrics from
   `quote_events` look sane (quote placement/cancel cadence, simulated inventory,
   simulated merge economics) and **zero idempotency-key violations**.
2. **On-chain adapter verification.** `verify-ctf-adapters` passes against the
   configured `CTF_ADAPTER_ADDRESS` + `NEG_RISK_CTF_ADAPTER_ADDRESS` and the result is
   recorded in `docs/INTEGRATION_VERIFIED.md`. **This checkpoint BLOCKS everything
   below it** (R-028: the docs contracts page and the ctf-exchange-v2 README disagree
   on adapter addresses, so the addresses are config-required with no defaults).
   Also decided here: the live executor's order path — the W4 deposit-wallet order
   path (auto-executor step 10) OR scoping live quoting to CLOB-creds accounts (§7).
3. **Confirm mode on ONE low-value market** ($20–50 caps) via the staging wallet:
   every action proposed by the engine is manually confirmed before submission.
4. **Live mode with minimum caps** on that market + a **kill-switch drill** (operator
   pauses via each switch in §4 and verifies quotes are cancelled within one cycle).
5. **GA gate:** economics validated with **real accrual data** — rewards + rebates ≥
   costs (spread paid, adverse selection, merge gas if any) over a meaningful window
   (R-030) — plus legal/geoblock review: the R-005/R-015 interplay means geoblock must
   be enforced at rule creation AND at every mode escalation, since a running loop has
   no per-request IP.

## 7. Open decision (checkpoint 2)

The shadow engine is order-path-agnostic, but the **live** executor must either wait for
the W4 deposit-wallet order path (relayer allowances + server-side ClobAuth +
deposit-wallet `POLY_1271` submission — the same blocker as live auto-mode, R-017) or
scope live quoting to accounts with existing CLOB credentials and a registered deposit
wallet. Decide at checkpoint 2 with whatever W-track progress exists then.

## 8. Economics risk (why GA can fail)

Liquidity-reward pools pay a fixed `rate_per_day` **shared pro-rata against competing
makers** scored on size × proximity; rebates redistribute a fraction of taker fees the
same way. Both shrink per-participant as competition grows, while spread capture pays
only `2s` per merged pair minus adverse selection around news. **The strategy's
profitability is unvalidated and must be proven from shadow-phase accrual data before
GA** — if rewards < costs at realistic competition, the loop stops at checkpoint 5 and
the feature stays a research artifact (R-030). This is a designed-in outcome, not a
failure mode.
