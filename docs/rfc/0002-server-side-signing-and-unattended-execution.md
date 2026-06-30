# RFC-0002 — Server-side signing & unattended conditional execution

Status: **Draft — built behind flags (default OFF); live enablement pending owner sign-off (Gate 6)**
Date: 2026-06-29
Author: Senior Technical Lead
Depends on: ADR-0006 (Privy embedded wallets), ADR-0005 (rules engine), RFC-0001 (§E gate)

This is the security RFC that RFC-0001 §5/Phase E requires before flipping
`FEATURE_CONDITIONAL_LIVE_EXECUTION`. It covers the threat model, key custody, guardrails,
and the operational runbook for "sign once" trading.

## 1. Goal & scope

Sign once at login, then (a) place manual orders with no per-order popup, and (b) let
conditional rules auto-submit on trigger — no human. In scope: the signing seam, Privy
integration, allowance bootstrap, the auto-execution path, guardrails. Out of scope: the
continuous market-making strategy (RFC-0001 D/E).

## 2. Architecture (what was built)

- **Signing seam** `@mx2/trading-signer` (`TradingSigner`): Privy adapter (prod) + mock
  local-key adapter (tests / live-OFF dry-run). Both the manual route and the worker depend
  only on the interface.
- **Order construction** in `@mx2/polymarket-client` (`buildAndSignEoaOrder`, `signatureType 0`).
- **Per-user state** `privy_wallets` (Privy refs + embedded address + allowance marker) and
  `trading_delegations` (time-bounded consent). No key material is stored.
- **Manual path** `POST /api/trade/orders` (Privy mode): server builds + signs + submits.
- **Unattended path** `apps/worker/auto-executor.ts`: on an "auto" rule trigger, build + sign +
  submit with fail-closed guards; new rule states `EXECUTING → EXECUTED_AUTO | EXECUTION_FAILED`.
- **Crypto** moved to `@mx2/core` so the worker can decrypt L2 creds in-process.

## 3. Threat model & key custody

| Asset                                | Where it lives               | Compromise impact                 | Mitigation                                                                                                        |
| ------------------------------------ | ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| User primary key                     | User's wallet only           | —                                 | Never custodied or touched.                                                                                       |
| Trading key                          | **Privy enclave (TEE)**      | Cannot be exported                | Never in our DB/process; signing is delegated + policy-bounded.                                                   |
| Privy app secret + authorization key | Server env / secrets manager | Lets server _request_ signatures  | Policy engine still bounds destinations to Polymarket; bounded wallet balance; rotation; staging≠prod; redaction. |
| L2 CLOB creds                        | DB, AES-256-GCM              | Request auth only (not order sig) | Encrypted, versioned key, re-derivable.                                                                           |

Worst case (server + app-secret compromise): an attacker can place **Polymarket orders** with a
user's bounded embedded-wallet balance, but **cannot exfiltrate funds** to an arbitrary address
(Privy policy denies non-allowlisted contracts) and cannot touch the primary wallet. The kill
switch halts signing within seconds.

## 4. Guardrails (defense in depth)

1. **Privy policy engine** (in-enclave): allowlist USDC + CTF + the exchanges only — the
   destination backstop. _(Baseline; not user-toggleable.)_
2. **Delegation expiry + re-auth** (`SESSION_SIGNER_TTL_SECONDS`): signing requires an active,
   unexpired delegation; checked on every manual + auto order.
3. **Order rate limit** (`ORDER_RATE_LIMIT_PER_MIN`, DB-backed `order_intents` count): shared by
   manual (429) and auto (skip) paths — caps a runaway loop / leaked session.
4. **Kill switch** (`runtime_flags.trading_paused`): halts both paths, no caching.
5. **Allowance bootstrap fail-closed**: orders are refused until approvals are confirmed.
6. **Feature-flag gating**: `FEATURE_CONDITIONAL_LIVE_EXECUTION` requires `FEATURE_PRIVY_SIGNING`
   - `FEATURE_LIVE_TRADING`; all default OFF; config throws on a half-enabled state.
7. **Idempotency**: deterministic key `auto:<ruleId>:<triggerId>` — no double-submit across
   restarts. Single-writer worker + compare-and-set rule transitions.

(Per-order and total-notional caps were de-scoped by the owner; the plug-in points remain in
the order service + Privy policy `value` conditions.)

## 5. Fail-closed behavior

Every auto-exec guard failure either **degrades to manual** (leaves the trigger awaiting_user)
or marks `EXECUTION_FAILED` — never silently proceeds. Privy outage → signing fails closed.
Unknown CLOB submit result → no blind retry (reconcile).

## 6. Residual risks / open items

- Privy availability is a hard dependency for all trading (fail-closed, kill-switchable).
- Exact Privy `policies()` / session-signer API + the on-chain allowance spender set are pinned
  but **must be confirmed on staging** (see `docs/ASSUMPTIONS.md`).
