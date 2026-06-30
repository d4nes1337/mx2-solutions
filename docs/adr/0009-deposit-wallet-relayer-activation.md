# ADR-0009: Deposit-Wallet Relayer Activation

- Status: Built
- Date: 2026-06-30
- Decision owners: Technical Lead / Product Owner

## Context

ADR-0008 established the trading-account model: external wallets trade with browser signatures, while
internal Privy wallets target no-popup trading only after Polymarket deposit-wallet onboarding. Current
Polymarket docs require new API users to trade through a relayer-created deposit wallet with
`signatureType 3 / POLY_1271`; funds and approvals belong to that deposit wallet, not the owner EOA.

The next integration slice needed to make that state real in the product without enabling unproven
live orders.

## Decision

Add a `DepositWalletRelayer` port in `@mx2/polymarket-client` and wire `apps/api` to Polymarket's
`builder-relayer-client@0.0.10` behind `FEATURE_RELAYER`.

The API constructs a minimal viem `WalletClient` backed by `TradingSigner` / Privy:

- `account.address` is the embedded Privy EOA.
- `signTypedData` delegates to Privy through the existing signer seam.
- `signMessage`, `signTransaction`, and `sendTransaction` throw.

The activation route `POST /api/trading-wallet/activate-deposit-wallet`:

1. Requires `FEATURE_PRIVY_SIGNING=true` and `FEATURE_RELAYER=true`.
2. Requires a provisioned internal Privy wallet.
3. Checks the relayer deployment status for the embedded EOA.
4. Submits `deployDepositWallet()` if needed.
5. Persists the deposit wallet address and relayer transaction metadata on the internal
   `trading_account`.
6. Moves the account to `needs_funding` only after the relayer reports `STATE_MINED` or
   `STATE_CONFIRMED`; otherwise it remains `needs_deposit_wallet`.

`FEATURE_RELAYER=true` fails closed at config load unless the API has:

- `FEATURE_PRIVY_SIGNING=true`
- `POLYGON_RPC_URL`
- `POLYMARKET_RELAYER_URL`
- `POLYMARKET_BUILDER_API_KEY`
- `POLYMARKET_BUILDER_SECRET`
- `POLYMARKET_BUILDER_PASSPHRASE`

Implementation compatibility note: the current relayer package is typed against
`@polymarket/builder-signing-sdk@^0.0.8`, so `apps/api` pins `0.0.8` even though the standalone
signing SDK currently has a newer npm release.

## Options Considered

### Option A: Call the SDK Directly From the Route

Simple initially, but it couples product state handling to SDK/signer details and makes tests require
live relayer credentials or heavy mocks at the route boundary.

### Option B: Build a Raw Relayer HTTP Client

Gives full control, but increases risk of diverging from Polymarket's current auth/signing semantics.

### Option C: Adapter Port + Official SDK Factory

Keep the route state machine independent of SDK construction while still using Polymarket's official
client in production.

## Consequences

### Positive

- Users now have a visible internal-wallet activation step in the trading account UI.
- Builder credentials remain backend-only and fail-closed.
- Tests can cover disabled, pending, and confirmed relayer states without real credentials.
- The Privy signer bridge is narrow: typed-data only, no generic backend wallet.

### Negative / Risks

- Activation alone does not enable no-popup live orders. Funding, relayer allowance batches,
  `POLY_1271` order creation, and withdrawal/return-funds are still required.
- The adapter assumes Polygon mainnet (`chainId 137`) for this MVP slice.
- Relayer SDK package versions are internally inconsistent with the newest standalone signing SDK.

## Validation Plan

1. Unit-test the adapter against a fake relayer client.
2. Route-test disabled and confirmed activation states.
3. With staging builder credentials, activate one low-value internal wallet and confirm the deployed
   deposit wallet is recognized by Polymarket.
4. Next slices: relayer allowance batch, top-up/funding UX, `POLY_1271` order creation, cancel,
   withdrawal/return-funds.
