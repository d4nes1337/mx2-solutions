# ADR-0008: Selectable Trading Accounts

- Status: Approved
- Date: 2026-06-30
- Decision owners: Technical Lead / Product Owner

## Context

Live CLOB testing proved that Polymarket rejects orders whose maker is a plain Privy embedded EOA:
`maker address not allowed, please use the deposit wallet flow`. Current Polymarket docs and SDKs
point new API users to deposit wallets with `signatureType 3 / POLY_1271`, where the CLOB order
maker/signer/funder is the registered deposit wallet and the owner/session signer produces the
wrapped signature.

The product goal is still a terminal where users can log in, select the wallet they want to trade
from, and eventually trade from an internal wallet without per-order wallet popups.

## Decision Drivers

- Do not custody or import users' primary wallet private keys.
- Existing Polymarket users should be able to trade from existing wallets, even if manual signatures
  are required.
- No-popup trading must use a Polymarket-supported deposit-wallet path, not a bare EOA workaround.
- Users should be able to add, switch, and set primary trading wallets.
- Internal wallet funding/top-up and withdrawal must have explicit, auditable account state.

## Options Considered

### Option A: Keep Single Login Wallet

Simple, but it conflates identity, portfolio view, funding wallet, and signer. It blocks the owner's
multi-wallet UX and makes account-scoped CLOB credentials impossible.

### Option B: Privy EOA as Live Maker

Already tested and rejected by Polymarket CLOB. Keeping it would produce a known live-trading failure.

### Option C: Import Existing Wallet Keys

Could enable server signing for existing accounts, but violates the project invariant that the app
must never custody the user's primary wallet private key.

### Option D: Selectable Trading Accounts + Deposit-Wallet No-Popup Target

Model each tradable wallet as a `trading_account`. External wallets use browser signatures. Internal
Privy accounts are provisioned automatically but remain unavailable for live no-popup orders until a
Polymarket deposit wallet is deployed/registered through the relayer.

## Recommendation

Use Option D.

## Consequences

### Positive

- Users can switch between multiple external wallets and set a primary account.
- CLOB credentials are scoped to the selected trading account instead of the login wallet.
- The app no longer submits known-invalid bare-EOA Privy orders.
- The schema has a clear place for relayer deposit-wallet state, top-up status, withdrawals, and
  future Polymarket tip-based funding.

### Negative / Risks

- Existing-wallet no-popup trading remains unsupported unless Polymarket provides official delegation
  or the user moves funds into an internal deposit wallet.
- The internal wallet UX now has an honest pending state until relayer integration is built.
- Official `POLY_1271` order signing and relayer calls still require staging contract tests before
  live enablement.

## Product-Owner Approval Required For

- Enabling `FEATURE_RELAYER` against staging/live builder credentials.
- Broadly onboarding users to fund internal deposit wallets.
- Any withdrawal policy that restricts destination or timing.
- Enabling unattended conditional execution after the deposit-wallet path passes a low-value test.

## Validation Plan

1. Account-selector API and UI: add external wallet, set primary, preview/sign/submit with that
   account's signer/funder.
2. Relayer slice: derive/deploy deposit wallet, sync activation state, set allowances via relayer
   batch, and store deposit wallet as account funder.
3. Official SDK contract tests for `POLY_1271` order creation and CLOB `/order` payload.
4. Low-value staging flow: fund deposit wallet, place tiny order, cancel/reconcile, withdraw/return
   funds, verify audit trail and kill switch.
