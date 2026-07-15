# Polymarket Integration — Verified Facts

> Satisfies the "current SDK/API version record" requirement of
> `polymarket_claude_mvp_kit_v1/docs/03_POLYMARKET_INTEGRATION_RU.md`.
> Treat the brief's method signatures as **non-authoritative**; this file records what was
> confirmed against primary sources.
>
> **Verification date:** 2026-06-22. Re-verify before the trading integration spike (Gate 4).

## 1. SDK generation

A **V2 SDK generation** is current. Target it:

| Language   | CLOB client                            | Relayer / builder client             |
| ---------- | -------------------------------------- | ------------------------------------ |
| TypeScript | `@polymarket/clob-client-v2`           | `@polymarket/builder-relayer-client` |
| Python     | `py-clob-client-v2`                    | `py-builder-relayer-client`          |
| Rust       | `polymarket_client_sdk_v2` (CLOB only) | — (use TS/Python)                    |

Relayer operations (wallet deploy, approvals) are only available in TS/Python SDKs.

## 2. Base URLs

| Surface                                          | URL                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| CLOB REST                                        | `https://clob.polymarket.com`                                                      |
| Gamma (events/markets/search/tags/price-history) | `https://gamma-api.polymarket.com`                                                 |
| Market WebSocket (public)                        | `wss://ws-subscriptions-clob.polymarket.com/ws/market`                             |
| User WebSocket (authenticated)                   | `wss://ws-subscriptions-clob.polymarket.com/ws/user`                               |
| Geoblock                                         | `https://polymarket.com/api/geoblock` (note: on `polymarket.com`, not an API host) |
| Builder registration                             | `https://polymarket.com/settings?tab=builder`                                      |

## 3. Authentication & order signing

- **L1 (wallet ownership):** EIP-712 signature. Headers: `POLY_ADDRESS`, `POLY_SIGNATURE`,
  `POLY_TIMESTAMP`, `POLY_NONCE`. Used to create/derive L2 creds and to sign orders locally.
- **L2 (API creds):** `apiKey` (UUID), `secret` (base64, for HMAC), `passphrase`. Headers:
  `POLY_ADDRESS`, `POLY_SIGNATURE` (HMAC-SHA256), `POLY_TIMESTAMP`, `POLY_API_KEY`,
  `POLY_PASSPHRASE`.
  - `POST https://clob.polymarket.com/auth/api-key` (create)
  - `GET  https://clob.polymarket.com/auth/derive-api-key` (derive)
  - SDK helpers: `createOrDeriveApiKey()`.
- **Invariant:** even with L2 headers, **each order still requires a per-order user signature**.
  The private key never leaves the user's device; the backend never holds it.

## 4. Wallet path — Deposit Wallets + POLY_1271 (the MVP path)

- Deposit wallet = per-user **ERC-1967 proxy** deployed by a factory; **CREATE2-derived** from the
  owner address (computable off-chain via `deriveDepositWalletAddress()` /
  `get_expected_deposit_wallet()`).
  - Factory (Polygon 137): `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`
  - Beacon (Polygon 137): `0x7A18EDfe055488A3128f01F563e5B479D92ffc3a`
- **Signature type `POLY_1271` (value 3).** Orders are validated on-chain via **ERC-1271** on the
  deposit wallet (gasless, no user gas). Order signatures are **ERC-7739-wrapped** — longer than
  standard ECDSA and **incompatible with normal EIP-712 order signing**. Wallet _batch_ operations
  (approvals) use normal 65-byte EIP-712 sigs over the `DepositWallet` `Batch` type.
- **funder = maker = signer = deposit wallet address** (not the owner EOA).
- Integration steps: (1) relayer `WALLET-CREATE` (no user signature in payload);
  (2) fund deposit wallet with pUSD + approvals via relayer `WALLET` batch;
  (3) CLOB balance sync with `signature_type=3`; (4) place orders with funder=deposit wallet.

## 5. WebSocket

- Market channel subscribe: `{ "type": "market", "assets_ids": ["<TOKEN_ID>"], ... }`.
- User channel subscribe: `{ "type": "user", "markets": [<market_ids>] }` + auth.
- Heartbeat: server pings ~every 5s; respond with pong within ~10s or the socket closes.
- Market channel delivers: orderbook snapshots, price changes, last-trade price, tick-size changes.
- **Reconnect strategy required:** REST snapshot + WS deltas; on gap/reconnect, re-snapshot and
  mark data stale until reconciled (see conditional-engine fail-closed policy).

## 6. Gamma data model

- `GET /events`, `/events/{id}`, `/markets`, `/markets/{id}`, `/public-search`, `/tags`,
  `/series`, `/prices-history` (all unauthenticated, paginated).
