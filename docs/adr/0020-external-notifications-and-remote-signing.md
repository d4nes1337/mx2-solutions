# ADR-0020: External Notifications (Telegram/Discord) and Remote Trigger Signing

Date: 2026-07-19

Status: Built

## Context

A browser-signed (main-wallet) account must manually sign every triggered order, but the only
surface was the desktop web app polling `GET /api/rules/triggers` — away from the terminal, a
prepared order sat at `awaiting_user` until it expired. The owner approved the P1
"Telegram/mobile" expansion (D-037): external notifications for trading events plus a mobile
page where the user can review the prepared order, choose limit/market, and sign with the main
wallet — packaged as a Telegram Mini App where possible, Discord as notifications-only.

## Decision

**Channel model.** `notification_channels` links a wallet to an external account
(telegram chat id / discord user id) with per-kind opt-out preferences (default ON — owner
decision). Linking is always initiated by the AUTHENTICATED wallet and completed by proving
control of the external account: Telegram via a single-use code in the `t.me/<bot>?start=`
deep link (`channel_link_codes`, SHA-256 at rest, 10-min TTL), Discord via OAuth2
(identify scope) where the OAuth `state` IS such a code — CSRF-safe by construction. An
external account links to exactly one wallet at a time (partial unique index on active rows).

**Delivery.** A transactional outbox (`notification_outbox`, unique dedupe key, exponential
backoff, terminal failure after 5 attempts) decouples producers from delivery. Producers:
rule evaluator (`order_awaiting_signature`, `rule_alert`), auto-executor
(`order_auto_executed` — informational, deliberately no sign link), order-sync
(`order_filled`), bridge poller (`deposit_completed`, `withdrawal_completed`). The worker's
dispatcher fans out per channel. Telegram inbound uses **long polling** (no public webhook —
fits the single-process deployment, D-001, and works in local dev). Discord uses **REST-only
DM delivery** (no gateway, no discord.js dependency); its lack of an inbound path is why
Discord is notifications-only.

**Remote signing = restricted sessions + the wallet signature as the execution proof.**
`sessions.scope` (jsonb, NULL = full) marks restricted sessions; `require-auth` rejects them
everywhere by default. Exactly four surfaces accept them via a scoped middleware: trigger
detail, confirm, dismiss, and `POST /api/trade/orders` — where a scoped session may submit
only the browser-signed order whose idempotency key is `trigger:<its own trigger>` and whose
trigger still awaits the user. Two scope shapes: `{type:"trigger", triggerId}` minted by
exchanging a single-use 30-min `sign_link_tokens` URL token (SHA-256 at rest), and
`{type:"telegram_wallet"}` minted from Telegram Mini App `initData` (HMAC-verified against
the bot token, 5-min replay window, resolves only wallets that completed the link handshake).
A leaked message can therefore only ever REVEAL one prepared order; EXECUTING requires an
EIP-712 signature from the main wallet (server-signed accounts are refused on this path).

**Mobile surface.** `/m/t/[id]` renders bare (no app chrome), authenticates via token
exchange → cookie (token scrubbed from the URL) or Mini App initData, shows the existing
fresh server preview + `conditionStillHolds`, adds a Limit (GTC/GTD at an editable price) /
Market (FAK at the touch + 2¢ slippage cap) toggle, and reuses the exact
`buildAndSignOrder` → submit → confirm path the desktop TriggerConfirm uses. The trigger
detail response now carries the primary account's signing context (a restricted session
cannot call `/api/trading-accounts`).

## Options considered

- **Webhook vs long polling (Telegram):** webhook needs a public HTTPS callback + secret
  rotation; long polling runs anywhere the worker runs. Single process → polling.
- **discord.js gateway vs REST-only:** the gateway is only needed to RECEIVE messages; OAuth
  linking removes that need entirely. REST-only avoids a heavy dependency.
- **Privy one-tap execution from Telegram:** rejected for now (owner, 2026-07-19) — token-only
  execution would let a leaked link execute an order. Auto-executed orders notify
  informationally instead.
- **Bearer tokens for the mobile page:** rejected — reusing the httpOnly cookie session with a
  scope column keeps one auth path, one revocation story, and the same-origin proxy intact.

## Consequences

- New fail-closed flag ladder: `FEATURE_NOTIFICATIONS` (master) → `FEATURE_TELEGRAM_BOT`
  (token+username) → `FEATURE_TELEGRAM_MINIAPP`; `FEATURE_DISCORD_BOT` (token + OAuth creds).
  Bot tokens/OAuth secrets are sensitive (docs/05) and live only in config.
- Every trigger now has three interchangeable surfaces (desktop, tokenized mobile page,
  Mini App); `/orders` in the bot re-mints expired links.
- The dispatcher is at-least-once: a crash between send and mark-sent can duplicate a
  message (never an order — idempotency keys make double-submission structurally impossible).
- Operational runbook: docs/TELEGRAM_BOT_RUNBOOK.md. Risks: R-042..R-044.
