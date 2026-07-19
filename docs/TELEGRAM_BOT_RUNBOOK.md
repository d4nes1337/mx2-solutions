# Telegram Bot & Mini App (+ Discord) — Owner Runbook

How to provision, configure, and operate the Telegram notification bot and the
mobile sign surface. All secrets follow docs/05 rules: secret manager only,
never committed, never logged.

## 1. Create the bot (one-time, ~5 minutes)

1. Open Telegram → talk to **@BotFather** → `/newbot`.
2. Pick a display name (e.g. `arima terminal`) and a username ending in `bot`
   (e.g. `arima_terminal_bot`).
3. BotFather replies with the **bot token** (`123456:ABC-…`). This is a
   SENSITIVE secret — store it in the secret manager immediately.
4. Recommended cosmetics: `/setdescription`, `/setuserpic`,
   `/setcommands` with:

   ```
   orders - Orders waiting for your signature
   unlink - Disconnect this chat
   ```

## 2. Configure the environment

```bash
FEATURE_NOTIFICATIONS=true
FEATURE_TELEGRAM_BOT=true
TELEGRAM_BOT_TOKEN=<from BotFather>          # sensitive
TELEGRAM_BOT_USERNAME=arima_terminal_bot     # without @
APP_BASE_URL=https://app.example.com         # links in messages point here
```

Config load fails closed: `FEATURE_TELEGRAM_BOT=true` without the token,
username, and `FEATURE_NOTIFICATIONS=true` refuses to start.

The **worker** hosts both the long-polling inbound loop and the outbox
dispatcher — no public webhook URL is needed, which is why local dev works
with just a test bot. Restart the worker after changing flags.

## 3. Mini App (optional, adds in-Telegram preview + signing)

```bash
FEATURE_TELEGRAM_MINIAPP=true   # requires FEATURE_TELEGRAM_BOT
```

Constraints:

- `APP_BASE_URL` must be **https** — Telegram rejects `web_app` buttons for
  plain-http URLs, and the dispatcher silently omits them in that case
  (messages fall back to the tokenized browser link).
- Local dev: run a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`)
  and set `APP_BASE_URL` to the tunnel URL in the worker + API env.
- Signing inside the Telegram webview relies on WalletConnect deep links —
  set a real `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (cloud.reown.com, free).
  Every sign message keeps an **Open in browser** fallback button for webviews
  where the wallet round-trip misbehaves.

## 3b. Discord (notifications-only)

Discord has no Mini App equivalent — DMs carry the same tokenized sign links
that open the mobile web page. Linking uses OAuth2 (identify scope), so no
gateway connection and no discord.js dependency.

1. https://discord.com/developers/applications → **New Application** →
   Bot tab → copy the **bot token** (sensitive).
2. OAuth2 tab → add redirect URI `https://<APP_BASE_URL>/api/notifications/discord/callback`;
   copy **Client ID** and **Client Secret** (sensitive).
3. Invite the bot to your project guild (OAuth2 URL generator, `bot` scope, no
   permissions needed — DMs only). Users must join this guild or the bot
   cannot DM them; set `DISCORD_GUILD_INVITE_URL` so the app shows the invite.

```bash
FEATURE_DISCORD_BOT=true       # requires FEATURE_NOTIFICATIONS
DISCORD_BOT_TOKEN=...          # sensitive
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...      # sensitive
DISCORD_GUILD_INVITE_URL=https://discord.gg/...
```

## 4. User flows (what to test after enabling)

1. **Link**: app → Wallet page → Notifications → Connect → Telegram opens →
   `Start` → "✅ Linked" reply; the app card flips to Linked within ~3 s.
2. **Notify + sign**: create a smart order with `execution: "prepare"`, trip
   it (`POST /api/smart-orders/:id/evaluate-now` or real price movement) →
   Telegram message with `Open & sign` → preview → Limit/Market → wallet
   signature → order submitted; trigger shows `confirmed` in the app.
3. **Recovery**: sign links are single-use, 30-min TTL. Send `/orders` to the
   bot for fresh links.
4. **Unlink**: `/unlink` in the chat, or Disconnect in the app.

## 5. Security properties (what a leaked message can/can't do)

- A sign link yields a **trigger-scoped session**: it can view that one
  prepared order and submit only its **wallet-signed** order. It cannot list
  other orders, withdraw, change settings, or touch credentials.
- Executing ALWAYS requires an EIP-712 signature from the user's main wallet.
  There is no token-only execution path (owner decision, 2026-07-19).
- Mini App logins are verified against the bot token (initData HMAC, 5-min
  replay window) and only resolve wallets that completed the code handshake.

## 6. Incident levers

- **Stop all outbound notifications**: unset `FEATURE_TELEGRAM_BOT` (or
  `FEATURE_NOTIFICATIONS`) and restart the worker. Undelivered outbox rows
  keep accumulating (enqueue is gated by `FEATURE_NOTIFICATIONS` only) and
  fail terminally after 5 attempts once the dispatcher returns.
- **Compromised bot token**: BotFather → `/revoke` → update the secret →
  restart. Linked channels are unaffected (they key on chat ids).
- **Kill a specific user's notifications**: revoke their channel row
  (`DELETE /api/notifications/channels/:id` as the user, or `/unlink`).
- Delivery failures are audited (`notification.send_failed`) and visible in
  `notification_outbox` (`status`, `attempts`, `last_error`).
