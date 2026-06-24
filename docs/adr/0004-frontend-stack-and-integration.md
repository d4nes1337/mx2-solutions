# ADR-0004 — Frontend Stack and Integration (Slice 4 — Web MVP)

Date: 2026-06-23
Status: **Accepted**
Deciders: Owner (PM/BA), Senior Technical Lead

---

## Context

Slices 0–3 delivered a typed backend (`apps/api`) that talks to live Polymarket
Gamma / Data / CLOB APIs. There was no frontend. The owner asked for a deliberately
thin web app whose job is to **exercise everything the backend can honestly do today,
locally** — a personal profile after wallet connect, portfolio analytics, PnL, and a
few markets to test the trading path. This ADR records the stack and integration
choices for that web MVP and the scope boundary that follows from the backend's real
state.

Two facts shape scope:

- **Read-only is fully live, no flags:** events feed, market cockpit (orderbook, price
  history), EIP-712 wallet login (httpOnly session, allowlist-gated), portfolio
  (positions / history / PnL).
- **Trading is preview-only by design:** `POST /api/trade/orders/preview` returns exact
  order parameters without live trading enabled, but live submission cannot be completed
  in-browser yet — it is blocked by open risk **A-021** (ERC-7739 / POLY_1271 client-side
  signing unproven) and `FEATURE_LIVE_TRADING` defaults off.

## Decision

### Stack

- **Next.js 15 (App Router, React 18)** in `apps/web` — matches ADR-0001 (Next.js was the
  approved frontend) and the pnpm workspace (`apps/*`).
- **Tailwind CSS** with a small hand-rolled component kit (`components/ui.tsx`) in the
  shadcn aesthetic. The shadcn CLI/registry was **not** adopted to avoid a network/registry
  init step and ESLint-version coupling; the primitives are plain accessible Tailwind.
- **wagmi + RainbowKit + viem** for wallet connect and EIP-712 signing. Polygon (137) only,
  matching the backend login domain and ADR-0002 (Deposit Wallet on Polygon).
- **@tanstack/react-query** for fetching, polling (orderbook), and stale handling.
- **Hand-rolled SVG `<Sparkline>`** for price history and PnL — no charting dependency
  (owner decision: minimal footprint).

### Integration: reverse-proxy, not CORS

The Next server **proxies `/api/*` and the health probes to `:3001`** via `next.config.ts`
rewrites. The browser therefore sees a single origin (`localhost:3000`), which keeps the
`mx2_session` httpOnly cookie first-party (`sameSite=strict` works) and requires **no CORS
configuration or backend change**. All client calls are relative with
`credentials: "include"` (`lib/api.ts`).

### Auth signing

The sign-in flow mirrors the proven reference in `docs/test-auth.html` exactly: fetch the
challenge, sign the **raw `typedData` JSON** via the wallet's EIP-1193 provider
(`eth_signTypedData_v4`), then POST `/api/auth/verify`. Signing the backend's exact payload
byte-for-byte avoids the `EIP712Domain` / chainId mismatch that breaks signature recovery.

### Scope boundary

- **In:** read-only feed, market cockpit (orderbook + price sparkline + stale fail-closed
  banner), EIP-712 login, profile (positions / history / PnL with methodology + limitations),
  and an order ticket that calls `/preview` with the **submit control disabled** behind the
  feature flag + A-021.
- **Out (P1+, deferred):** live order submission/sign flow, conditional-rule builder, admin /
  kill-switch UI, multi-wallet, EOA/legacy wallet flows, advanced/ledger PnL.

### Tooling boundary in the monorepo

`apps/web` is kept **out of** the root `tsc -b` project references and the root ESLint 9 flat
config (added to its `ignores`). It has its own `typecheck` (`tsc --noEmit`) and `test`
(Vitest + jsdom + Testing Library, `.test.tsx` only so the root node-env Vitest never picks
them up). Both are appended to root `pnpm check`, so existing backend gates stay green while
the web app is still covered.

## Consequences

- **Easier:** the backend needs no CORS or cookie changes; cookies "just work" first-party;
  the whole API surface is demonstrable locally behind one origin.
- **Easier:** swapping the charting approach or wallet kit later is isolated to small modules
  (`components/Sparkline.tsx`, `lib/wagmi.ts`).
- **Harder / to revisit:** `apps/web` is not yet linted by a JS linter (only typechecked) —
  wiring `next lint` / a web-local ESLint is a tracked follow-up. WalletConnect needs a real
  `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; MetaMask (injected) works with the placeholder.
- **Unchanged:** all security invariants hold — no private keys touch the backend, live
  trading stays flagged off, and the order ticket cannot submit. Closing A-021 is the gate to
  turning the preview flow into a real (staging) submit flow.
