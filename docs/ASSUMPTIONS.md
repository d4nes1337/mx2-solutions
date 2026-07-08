# Assumptions Register

Status legend: **OPEN** (needs owner/legal input) · **WORKING** (acting on it until corrected) ·
**RESOLVED**.

## Geo / compliance posture

| ID    | Assumption / question                                                                                                                                                                                                  | Status           | Impact if wrong                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| A-001 | **Geo posture (owner decision 2026-06-22):** ship the read-only public product without geo gating; enforce Polymarket geoblock fail-closed **only at the trading/execution layer**. Read-only work is fully unblocked. | RESOLVED (D-004) | Read-only proceeds. Residual: a legal sign-off on live trading is still advised before Gate 4. |

## Product / scope

| ID    | Assumption                                                                                                                                            | Status                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A-010 | P0/P1 boundary is exactly as written in `…/docs/02_MVP_SCOPE_ACCEPTANCE_RU.md`; no P1 feature is built without separate approval.                     | WORKING                      |
| A-011 | First external beta is **read-only** (feed, cockpit, shadow rules, simulated/illustrative PnL). Manual trading is staging-only until a separate gate. | RESOLVED (owner, 2026-06-22) |
| A-012 | Conditional rules ship **shadow/alert/manual-confirm only** in MVP 0.1. No unattended execution.                                                      | RESOLVED (doc + owner)       |
| A-013 | "Beta cohort" users are crypto-native and can connect a wallet; we are not building custodial onboarding.                                             | WORKING                      |

## Wallet / signing

| ID    | Assumption                                                                                                                                                                          | Status           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| A-020 | MVP supports **only** the Deposit Wallet + `POLY_1271` path via the V2 TS SDK + relayer. EOA/legacy Safe/Proxy paths are deferred.                                                  | RESOLVED (owner) |
| A-021 | The ERC-7739-wrapped `POLY_1271` order signing can be produced client-side by the V2 SDK in-browser; to be proven in the integration spike before Gate 4.                           | OPEN (spike)     |
| A-022 | Per-user L2 CLOB creds are stored server-side encrypted (versioned master key) so the backend can HMAC L2 management/query calls. Orders still need the user's per-order signature. | WORKING          |

## Architecture / ops

| ID    | Assumption                                                                                                                          | Status                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| A-030 | Target stack is the TS modular monolith + worker (ADR-0001, Option A).                                                              | RESOLVED (Gate 1, 2026-06-22) |
| A-031 | Infra target ~ EU Ireland single VPS + managed PostgreSQL, ~$120–130/mo (per `…/docs/07`).                                          | WORKING                       |
| A-032 | Owner manages all secrets (encryption master key, session secret, DB password, relayer key). None are shared with Claude.           | RESOLVED (doc)                |
| A-033 | The 8 product brief docs stay in the gitignored inbox and are **not** committed; governance artifacts + ADRs are committed at root. | RESOLVED (owner)              |

## Auth / session

| ID    | Assumption                                                                                                                                                        | Status  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A-042 | `https://data-api.polymarket.com` is the correct public Data API base URL for position/activity queries. Not yet verified against live official docs.             | WORKING |
| A-043 | DB-backed sessions (not JWTs) are appropriate for the 50–100 beta cohort. If scale increases significantly, consider stateless tokens with a revocation denylist. | WORKING |

## PnL

| ID    | Assumption                                                                                                                                                        | Status  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A-040 | MVP PnL = realized (observed fills + redemptions) + unrealized (mark − avg cost)·size, with provenance and explicit limitations; full event-sourced ledger is P1. | WORKING |
| A-041 | Pre-onboarding history, transfers, and split/merge/redeem accounting cannot be fully reconstructed in MVP and will be labeled as such.                            | WORKING |

## Server-side signing (ADR-0006 / RFC-0002)

| ID    | Assumption                                                                                                                                                                                                                                                                                  | Status              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A-044 | Privy `@privy-io/node` server SDK exposes wallet create + `signTypedData` (EIP-712) + `sendTransaction` for a delegated session signer, and a policy engine to allowlist contracts. SDK method names/shapes pinned in ADR-0006 but **to confirm against the installed version on staging.** | TO VERIFY (Gate 6)  |
| A-045 | Polymarket CLOB accepts `signatureType 0` with `funder == signer == maker == the embedded EOA`; balances/positions read off that EOA; L2 HMAC `POLY_ADDRESS` = that EOA.                                                                                                                    | TO VERIFY (staging) |
| A-046 | Allowance spender set for `signatureType 0` = USDC `approve` + CTF `setApprovalForAll` to the CTF Exchange V2 + Neg-Risk Exchange V2 (and possibly the neg-risk adapter); USDC = bridged USDC.e.                                                                                            | TO VERIFY (staging) |
| A-047 | Gas for allowance + on-chain ops from the embedded wallet is covered (Privy paymaster vs POL balance on the wallet). Funding model to confirm.                                                                                                                                              | TO VERIFY (Gate 6)  |
| A-048 | Server-side ClobAuth signing (no browser popup) is accepted by the CLOB to derive L2 creds for the embedded address.                                                                                                                                                                        | TO VERIFY (staging) |

## Smart Orders auto-mode (ADR-0010 / D-019)

| ID    | Assumption                                                                                                                                                                                                                                                           | Status              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A-049 | Privy session-signer grants remain usable for the full 14–30d app-side delegation window; `/delegate/refresh` only extends OUR ledger and never re-grants. If the Privy-side grant expires sooner, signing fails closed and the user must re-consent in the browser. | TO VERIFY (staging) |
| A-050 | Polymarket maker rewards parameters (min size/spread bands, daily pools) are readable per-market from Gamma market fields (`rewardsMinSize`, `rewardsMaxSpread`, …) for the reward-aware maker estimator.                                                            | TO VERIFY           |
