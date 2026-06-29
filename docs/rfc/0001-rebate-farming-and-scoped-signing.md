# RFC-0001 — Idle Rebate Farming & Scoped Unattended Signing (STUB)

Status: **Draft / not approved — no implementation**
Date: 2026-06-24
Author: Senior Technical Lead
Depends on: ADR-0005 (Conditional Rules Engine)

> This is a forward-looking design stub recorded so the MVP conditional-rules engine
> preserves the right seams. **Nothing here is built.** Each phase below is a separate
> future loop with its own decision gate; the unattended-execution phase additionally
> requires a security RFC and legal sign-off.

## 1. Goal

Let a user run a **delta-neutral, two-sided market-making strategy** that farms Polymarket
**maker/liquidity rewards** on stable pre-event markets (e.g. a football match before
kickoff): rest two-sided quotes near mid, inside the reward band, hold net delta ≈ 0, and
cancel before volatility (kickoff/news). The same engine that powers conditional orders
(ADR-0005, layers L1–L3) drives the strategy; only the **Action (L4)** and **Execution
(L5)** layers change.

## 2. What the MVP engine already gives us (reuse, ~70%)

- L1 normalized, staleness/reconnect-aware market stream.
- L2 pure predicate evaluator + L3 deterministic, single-writer, audited state machine.
- Evidence + deterministic replay; kill-switch (`runtime_flags`); idempotent order
  intents; append-only audit; fail-closed config gating.

## 3. What is genuinely new (the hard ~30%, each its own loop)

- **Reward-data adapter:** read per-market reward params (`min_size`, `max_spread`,
  daily `rate`) from the CLOB rewards endpoints. (Feasibility to be confirmed against
  current docs in the loop that builds it; record findings in `docs/INTEGRATION_VERIFIED.md`.)
- **`QuoteStrategyAction` (L4):** on each evaluator tick, compute desired two-sided quotes
  (bid+ask within `max_spread` of mid, ≥ `min_size`), diff against live orders,
  cancel/replace, track fills, skew quotes to hold inventory/delta in band, and flatten +
  stop on risk/stale/market-status/time-to-event breach. Introduces a richer state machine
  (`QUOTING / SKEWING / FLATTENING / STOPPED`).
- **Inventory & risk controls:** target net delta, max inventory, max loss, capital cap,
  hard stop time (e.g. kickoff − N minutes).
- **Scoped unattended signer (L5) — the gated, dangerous part.** Replaces manual
  signature with a delegated/session key under tight limits: per-market, max size/notional,
  in-reward-band only, short expiry, server-enforced kill-switch, fully audited. Must never
  custody the user's primary wallet key. Requires its own security RFC + legal sign-off and
  flips `FEATURE_CONDITIONAL_LIVE_EXECUTION` (today forced off).

## 4. Proposed phased roadmap (post-MVP)

- **B — Robustness:** durable ordered event log + sequence/gap handling + advisory leasing +
  full 13-failure-mode replay (lifts RISK R-003, R-011).
- **C — Richer rules:** compound AND/OR, recurrence, volume/trade-flow + position-aware
  predicates, TP/SL/trailing.
- **D — Farmer in shadow:** reward-data adapter + `QuoteStrategyAction` that **computes and
  displays** desired quotes without placing them (still no unattended execution).
- **E — Gated unattended execution:** scoped session-signer security RFC + legal sign-off →
  controlled live quoting behind a new gate.
- **F — Profitability:** backtest harness over recorded reward epochs before any real
  capital. Maker rewards are a pooled share and adverse selection around goals/news can
  erase rebates — **economics are unvalidated** and must be proven here, not assumed.

## 5. Open questions (for the loop that picks this up)

- Exact reward scoring formula + two-sided multiplier; epoch/sampling cadence.
- Safest scoped-signing primitive (session key vs delegated relayer vs MPC/TEE) given the
  "never custody the primary key" invariant. **Resolved (2026-06-29):** Privy embedded wallet +
  server session signer + in-enclave policy engine (TEE) — see ADR-0006 and RFC-0002. Phase E's
  unattended execution is now built behind `FEATURE_CONDITIONAL_LIVE_EXECUTION` (gated, default
  OFF) rather than structurally impossible.
- Regulatory posture of operating an automated maker on behalf of users (legal review).