- Identifiers linking the hierarchy: **`conditionId`** (market condition) and **`clobTokenIds`**
  (the pair of outcome token ids). `outcomes` and `outcomePrices` are parallel 1:1 arrays.
- Preserve raw identifiers at the adapter boundary; never lose the
  `event → market → outcome token` link.

## 7. Builder attribution

- Obtain `builderCode` from `polymarket.com/settings?tab=builder` (non-secret identifier).
- Include `builderCode` in the order structure; it is serialized on-chain in the signed order and
  credits matched volume to the builder account. Relayer covers gas for wallet deploy/approvals/exec.

## 8. Geographic restrictions (compliance-critical)

- `GET https://polymarket.com/api/geoblock` → `{ blocked: bool, ip, country (ISO-3166-1 a2), region }`.
  **IP-based** detection.
- Tiers:
  - **Fully blocked** (cannot open or close): US, **Russia**, Iran, Cuba, North Korea, + 35+ total.
  - **Close-only**: Poland, Singapore, Thailand, Taiwan.
  - **Frontend-UI restricted** (API still reachable): Japan.
  - Region-level: Ontario (CA); Crimea, Donetsk, Luhansk (UA).
- Integrators must check before any order flow and give clear feedback; fail closed when status is
  unknown. **This is the project's top open risk — see `docs/ASSUMPTIONS.md` and `RISK_REGISTER.md`.**

## Primary sources (fetched 2026-06-22)

- https://docs.polymarket.com/llms.txt
- https://docs.polymarket.com/api-reference/authentication
- https://docs.polymarket.com/trading/deposit-wallets
- https://docs.polymarket.com/api-reference/geoblock
- https://docs.polymarket.com/builders/overview
- https://docs.polymarket.com/developers/gamma-markets-api/overview
- https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart

## 9. Deposit-wallet derivation (verified 2026-06-23, Slice 5/A-021)

- Polymarket browser-wallet (MetaMask/EOA) users trade through a per-user **Gnosis Safe**
  proxy ("Deposit Wallet"), deployed via CREATE2 by the **Polymarket Contract Proxy Factory**
  at `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b` (Polygon).
- Derivation is a **pure** function of the EOA (no on-chain lookup):
  - `salt = keccak256(abi.encode(["address"], [eoa]))`
  - `address = CREATE2(factory, salt, SAFE_INIT_CODE_HASH)`
  - `SAFE_INIT_CODE_HASH = 0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf`
- Verified against the owner's real pair: EOA `0x77117F39…E36d` → deposit wallet
  `0x997C95D8…1434` (the address `docs/test-auth.html` hardcodes). See
  `packages/polymarket-client/src/wallet/derive.ts` + `derive.test.ts`.
- Source: `@polymarket/builder-relayer-client` `src/builder/derive.ts#deriveSafe`,
  `src/config/index.ts`, `src/constants/index.ts`.

## 10. CLOB order signing (verified 2026-06-23, Slice 5/A-021; superseded 2026-06-30)

> 2026-06-30 update: this Slice 5 section documents the legacy browser-signed Gnosis Safe path.
> Current Polymarket docs and `@polymarket/clob-client-v2` support the newer deposit-wallet
> `POLY_1271` flow. New internal no-popup accounts must use `signatureType = 3`, maker/signer/funder
> as the registered deposit wallet, and the SDK's ERC-7739-wrapped signature. See §12.

Source: `@polymarket/clob-client` (`src/order-utils/*`, `src/order-builder/helpers.ts`,
`src/config.ts`, `src/utilities.ts`).

- **Exchange contracts (Polygon 137):** normal `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`,
  neg-risk `0xC5d563A36AE78145C45a50134d48A1215220f80a`. The order is signed against (and
  submitted to the exchange matching) whichever applies to the market (`negRisk` flag).
- **EIP-712 domain:** `{ name: "Polymarket CTF Exchange", version: "1", chainId: 137,
verifyingContract: <exchange> }`.
- **Order struct (primaryType "Order"):** `salt uint256, maker address, signer address,
taker address, tokenId uint256, makerAmount uint256, takerAmount uint256, expiration uint256,
nonce uint256, feeRateBps uint256, side uint8, signatureType uint8`.
- **signatureType — historical Slice 5 assumption:** this path used
  `signatureType = 2 (POLY_GNOSIS_SAFE)`. It is not the current target for new internal no-popup
  accounts.
- **maker / signer:** `maker` = deposit (Safe) wallet = `funder`; `signer` = EOA. `taker` =
  zero address (public order). `feeRateBps`/`nonce` default "0".
