# ADR-0017: Wallet Funds and Bridge Funding

Date: 2026-07-17

Status: Built scaffold; Bridge production rollout pending staging acceptance

## Context

The wallet screen exposed two equal trading modes and scattered setup actions across account cards.
That forced users to understand signing architecture before doing the real job: enable trading,
add funds, and withdraw safely. The Funds sheet also treated direct Polygon USDC.e as the full
top-up story even though Polymarket Bridge supports a dynamic catalog of chains and assets that
convert into pUSD on Polygon.

Official Bridge assets are not stable enough to hardcode. On 2026-07-17, the live catalog returned
220 assets across 13 chains, while static docs/examples lagged the live set. Money movement must
also preserve existing invariants: no primary key custody, owner-login-wallet-only withdrawals
(D-026), fail-closed geoblock at execution/money-movement boundaries, and live flags off by default.

## Decision

Implement the wallet rework as a guided funds/access flow:

- `/wallet` leads with "Enable trading" and a single next-best action.
- Readiness order is Create -> Activate -> Fund -> Authorize -> Trade.
- The spendable deposit-wallet balance is labeled pUSD.
- Direct Polygon USDC.e funding remains the default-on path.
- Polymarket Bridge gets a typed `BridgeClient` adapter in `@mx2/polymarket-client`.
- `FEATURE_BRIDGE_FUNDING` and `FEATURE_BRIDGE_WITHDRAWALS` default off.
- `GET /api/funds/assets` returns the dynamic Bridge catalog only when Bridge funding is enabled.
- `POST /api/funds/deposit-addresses` is authenticated, geoblocked, audited, and derives the
  active internal deposit wallet server-side. The browser never supplies the pUSD destination.
- Bridge withdrawals stay disabled until quote binding, idempotent ledger/reconciliation, and
  status polling are implemented.

## Consequences

Users now see one setup path instead of an architecture fork. The frontend can show multi-chain
funding choices when staging enables Bridge funding, but production behavior remains unchanged by
default.

The first Bridge slice intentionally does not claim full transfer tracking. Before production
Bridge rollout, add:

- quote binding with amount/min/fee/ETA display;
- deposit status polling and history;
- low-value staging deposits on one EVM L2 and one non-EVM route;
- support/recovery copy for stuck provider transfers;
- Bridge withdrawal ledger and reconciliation, still owner-login-wallet-only unless a later gate
  approves arbitrary destinations.
