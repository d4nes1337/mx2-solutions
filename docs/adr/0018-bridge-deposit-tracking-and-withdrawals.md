# ADR-0018: Bridge Deposit Tracking and Cross-Chain Withdrawals

Date: 2026-07-18

Status: Built; staging acceptance (OQ-1/OQ-2 below) required before enabling either flag in production

## Context

ADR-0017 scaffolded Polymarket Bridge funding but left deposit status tracking and withdrawals
unbuilt. Research against official Polymarket docs (2026-07-17) verified the Bridge exposes a full
API at `bridge.polymarket.com`: `POST /deposit`, `POST /withdraw` (address-based — the response is
an intermediate bridge address on Polygon; funding it executes the withdrawal), `POST /quote`
(fees/ETA/min-received), and `GET /status/{bridgeAddress}` with statuses
`DEPOSIT_DETECTED → PROCESSING → ORIGIN_TX_CONFIRMED → SUBMITTED → COMPLETED | FAILED`.
No third-party bridge (CCTP, relay.link) is needed.

## Decision

- Persist generated bridge addresses (`bridge_addresses`, kinds `deposit`/`withdrawal`) so the
  sheet reuses them and the status poller has a bounded work list.
- Track deposits in `bridge_deposits` with a forward-only state machine
  (`detected → processing → origin_confirmed → submitted → completed | failed`); provider statuses
  stored verbatim, unknown values bucket into `processing` — never a parse failure.
- Poll via a worker loop (60s, batch-bounded, per-address backoff) behind
  `FEATURE_BRIDGE_FUNDING || FEATURE_BRIDGE_WITHDRAWALS`, plus a bounded on-request refresh in
  `GET /api/funds/deposits?refresh=1`. Every transition is audited; deposits stuck non-terminal
  past 2h emit `wallet.bridge.reconciliation_flagged`.
- `POST /api/funds/quote` is server-shaped: the browser sends only the source leg; the server
  fills the pUSD destination (the user's own deposit wallet).
- Cross-chain withdrawals extend `POST /api/trading-wallet/withdraw` with an optional `toChainId`
  (default `137` keeps the direct path byte-identical). Non-Polygon requires
  `FEATURE_BRIDGE_WITHDRAWALS`, is geoblocked fail-closed, and runs two legs recorded in
  `bridge_withdrawals`: quote binding (refuse when quoted `minReceived` drops >
  `BRIDGE_WITHDRAW_MAX_DEVIATION_BPS` = 100 below the amount) → `POST /withdraw` for the hop
  address → gasless relayer `executeBatch` pUSD transfer to that address. The destination address
  is STILL always the session login wallet, resolved server-side — chain choice never weakens
  D-026/R-031.
- In-app multi-chain sends: wagmi carries Polygon + Base + Arbitrum + Ethereum for bridge-funding
  transfers only; EIP-712 sign-in stays pinned to chain 137.

## Consequences

Users can fund from 13+ chains with quotes and tracked status, and withdraw to their own wallet on
Base/Arbitrum/Ethereum. Failure isolation: `failed_address`/`failed_polygon` mean funds never left
the deposit wallet (recoverable); `failed_bridge` surfaces support copy (recovery.polymarket.com).

Open questions to close in owner-attended staging BEFORE any prod flag flips:

- **OQ-1**: does the bridge accept pUSD on the Polygon withdrawal leg, or must the relayer batch
  unwrap pUSD→USDC.e first? (Implemented as a direct pUSD transfer; swap in an unwrap leg if the
  low-value test says otherwise.)
- **OQ-2**: `GET /status/{address}` is documented for deposits — verify it reports withdrawal hop
  addresses too (the poller assumes it does).