- **Amounts (6-decimal USDC/CTF):** `side BUY → takerAmt = roundDown(size, sizeDp),
makerAmt = takerAmt*price`; `SELL → makerAmt = roundDown(size, sizeDp), takerAmt = makerAmt*price`;
  then `parseUnits(amt, 6)`. Rounding decimals come from tickSize: 0.1→{p1,s2,a3}, 0.01→{p2,s2,a4},
  0.001→{p3,s2,a5}, 0.0001→{p4,s2,a6}.
- **salt:** `Math.round(Math.random()*Date.now()).toString()` (sent to CLOB as an integer).
- **POST /order body:** `{ order: { salt(int), maker, signer, taker, tokenId, makerAmount,
takerAmount, side(0|1), expiration, nonce, feeRateBps, signatureType, signature }, owner: <apiKey>,
orderType: "GTC"|"GTD"|"FOK" }` with the L2 HMAC headers.

## Primary sources (order signing, fetched 2026-06-23)

- https://github.com/Polymarket/clob-client (`src/order-utils`, `src/order-builder`, `src/config.ts`)
- https://github.com/Polymarket/builder-relayer-client (`src/builder/derive.ts`, `src/config`, `src/constants`)

## Server-side signing & Privy (verified 2026-06-29; ADR-0006 / RFC-0002)

Verified against official Polymarket + Privy docs:

- **Signature types:** `0` = EOA (plain wallet holds funds & signs directly), `1` = Email/Magic
  (delegated signing), `2` = browser-wallet Gnosis Safe proxy (the legacy path), `3` = EIP-1271
  smart-contract (V2 only). Source: docs.polymarket.com/api-reference/authentication.
- **L2 API creds (apiKey/secret/passphrase) authenticate the request but do NOT replace the
  per-order EIP-712 signature** — "methods that create user orders still require the user to sign
  the order payload." Source: Polymarket/py-clob-client issues #277, #70.
