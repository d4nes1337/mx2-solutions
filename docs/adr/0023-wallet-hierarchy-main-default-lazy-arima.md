# ADR-0023 — Wallet hierarchy: main wallet default, lazy opt-in Arima Wallet

- **Status:** Accepted (owner-approved plan, 2026-07-23; Slice 2 of the private-beta release brief)
- **Date:** 2026-07-23
- **Decision id:** D-046

## Context

The brief (`docs/plans/ARIMA_PRIVATE_BETA_RELEASE_BRIEF.md` §1, §5) reverses the prior emphasis:
the connected/main Polymarket wallet with manual signatures is the promoted default trading path,
and the internal Privy "Arima Wallet" becomes an explicit, opt-in Beta feature for automated
execution. Before this change the app auto-provisioned an Arima Wallet on every login (two
independent paths), promoted a global header Deposit control, and gave the Arima card the only
brand emphasis — pushing users toward funding an internal wallet before they got any value.

## Decision

1. **Signing in never provisions an Arima Wallet.** Removed both auto-provision paths — the client
   `AutoProvisionTradingWallet` effect (`apps/web/app/providers.tsx`) and the server login
   side-effect in `POST /api/auth/verify` (`apps/api/src/routes/auth.ts`). The now-dead
   provisioning deps (`tradingSigner`, `privyWallets`, `tradingAccounts`,
   `ensureTradingWalletProvisioned`) were dropped from `AuthRoutesDeps`.
2. **Provisioning is lazy and explicit.** `ensureTradingWalletProvisioned` stays the shared
   idempotent implementation, now reached only from the explicit `POST /api/trading-wallet/provision`
   and `/reissue` routes. A genuinely new provision from the route emits a `trading_wallet.opt_in`
   audit event (the user's Arima Wallet consent moment; also the `arima_wallet_enabled` analytics
   signal); a restore (`alreadyProvisioned`) does not.
3. **The Arima Wallet UI requires an explicit confirmation.** New `EnableArimaWalletDialog`
   (SheetShell modal) is the ONE place a fresh internal wallet is created — it explains the six
   points the brief requires (separate ring-fenced balance, automation capability, hard
   per-order/daily/total limits, pause/withdraw controls, primary key never requested, automation
   subject to feature flags + regional restrictions) and only provisions on confirm. The wallet
   page's "Enable Arima Wallet Beta" routes through it; a **restore** (wallet still exists at the
   provider) stays a direct action — the user already consented.
4. **The main wallet is visually primary; the Arima Wallet is secondary Beta.** Removed the global
   header Deposit control (`HeaderWallet` deleted) and the inverted-emphasis `TradingModeCards`
   grid. The account-menu pre-opt-in entry became a neutral "Arima Wallet · Beta / Optional" row
   (no prominent Add funds). The wallet page leads with the connected-wallet-first framing and
   `WalletsSection` (whose primary login-wallet card already carries the accent), and only surfaces
   the Arima setup stepper (`TradingSetupPanel`) once the user has opted in. Funding is contextual,
   post-opt-in only.
5. **Execution selector vocabulary** aligned to brief §3.2: "Ask me to sign" (default; connected
   wallet) and "Auto · Arima Wallet" (opt-in), with helper copy and a link into the Arima Wallet
   readiness flow when auto is chosen. The default remains `prepare`.

## Consequences

- New users complete the entire manual flow (draft → arm → trigger → review → sign) without ever
  seeing a Deposit CTA or an internal wallet. The Arima Wallet exists only after a deliberate,
  audited opt-in.
- **Existing funded internal wallets are untouched** (brief §5.4): removing auto-provision only
  stops CREATING wallets; `GET /api/trading-accounts` still lists, reconciles, funds, and
  withdraws any existing account, and the ghost/restore/reissue paths in `WalletsSection` are
  preserved. No migration; rollback = revert the commits.
- The change is behavioral/UI only — no schema change, no new flag. `FEATURE_PRIVY_SIGNING` still
  gates whether the opt-in path is available at all; when off, only connected-wallet trading shows.

## Verification (2026-07-23, local live run)

Scripted EIP-712 wallet (privy signing on, mock signer) against the running API + Postgres: a
fresh invite-redeemed sign-in creates NO `internal_privy` account and reports
`provisioned:false`; the explicit `POST /provision` creates it as a fresh opt-in and records a
`trading_wallet.opt_in` audit event; the account then appears (7/7 checks). Browser: header shows
no Deposit control; the wallet page leads with the connected-wallet-first framing; the builder
execution selector reads "Ask me to sign" / "Auto · Arima Wallet" with the correct default and
auto helper + Arima Wallet link (sentence flips to "…automatically from my Arima trading wallet"
with an AUTO badge); zero console errors. The interactive signed-in wallet view (primary main
card, Arima Wallet Beta opt-in dialog) is a wallet-connection-gated owner live check; component
behavior is unit-tested. Suites: 760 root + 292 web green; typecheck/lint/format clean.
