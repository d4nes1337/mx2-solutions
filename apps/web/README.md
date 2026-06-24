# @mx2/web — Polymarket Terminal frontend (MVP)

A deliberately thin Next.js app that exercises the `apps/api` backend locally:
read-only markets feed, market cockpit, EIP-712 wallet login, portfolio + PnL, and a
**preview-only** order ticket. See `docs/adr/0004-frontend-stack-and-integration.md`.

## Run it locally

From the repo root:

```bash
# 1. Backend dependencies (one-time)
pnpm install
pnpm compose:up            # Postgres on :5432
pnpm db:migrate

# 2. Allowlist your wallet so EIP-712 login is accepted (no admin UI in MVP)
pnpm db:seed:allowlist 0xYourEoaAddress

# 3. Start the API (terminal 1) and the web app (terminal 2)
pnpm dev:api               # http://localhost:3001
pnpm dev:web               # http://localhost:3000
```

Open http://localhost:3000. The web server proxies `/api/*` to `:3001`, so the session
cookie is first-party and no CORS config is needed.

## Walkthrough

1. **Markets** (`/`) — live Polymarket events (no login required).
2. **Cockpit** (`/markets/[id]`) — orderbook, price-history sparkline, stale banner; the
   order ticket previews orders (submit is intentionally disabled — A-021).
3. **Sign in** — Connect (MetaMask, Polygon) → **Sign in** (top right) signs an EIP-712
   challenge and sets the session cookie.
4. **Profile** (`/profile`) — positions, recent activity, and PnL with methodology +
   limitations. The Data API keys off your Polymarket **deposit/proxy** wallet — use the
   override field if your EOA shows no positions.

## Config

Copy `.env.example` to `.env.local` if you need overrides (proxy target, WalletConnect
project id, Polygon RPC). MetaMask works without a real WalletConnect id.

## Scripts

- `pnpm --filter @mx2/web dev` — dev server (:3000)
- `pnpm --filter @mx2/web build` — production build
- `pnpm --filter @mx2/web typecheck` — `tsc --noEmit`
- `pnpm --filter @mx2/web test` — Vitest (jsdom)
