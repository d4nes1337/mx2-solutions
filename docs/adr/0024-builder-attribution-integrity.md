# ADR-0024 — Builder attribution integrity + V2 SDK refresh

- **Status:** Accepted (owner-approved plan, 2026-07-23; Slice 3 of the private-beta release brief)
- **Date:** 2026-07-23
- **Decision id:** D-047

## Context

Builder volume is credited only to matched orders carrying the correct `builder` field (a public
bytes32) in the signed V2 order (INTEGRATION §7/§12a). The Slice 0 audit found this invariant
broken on the server side: the shared `build1271SignedOrder` never passed `builderCode` to the
SDK, so **every server-signed path (manual server route, auto-executor, retry sweeper, quoter
live-executor) submitted `builder = bytes32(0)` — unattributed** — while the order-intent metadata
misleadingly recorded the _configured_ code as if it had been applied. There was no server-side
verification on the browser path either: a client could strip or replace the `builder` field and
still submit. The config accepted a missing/malformed code even with live trading on.

Separately, the project pinned `@polymarket/clob-client-v2@1.0.6`; upstream had moved to 1.1.0
(async execution: POST /order returns `tradeIDs`, `transactionsHashes` no longer populated
directly) with ExchangeV3 signing added in 1.0.7.

## Decision

1. **Shared builder-code predicates** live in `@mx2/core` (`isValidBuilderCode`,
   `isNonZeroBuilderCode`, `builderCodesEqual`, `BUILDER_CODE_RE`, `ZERO_BUILDER_CODE`) so config,
   API, and worker validate identically instead of re-implementing the check.
2. **Config fail-closes** (`@mx2/config`): `POLYMARKET_BUILDER_CODE` is normalized (empty → unset)
   and a malformed value is always a config error; **`FEATURE_LIVE_TRADING=true` without a
   non-zero code throws at startup**. (The regex is inlined in config to keep it a leaf package.)
3. **The code is threaded into the signed order and verified.** `ClobV2OrderParams` gains
   `builderCode`; `build1271SignedOrder` passes it to the SDK's `UserOrderV2.builderCode` (which
   the SDK writes into the ERC-7739-bound `builder` field) and then calls the new
   `assertSignedBuilder` — **fail-closed if the code did not survive signing**. Every server call
   site (manual route, auto-executor, quoter live-executor) passes `config.polymarket.builderCode`
   and additionally guards with a defensive fail-closed skip/503 when the code is unconfigured
   (`ORDER_BUILDER_UNCONFIGURED` / `builder_code_unconfigured`). The dead
   `builderConfig` option was deleted.
4. **The browser path is verified server-side.** Before creating an intent,
   `POST /api/trade/orders` rejects `ORDER_BUILDER_MISMATCH` (400, audited
   `order.builder_mismatch`) when `signedOrder.builder` ≠ the configured code.
5. **Truthful observability.** Intent metadata and the `order.intent` / `order.submitted` audits
   record the ACTUAL signed builder plus a `builderMatch` boolean and the account kind — the audit
   trail can never claim attribution the on-chain order does not carry. No signatures/credentials
   are logged.
6. **Owner diagnostic** `apps/api/src/scripts/verify-builder-attribution.ts` cross-references local
   submitted intents against the PUBLIC `GET /builder/trades?builder_code=…` endpoint (no new
   credentials); non-zero exit only on a config problem.
7. **UI:** the raw builder code is removed from the `TriggerConfirm` primary confirmation and
   placed under an "Advanced execution details" disclosure (brief §7.1).
8. **SDK upgraded 1.0.6 → 1.1.0.** Our tolerant `SubmitOrderResponseSchema` (`{orderID, status?}`
   - passthrough) already absorbs the async-execution response change; contract tests re-pin the
     ERC-7739 envelope AND now assert a non-zero `builder`. ExchangeV3 is a fail-closed watch item
     (we build/verify against the V2 exchange addresses; a version mismatch surfaces as a rejection).

## Consequences

- With live trading on, the process refuses to start without a valid non-zero code; every
  submitted order — browser or server-signed — provably carries it or is rejected before submit.
- A client cannot strip/replace the code and still route through Arima.
- Rollback: revert the commits and re-pin the SDK to 1.0.6 (lockfile); the change is behavioral,
  no migration.

## Verification (2026-07-23, local)

Contract test asserts the SDK serializes a non-zero `builderCode` into `builder` and that the
default build carries the zero (unattributed) code; `assertSignedBuilder` passes on match and
throws otherwise. Route tests: happy path submits with the matching code (201); a zero/wrong
builder is rejected `ORDER_BUILDER_MISMATCH` with an `order.builder_mismatch` audit; the fresh
provision path is unaffected. Config tests: live-trading-without-code throws, zero code throws,
malformed code throws, empty string treated as unset. The API boots under the owner's local
live-trading `.env` (code present) and serves the code on `/api/trade/status`. The diagnostic ran
against the LIVE public endpoint and found the owner's prior low-value trade attributed to the
code (1 trade, $5.00, matched 2026-07-01) — end-to-end proof the code is genuinely credited.
Suites: 764 root + 292 web green; typecheck/lint/format clean against SDK 1.1.0.
