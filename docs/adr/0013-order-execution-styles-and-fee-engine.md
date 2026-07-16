# ADR-0013 — Order execution styles and the fee engine

- Status: Built (2026-07-15)
- Owner decision: round-4 scope approved 2026-07-15 (see DECISIONS D-024)

## Context

Until round 4 every Smart Order submitted a plain GTC limit order and every projection,
backtest, and showcase number ignored fees. Polymarket's **Fee Structure V2** (verified
2026-07-15, INTEGRATION_VERIFIED §16–§17) makes that dishonest: taker fills on most
categories pay `shares × rate × (p(1−p))^exponent` (crypto 0.07, sports 0.05, …) while
makers pay **nothing** — so maker-vs-taker is now a first-class economic choice the user
should control per order step, and any "+$X" projection that assumes free aggressive
entries overstates results. The maker loop (ADR-0014) additionally needs `postOnly`
quoting and per-market fee/rewards data.

## Decision

1. **Execution style per order step.** `OrderActionV2` gains
   `orderType: "GTC" | "GTD" | "FOK" | "FAK"`, `postOnly?` (GTC/GTD only — never
   crosses, guaranteeing the maker fee posture) and `expiresAfterMs?`. GTD semantics: the
   value is an **entry window anchored to trigger time**; the wire expiration is
   `trigger + window + 60 s` to compensate for Polymarket expiring GTD orders ~1 minute
   **before** the stated timestamp; validation floors the window at **180 s** (the
   effective CLOB minimum is ≈ 3 min), so sub-3-minute entry windows must use FAK
   instead — an accepted upstream constraint (INTEGRATION_VERIFIED §20).
2. **Pure fee math in `packages/rules/src/fees.ts`.** `takerFeeUsd` implements the V2
   formula; `takerCrossCost` walks an orderbook to price a marketable entry's
   fee + price impact + fillability in one pass. Zero-dep and shared web+api, exactly
   like `simulate.ts`.
3. **Fee source of truth + "unknown, never zero".** Authoritative: CLOB
   `GET /clob-markets/{condition_id}` `fd = {r, e, to}`; fallback: Gamma
   `feeSchedule{rate, exponent, takerOnly, rebateRate}`. When neither resolves the fee
   is `null` and every surface displays **unknown** — a missing schedule is never
   rendered as $0. Gamma's legacy `makerBaseFee`/`takerBaseFee` (both read 1000) are
   excluded from cost math (INTEGRATION_VERIFIED §17).
4. **Fee-aware projections and backtests for taker entries.**
   `packages/rules/src/simulate.ts` takes an optional `feeSchedule` parameter;
   `apps/web/lib/smart-orders/projection.ts` subtracts entry fees for FOK/FAK steps, so
   showcases, cockpit scenarios, and the builder ProjectionCard stay mutually consistent
   (they all share the simulator).
5. **Public economics endpoint.** `GET /api/markets/:conditionId/economics`
   (rate-limited, 5-min in-memory cache) merges the fee schedule, the liquidity-rewards
   config (`rate_per_day`, min size, max spread) and the rebate rate for the cockpit,
   the builder inspector, and the MakerEstimator — which now shows real $/day pool
   rates instead of the earlier "no dollar promised" placeholder posture.

## Alternatives considered

- Hardcoding the published per-category rate table: rejected — rates have already moved
  twice (sports 0.03 → 0.05 on 2026-07-10) and per-market `fd` is the authoritative
  override; live discovery with a fallback chain tracks reality.
- Treating an unresolvable fee as 0 (the pre-round-4 implicit behavior): rejected —
  understating costs is the one direction the product must never err in (R-023 posture).
- Exposing raw upstream fee endpoints to the client: rejected — one cached server
  endpoint bounds upstream load and gives a single seam for drift handling (R-029).

## Consequences

- Maker entries (GTC/GTD + `postOnly`) honestly show $0 fee; taker entries (FOK/FAK)
  show a real cost line including impact; unknown schedules show "fee unknown".
- Every simulator-powered number moved slightly (downward for taker entries) the moment
  fees landed — accepted and correct.
- Fee/rewards endpoint drift is a new monitored risk (R-029): tolerant `.passthrough()`
  schemas + fixtures; nothing money-moving consumes these endpoints.
- The GTD 180 s floor is a documented UX paper-cut: the builder steers sub-3-minute
  windows to FAK rather than silently stretching them.
