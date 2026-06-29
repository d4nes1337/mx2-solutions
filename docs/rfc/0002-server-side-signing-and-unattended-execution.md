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
