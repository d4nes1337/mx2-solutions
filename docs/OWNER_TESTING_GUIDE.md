# Owner Testing Guide — Round 6 (withdrawals, live farming, canvas wiring)

> **Audience:** the product owner, testing on their own staging wallet with real (small) funds.
> **Golden rule:** every live step here moves real money. Follow the order; never skip a gate.
> Nothing in this guide requires pasting a private key or reading `.env.production` values —
> readiness checks report key **presence** only.

Your test identity (from earlier sessions):

- Login wallet (EOA): `0x77117f39dc33292c657a366643dd995010b7e36d`
- Arima deposit wallet: `0x997C95D8bE61d5779EDfB49AAf5dd83d85F31434`
- The deposit wallet holds **pUSD** (Polymarket USD, 1:1 USD) — not USDC.e. We verified
  on-chain that both V2 exchanges use pUSD as collateral and your deposit wallet already
  holds ≈$103 in it (`docs/INTEGRATION_VERIFIED.md` §23).

---

## 0. Environment readiness (5 min, no funds involved)

```bash
pnpm --filter @mx2/api run check-live-readiness
```

- Prints `PRESENT`/`MISSING` per required env key (**names only — values are never shown**)
  and the ON/off state of every feature flag. Non-zero exit = something's missing.
- If it points you at the adapter verification, run it (read-only chain calls):

```bash
CONDITION_ID=0x<any-active-market-conditionId> \
pnpm --filter @mx2/api exec tsx --env-file=../../.env.production src/scripts/verify-ctf-adapters.ts
```

Record the PASS output — `FEATURE_MAKER_LOOP_LIVE` stays off until this passes (R-028).

In the app, the same ladder is visible at **Farming → your session → "Go-live readiness"**:
every row should be green before Section 3.

## 1. Canvas wiring (10 min, no funds involved)

Open any strategy in the builder canvas and check each behavior:

1. **Draw market → condition**: drag from a market node's right handle onto a condition's
   left handle. The condition rebinds to that market (dashed edge appears).