- **Privy session signers** support **server-side signing while the user is offline** ("execute
  limit orders or agentic trades even while a user is offline"); the raw key never leaves Privy's
  secure enclave (Shamir share reconstituted in a TEE). Source: docs.privy.io
  /wallets/using-wallets/signers/overview ; privy.io/blog/delegated-actions-launch.
- **Privy policy engine** (enforced in-enclave): contract allowlists/denylists, transfer limits,
  recipient allowlists, calldata constraints — evaluated before a signature is produced. Source:
  docs.privy.io/security/wallet-infrastructure/policy-and-controls.
- **To verify on staging** (see A-044–A-048): exact `@privy-io/node` method shapes + policy JSON,
  CLOB `signatureType 0` funder semantics, the allowance spender set, gas funding, and server-side
  ClobAuth acceptance.

## 12. Current deposit-wallet / relayer target (verified 2026-06-30; ADR-0008)

Sources checked: official Polymarket authentication, deposit-wallet, builder-relayer, and geographic
restriction docs; `@polymarket/clob-client-v2@1.0.6`;
`@polymarket/builder-relayer-client@0.0.10`; `@polymarket/builder-signing-sdk@1.0.0`.
Implementation note: `builder-relayer-client@0.0.10` itself depends on
`@polymarket/builder-signing-sdk@^0.0.8` and its `RelayClient` constructor is typed against that
class, so `apps/api` pins `@polymarket/builder-signing-sdk@0.0.8` until the relayer package updates.

- **Existing account / external wallet mode:** user signs in browser. L2 credentials authenticate
  CLOB requests but do not remove per-order signatures. This mode remains manual-signature.
- **No-popup internal mode:** must use a Polymarket-registered deposit wallet, not a bare Privy EOA.
  The owner/session signer signs through the official relayer/deposit-wallet flow.
- **Signature type:** new deposit-wallet API users should use `POLY_1271` / `signatureType = 3`.
- **Order identity:** for deposit-wallet orders, maker, signer, and funder are the deposit wallet.
  The SDK wraps the owner/session signature for ERC-1271 / ERC-7739 validation.
- **Funding/approvals:** pUSD/funds and approvals belong to the deposit wallet. Embedded EOA
  allowance bootstrap is not valid for live CLOB orders and is disabled in the app.
- **Relayer:** use `builder-relayer-client` to derive/deploy/register deposit wallets and execute
  deposit-wallet batches. The old pure Safe derivation is historical only for legacy browser wallets.
- **SDK signer bridge:** the current TS relayer client accepts Ethers `Wallet`/`JsonRpcSigner` or a
  viem `WalletClient`. Our production signer is Privy typed-data signing, so the API wraps it as a
  minimal viem wallet client that exposes address + `signTypedData` only; raw messages and direct
  transactions intentionally throw.
- **Compliance:** trading preview/submit/account/cancel routes must enforce Polymarket geoblock
  fail-closed. Read-only routes remain globally accessible per D-004.

## 13. Profile / portfolio PnL endpoints (verified 2026-07-01; D-018)

Sources checked: official Polymarket API reference pages for Data API profile endpoints and Gamma
public profiles.

- **Public profile:** `GET https://gamma-api.polymarket.com/public-profile?address=<wallet>` returns
  display fields including `name`, `pseudonym`, `xUsername`, `profileImage`, and `proxyWallet`.
  The owner EOA `0x77117F39dc33292c657a366643Dd995010b7E36d` maps to proxy wallet
  `0x997c95d8be61d5779edfb49aaf5dd83d85f31434`.
- **Current positions:** `GET https://data-api.polymarket.com/positions?user=<proxy>` returns open
  position rows with `currentValue`, `cashPnl`, `percentPnl`, `totalBought`, `realizedPnl`,
  `curPrice`, market labels, icon, slug, and outcome identifiers.
- **Closed positions:** `GET https://data-api.polymarket.com/closed-positions?user=<proxy>` returns
  historical closed rows with `realizedPnl`, `avgPrice`, `totalBought`, `curPrice`, `timestamp`,
  and market labels. Max page size is 50; do not treat one page as all-time realized PnL.
- **Activity:** `GET https://data-api.polymarket.com/activity?user=<proxy>&start=1` supports
  activity types including `TRADE`, `SPLIT`, `MERGE`, `REDEEM`, deposits/withdrawals/rewards, and
  includes profile-image fields in activity rows when available.
- **Position value:** `GET https://data-api.polymarket.com/value?user=<proxy>` returns a single
  `{ user, value }` row. Live samples can lag or differ from summing `/positions`; preserve
  provenance when displaying.
- **Account-level PnL:** `GET https://data-api.polymarket.com/v1/leaderboard?timePeriod=ALL&orderBy=PNL&user=<proxy>`
  returns `pnl`, `vol`, rank, username, and profile image for the trader. Use this as the current
  account-level total PnL anchor when available; derive realized top-line PnL as total minus open
  unrealized.

## 14. Gamma full-text search (verified live 2026-07-08; ADR-0010 / Smart Orders)

- `GET https://gamma-api.polymarket.com/public-search?q=<query>&limit_per_type=<n>&events_status=active`
  returns `{ events: GammaEvent[], tags: [...] }`; event objects match the `/events` shape
  (id, title, slug, markets[] with conditionId/clobTokenIds/outcomePrices, volume, liquidity,
  endDate, image). Consumed by `GammaClient.searchMarkets` with a title-filtered `/events`
  scan as the fallback if the endpoint errors or changes shape.

## 15. Data-API market trades + top holders (verified against official reference 2026-07-15)

Source: docs.polymarket.com → API reference → "Get Top Holders for Markets"
(`https://docs.polymarket.com/api-reference/core/get-top-holders-for-markets`), plus the
Data-API reference for `/trades`. Verified from the published spec (not yet against the live
API from this machine — tolerant `.passthrough()` schemas + fixture contract tests cover drift).

- `GET https://data-api.polymarket.com/trades?market=<conditionId>&limit=N&takerOnly=true`
  → array of `{ proxyWallet, side: "BUY"|"SELL", asset, conditionId, size: number,
price: number, timestamp: number (unix seconds), title, slug, icon, eventSlug, outcome,
outcomeIndex: number, name, pseudonym, bio, profileImage, profileImageOptimized,
transactionHash }`. `limit` default 100 / max 500; `takerOnly` defaults true (one row per
  trade). Public, no auth.
- `GET https://data-api.polymarket.com/holders?market=<conditionId>&limit=N`
  → array of `{ token, holders: [{ proxyWallet, bio, asset, pseudonym, amount: number,
displayUsernamePublic: boolean, outcomeIndex: number, name, profileImage,
profileImageOptimized }] }` — one group per outcome token. Official spec caps `limit`
  at 20 (default 20); `minBalance` optional. Public, no auth.
- NOTE: the CLOB host also has `/trades`, but it is L2-authenticated and user-scoped —
  the public market tape must use the Data API. `ClobClient.getTrades` remains unused
  by routes for this reason.

Modeled in `packages/polymarket-client/src/data/` (`MarketTradeSchema`,
`MarketHoldersGroupSchema`) and exposed via `GET /api/markets/:id/trades` and
`GET /api/markets/:id/holders` (public, rate-limited). First prod deploy should confirm
live shapes once; schemas tolerate unknown/missing optional fields.