- Worker crash mid-execution can leave a rule `EXECUTING` (not re-evaluated); the deterministic
  idempotency key prevents double-submit on manual recovery. Operator runbook item.
- Geoblock must be restored at the trading layer before staging (R-005); auto-exec has no
  per-request IP, so geoblock must be enforced at provision/delegate/rule-creation time.

## 7. Runbook

- **Pause everything:** `POST /api/admin/trading/pause` (kill switch).
- **Revoke a user's authority:** `POST /api/trading-wallet/revoke` (+ revoke in Privy).
- **Rotate secrets:** rotate Privy app secret + authorization key; bump encryption key version.
- **Enable (Gate 6):** owner approves → set `FEATURE_PRIVY_SIGNING=true`, fund a Privy test
  wallet with $5–20, bootstrap allowances, run one tiny manual order + one tiny auto rule,
  verify on-chain + CLOB + audit + the policy negative test, then consider `FEATURE_LIVE_TRADING`
  - `FEATURE_CONDITIONAL_LIVE_EXECUTION`.

## 8. Legal

Operating automated order placement on behalf of users needs the same legal sign-off flagged in
RFC-0001 §5 and D-004 (geoblock) before any production enablement.

## 9. Staging validation (2026-06-30) — arima.finance

Deployed the full all-in-one stack to the production box (arima.finance, Docker + Caddy) and ran
the Gate 6 sequence end-to-end against the **real** Privy API + Polygon mainnet + Polymarket CLOB.

**✅ Validated and working in production:**

- Privy wallet provisioning (an app-managed server wallet owned by the configured key quorum).
- **"Sign once, no popup"** order + ClobAuth signing inside the Privy enclave.
- On-chain allowance approvals (`USDC.approve` + `CTF.setApprovalForAll`) signed by Privy, under
  the policy, confirmed on-chain.
- The contract-allowlist **policy as the destination backstop** — the **negative test PASSED**: a
  `USDC.transfer` to a non-exchange address was **DENIED** by the policy.
- L2 CLOB credential derivation (server-side ClobAuth signing).

**Policy fixes folded into `createPolymarketTradingPolicy` (`packages/trading-signer/src/privy-client.ts`):**

- Transaction rules must target **`eth_signTransaction`** (viem signs via Privy then broadcasts the
  raw tx itself, so Privy's policy sees the SIGN method) — the original `eth_sendTransaction` denied
  everything. Both methods are now allowed.
- `ethereum_calldata` `field` is `functionName.argumentName` (e.g. `approve.spender`) and its
  address `value` must be **lowercase**; the `to` value is the checksummed contract address.
- A separate **`eth_signTypedData_v4`** rule (scoped to chainId 137) is required for order/auth
  signing. (`personal_sign`/`secp256k1_sign` are intentionally NOT allowed.)

**🔴 BLOCKER — Polymarket deposit-wallet requirement (RISK R-001 materialized):**

The CLOB rejects orders from our wallet with `"maker address not allowed, please use the deposit
wallet flow"` — for **both** the bare EOA (`signatureType 0`) **and** its counterfactual derived
proxy (`signatureType 2`). Polymarket only accepts orders from a proxy that was created + registered
through **Polymarket's own deposit onboarding** (their relayer deploys/registers it; funds live in
the proxy). Our Privy embedded wallet signs correctly but is not a registered Polymarket trader. The
signing path is correct — this is a Polymarket platform constraint that only surfaces against the
live CLOB.

**TODO to finish live trading (the remaining integration):**

1. **Deposit-wallet / relayer onboarding** for the Privy EOA: deploy + register the Polymarket proxy
   (the deferred `FEATURE_RELAYER` path — see `builder-relayer-client` in
   `docs/INTEGRATION_VERIFIED.md`), move funds into the proxy, and set the proxy's allowances.
2. **Re-key the order path to `signatureType 2`**: maker/funder = the registered proxy, signer = the
   Privy EOA. Today `buildAndSignEoaOrder` uses `signatureType 0` / the bare EOA.
3. **Withdrawal path**: the policy denies all transfers, so funds are locked to Polymarket. Add a
   per-user rule allowing `USDC.transfer` to the user's own registered address (or operator-assisted
   withdrawal) before onboarding real users.
4. **Re-run the Gate 6 order + auto-rule** once the deposit-wallet flow is in place; restore route
   geoblock (R-005) before opening to beta users.

**Current live state on the box:** `FEATURE_PRIVY_SIGNING=true`, `FEATURE_LIVE_TRADING=false`,
`FEATURE_CONDITIONAL_LIVE_EXECUTION=false`. Working policy id `ka7qnt4o4otovh5y91n1quua`. Test wallet
`0xB282e01348E7AaCde4DCB384302c8EFB34593296` holds ~2.38 USDC.e + 10 POL (policy-locked; return via
a withdrawal rule when convenient).