2. **Draw market → order action**: order actions expose a second left handle (lower); only
   `order` actions accept a market. Farm loops refuse with a hint ("Farm loops carry their
   own market").
3. **Re-parent a condition**: drag the edge between a condition and its logic block to
   another logic block. Depth limits and NOT-group rules refuse invalid moves with a hint.
4. **Delete an edge**: select the dashed market edge and press delete — the condition
   unbinds, and the market node stays on canvas as a watched market (it must NOT vanish).
5. **Drop-to-bind**: drag a market node onto a condition until it glows, release — it binds.
6. **Rejection hints**: try connecting a market to a logic block — a transient note appears
   near the cursor explaining why not.

## 2. Withdrawal path (staging: $5 in → $2 out)

Prereqs: `FEATURE_WALLET_WITHDRAW=true` (requires `FEATURE_RELAYER=true` — config refuses
otherwise), plus relayer/builder credentials present per Section 0.

1. **Top-up $5**: Profile → wallet card → **Funds** → _Top up_. Send $5 USDC.e from your
   login wallet to the deposit wallet address shown. Wait for the balance strip to show it.
   - _What you're verifying:_ Polymarket auto-converts USDC.e → pUSD. If the strip shows
     "+$5.00 converting…" for more than ~10 minutes, the conversion assumption failed —
     stop and report (the funds are safe, just unconverted).
2. **Withdraw $2**: _Withdraw_ tab → amount 2 → the destination is displayed and fixed to
   your connected login wallet → confirm (2-step). Gas is covered by the relayer; the full
   $2 arrives **as pUSD** in your login wallet.
3. **History**: the _History_ tab should show the withdrawal progressing
   `requested → submitted → confirmed` with a Polygonscan link.
4. **Audit**: the audit log should contain `wallet.withdraw.requested` and
   `wallet.withdraw.submitted` for your wallet.
5. **Crafted-destination rejection** (security check): with your session cookie, POST
   directly to the API with a smuggled destination — it must be a 400, and nothing moves:

```bash
curl -i -X POST https://<api-host>/api/trading-wallet/withdraw \
  -H "content-type: application/json" -H "cookie: mx2_session=<your session cookie>" \
  -d '{"amountUsd": 1, "idempotencyKey": "attack-test-123", "destination": "0x000000000000000000000000000000000000dEaD"}'
# expect: 400 INVALID_REQUEST (strict schema) — the destination can never be client input
```

6. **Idempotency**: repeat a legitimate withdraw request with the same `idempotencyKey` —
   the response says `alreadySubmitted: true` and no second transfer happens.

## 3. Live farming ladder (RFC-0003 checkpoints 2–4)

Never skip a rung. Each rung has an explicit owner sign-off.

### 3a. Shadow soak (no funds at risk)

- Create a rewards-farming strategy (Farming → pick a market from the scanner) and arm it.
- Watch the cockpit for ~30–60 min: the event stream should show plain-language
  "Would place BUY … @ …¢" intents tracking the mid, and "standing down" when your gate
  conditions aren't met.
- Sign-off: quotes track the book sensibly; no runaway cancel/replace churn.

### 3b. Wallet prep (one-time, ~$0 gas — all relayer-paid)

1. Wallet card → activate deposit wallet (if not already active).
2. Wallet card → **bootstrap allowances**: grants pUSD + CTF approvals from the deposit
   wallet to the two V2 exchanges and the two verified adapters, as ONE gasless batch.
   Re-running is always safe (the chain is the source of truth; only gaps are submitted).
3. Wallet card → **set up trading credentials**: the server signs ClobAuth with the
   embedded signer (no popup) and stores encrypted L2 keys.
4. Verify all rows green in the cockpit's "Go-live readiness" panel.

### 3c. Confirm mode on ONE market ($20–50)

1. Ensure the deposit wallet holds $20–50 pUSD (top-up per Section 2 if needed).
2. Set `FEATURE_MAKER_LOOP_LIVE=true` (only after 3a + adapter verification), restart.
3. Cockpit → mode → **Confirm**. (Escalation is geoblock-checked; blocked regions 403.)
4. The worker proposes batches instead of acting: the **"Awaiting your approval"** card
   shows the exact quotes/merges. Approve at least 3 batches and verify each becomes a
   resting order on Polymarket (the event stream shows "Order resting: …").
5. **Stale-approval check**: wait for a proposal, let the market move (or wait for a
   re-propose), then approve — you should occasionally see "Prices moved — review and
   approve again". That is the safety net working: a stale approval can never execute.
6. Let a pair fill and merge (or lower `sizeShares` so fills happen): verify
   "Merging N YES+NO pairs" → "Merge confirmed on-chain", realized PnL ticks up, and the
   deposit wallet's pUSD balance grows by ~$1×pairs.
7. Sign-off: ≥3 approved batches, ≥1 stale re-propose observed, ≥1 merge confirmed.

### 3d. Live mode with minimum caps + kill-switch drill

1. Cockpit → mode → **Live**, with strategy caps at their minimums
   (small `sizeShares`, tight `maxCapitalUsd`, tight `maxDailyLossUsd`).
2. Verify autonomous quote/re-quote/merge behavior for ~30 min.
3. **Kill-switch drill** (all three layers):
   - Cockpit red **Drill: halt** button → status flips to halted, capital committed reads
     $0.00 within ~2 s. Resume after.
   - Admin quoter switch: `POST /api/admin/quoter/pause` (header `x-admin-secret`) → every
     session idles (quotes cancelled) but is NOT halted; `/resume` recovers automatically.
   - Global: `POST /api/admin/trading/pause` → same effect plus manual orders blocked.
4. Note the mode de-escalation rule: switching a live session back to **Shadow** requires
   halting first (the server 409s otherwise) — a shadow executor can't cancel real orders.
5. Sign-off: drill passes on all three layers; only then consider raising caps (GA is a
   separate decision on observed accrual economics — RFC-0003 checkpoint 5).

## 4. Regression smoke (15 min)

- Manual order ticket on an external (browser-signed) account still works end-to-end.
- A conditional Smart Order (non-farming) still triggers and, in manual mode, awaits your
  confirmation; with `FEATURE_CONDITIONAL_LIVE_EXECUTION=true` an `auto` strategy submits
  through the deposit wallet and the audit shows `rule.executed_auto`.
- Funds sheet renders with the withdraw flag OFF (explains withdrawals are disabled).
- Orderbook panel, AI chat sizing, and settings paddings unchanged (round-5 fixes).
- `pnpm run check` is green on the deployed commit.

## If something goes wrong

- **Anything live misbehaving** → cockpit Halt (per-session), then
  `POST /api/admin/quoter/pause` (all loops), then `POST /api/admin/trading/pause` (global).
- Funds always sit in YOUR deposit wallet; the withdrawal path (Section 2) works
  independently of farming.
- Capture the session's event stream + the audit log rows and file them with the bug.

---

## 2026-07-19 addendum — acceptance checklist for the full-cycle reliability slate

Deploy prerequisites: run `pnpm db:migrate` (migration 0019 — its backfill
retires your stuck "deposit detected" record automatically), restart api +
worker (packages rebuilt from dist).

Walk the cycle end-to-end and check each joint:

1. **Deposit** (small amount via Arbitrum as before): tracker advances; if the
   provider stalls but funds arrive, the record self-completes within ~1 poll
   after 10 min ("chain reconciled"); a record with no progress for 24 h shows
   "expired — never completed" and any stuck pending record older than 1 h has
   a **Dismiss** action. The funds sheet now shows **In trading account** vs
   **In your wallet** side by side.
2. **Authorize**: after the deposit completes, the success card shows
   **"Next: authorize trading"**; the wallet card shows a **Needs
   authorization** badge and an **Authorize trading** primary button until the
   on-chain allowances are clean.
3. **Withdraw**: a **Withdraw** button now sits on the wallet card; amount
   inputs everywhere have 25/50/75/Max presets; after a withdrawal, "In your
   wallet" updates within seconds (no vanished funds).
4. **Strategy setup**: new strategies default to **Instant** triggering; arming
   an auto strategy while anything blocks unattended execution shows a warning
   at save time and an **AUTO UNAVAILABLE** badge + banner afterward — with
   the exact reasons.
5. **Monitoring**: the strategy page shows one chart per watched market
   (threshold line, 1D/1W/1M, engine-event markers), live condition readings,
   and a timeline that names every skip/pause/retry in plain language
   ("Trading balance $X < order $Y — will retry when your deposit lands").
6. **Editing live**: the **Edit** button on the list/detail opens the quick-edit
   sheet; **Apply changes** swaps in the new version atomically (old one shows
   "replaced by an edit" with a link; spend caps carry over).
7. **Data-lag behavior**: on a quiet market, the hold window now shows
   "paused (waiting for fresh data)" then "resumed (quiet gap not counted)"
   instead of silently restarting.
8. **Staged enable (when satisfied with all of the above on staging):** run
   `pnpm --filter @mx2/api run check-live-readiness`; set
   `FEATURE_PRIVY_SIGNING=true FEATURE_LIVE_TRADING=true
FEATURE_CONDITIONAL_LIVE_EXECUTION=true` on the deployment; arm ONE
   low-value auto strategy with tight caps (≤$5/order) and watch it execute
   unattended end-to-end; only then resume normal use. If a trigger fires
   while funds are still bridging, expect "Auto-retry scheduled … will execute
   when funds arrive" followed by execution or a Telegram "Auto-execution
   needs you" notice within 30 min.
