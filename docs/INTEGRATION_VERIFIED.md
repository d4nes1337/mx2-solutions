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

## 10. CLOB order signing (verified 2026-06-23, Slice 5/A-021)

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
- **signatureType — CORRECTION:** canonical enum is `EOA=0, POLY_PROXY=1, POLY_GNOSIS_SAFE=2`.
  There is **no type 3**. Since our users' deposit wallets are Gnosis Safes (§9), orders MUST use
  **signatureType = 2 (POLY_GNOSIS_SAFE)**. (ADR-0002 / Slice-3 backend said "POLY_1271 / type 3";
  that was wrong and is corrected here. The EOA signs the Order EIP-712 directly via
  `eth_signTypedData_v4`; no ERC-7739 nesting is required for type 2.)
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
