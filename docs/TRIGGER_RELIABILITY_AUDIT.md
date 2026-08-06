# Trigger Reliability Audit — conditions met must ALWAYS produce a signing prompt

_Date: 2026-08-06 · Scope: the full path from "price moves on Polymarket" to "Review & sign
appears in front of the user" · Trigger for this audit: the owner's incident of the same day._

---

## 1. Executive summary

**The incident.** Strategy: _"if 'Bitcoin Up or Down — Aug 6, 12:15–12:20' UP drops 10¢+ in
1 minute → BUY 'Ahmed al-Sharaa out as leader of Syria' limit 91¢ × 10"_. The drop really
happened on the tape. The detail panel even showed the condition chip **met**. But the card
said **"no fresh data"** and no signing proposal was ever created. The market expired 5
minutes after opening, and the strategy died with nothing to show.

**Root cause.** The system had three separate evaluation paths that could not agree:

1. **The worker** (the only component that can fire a trigger) computed "drop 10¢ in 1m"
   from an in-memory price buffer that **starts empty** when a strategy is armed or the
   worker restarts, was **wiped for every token on any WebSocket reconnect**, and was
   **never backfilled** from Polymarket's price-history API. Until it accumulated a full
   60 seconds of continuous samples it reported the condition as "stale", and the
   fail-closed rule (correctly) suppressed everything. On a 5-minute market, that warm-up
   blindness consumed the strategy's whole life.
2. **The panel's "met" chip** polls an endpoint that falls back to live CLOB data — so it
   truthfully said _met_ at the exact moment the engine was structurally blind.
3. **The card's "no fresh data" badge** reads DB snapshots that WebSocket price-change
   deltas never updated — so an actively-trading market looked stale.

**Two additional bugs were caught during live verification of the fixes** — both
pre-existing, both previously masked _by_ the blindness above (a window that can never
complete can never produce a false answer either):

4. Polymarket's `book` frames list levels **worst-first**; the mid-price computation read
   `bids[0]`/`asks[0]` raw, producing a **phantom mid of ~0.50** for every book frame
   (e.g. bids 0.01…0.12, asks 0.99…0.13). On a 12.5¢ market this fabricated a "37.5¢
   drop" and fired a **false trigger** — reproduced twice on the live stack, then fixed.
5. `price_change` items without best-bid/ask fields fed their **raw level price** (which
   can sit anywhere in the book) into the price window — another phantom-move source.

**What changed** (all fixes covered by failing-first tests that reproduce the incident):

| Area                                             | Before                                                                                                                         | After                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| price_move readiness after arm/restart/reconnect | blind for the full window (60 s+), often forever                                                                               | evaluable after ~1 REST round-trip (seeded from CLOB `/prices-history`)                                |
| WS reconnect                                     | wiped EVERY token's price history                                                                                              | per-token gap-mark + automatic reseed                                                                  |
| WS keepalive                                     | none — upstream mandates client `PING` every 10 s, so the server dropped us regularly (each drop = full wipe)                  | 10 s client PING + 30 s dead-transport terminate-and-reconnect                                         |
| Trigger write                                    | CAS + trigger insert + notification as 3 separate writes (silent drops, "TRIGGERED with nothing to sign", duplicates possible) | ONE transaction + DB unique index on (rule, triggerNumber) + audited drops                             |
| Notification to browser                          | polling only, worst case ~9 s                                                                                                  | Postgres NOTIFY → SSE push, **measured ~30 ms** commit→browser (polling kept as fallback)              |
| Mid-price computation                            | raw `[0]` levels → phantom 0.50 mids in windows and snapshots                                                                  | best-level mid regardless of upstream ordering                                                         |
| Resolved markets                                 | indistinguishable from a dead feed ("no fresh data" forever)                                                                   | Gamma status poll → strategy INVALIDATED + "market resolved" copy                                      |
| UI freshness                                     | fabricated "updated 1s ago"; badge on any stale leaf; button hostage to one endpoint                                           | real server ages; badge names the quiet market; Review & sign falls back to the awaiting-triggers list |

**Measured end-to-end latency (live stack, 2026-08-06):** feed receipt → evaluated **1 ms**;
evaluated → committed (trigger row + outbox + NOTIFY, one transaction) **12 ms**; commit →
SSE event at the browser-facing stream **~30 ms**. Total: **well under half a second**
including the browser's refetch, vs a previous worst case of ~4–9 s of polling — and
vs **never** in the incident class.

---

## 2. Defect catalog (before → after, with proof)

Automated proof lives in `apps/worker/src/trigger-reliability.scenario.test.ts` — a
scenario harness that drives **raw WebSocket frames** through the real normalization and
evaluator code with fake stores (`apps/worker/src/test-support/scenario.ts`). Every P0
test was written first and watched fail against the old code (transcript:
5 failed / 9 passed, preserved in the session's before-run log).

### P0-1 — The incident: price_move blind for its full window after arming

- **Symptom:** drop happens 40 s after arming; recovery 15 s later; strategy never fires;
  market expires; panel said "met" the whole time.
- **Root cause:** `apps/worker/src/price-window.ts` in-memory buffer starts empty;
  `priceMove()` (`packages/rules/src/predicates.ts`) requires a sample at/before the
  window start; incomplete window → `PRICE_MOVE_WINDOW_INCOMPLETE` → `stale: true` →
  global fail-closed veto (`packages/rules/src/evaluate-v2.ts`). No backfill existed.
- **Fix:** `apps/worker/src/price-seeder.ts` seeds each price_move token's window from
  CLOB `/prices-history` (1-minute bars) at arm and worker restart;
  `PriceWindowStore.merge` guarantees a seeded sample can never become the newest sample
  (live data always wins), so seeding can reveal a real move early but never fabricate
  one. The engine's fail-closed semantics are untouched — `packages/rules` has **zero**
  changes.
- **Proof:** test `THE INCIDENT: 10¢+ drop 40s after arming on a 5-minute market fires
ONE signing proposal at the drop` (red before, green after — trigger recorded at
  T+40 s ±3 s). Live: a fresh price_move strategy was fully evaluable 90 s after arming
  (`evaluate-now`: `PRICE_MOVE_FAIL`, `actual: 0`, `stale: false` on a flat tape).

### P0-2 — Reconnect wiped every token's price history

- **Symptom:** any WS blip re-imposed the full 60 s blackout on ALL strategies.
- **Fix:** `onReconnect` now gap-marks each move token (discarding pre-gap samples so a
  carry-in can never silently span a dark period) and force-reseeds from upstream
  history — which is authoritative for what the market did while we were dark.
- **Proof:** test `WS reconnect must not blind an armed strategy: a drop 10s after
reconnect still fires`.

### P0-3 — REST freshness pass fed books but never price windows

- **Symptom:** a market whose data arrives only over REST kept a fresh book but a
  permanently incomplete (→ suppressed) move window.
- **Fix:** REST verify results and heartbeats push the (best-level) mid into the window;
  the verify pass also no longer requires the WS to be "connected" — a just-fetched REST
  book is fresh data, and the old gate disabled the fallback exactly when it was most
  needed. Fail-closed still holds: WS **and** REST both dark → stale pause → reset, no
  trigger (regression-tested).
- **Proof:** tests `REST-only market (sparse WS)…` and `fails closed when WS AND REST are
both dark…`.

### P0-4 — Trigger creation was not atomic

- **Symptom (4 modes):** a computed trigger silently discarded on a status race (no audit);
  status TRIGGERED with **nothing to sign** if the insert failed after the status write; a
  signing prompt with no notification if the outbox write failed; duplicate signing
  prompts possible for repeat strategies (app-level guard covered "once" only).
- **Fix:** `packages/db/src/trigger-commit.ts` — status CAS + trigger insert + outbox
  insert + event-bus NOTIFY in **one transaction**; migration 0025 adds a partial unique
  index on `(rule_id, evidence triggerNumber)`; a lost CAS (user pause wins) now emits the
  new audit action `rule.trigger_dropped`; a twice-failed persist resyncs the rule from DB
  truth instead of leaving an in-memory zombie that is never evaluated again.
- **Proof:** three `atomicity:` scenario tests + `packages/db/src/trigger-commit.integration.test.ts`
  run against **real Postgres** (concurrent same-triggerNumber commits → exactly one row;
  injected mid-transaction failure → full rollback; NOTIFY only on commit). All 4 pass.

### P0-5 — Actively-trading markets looked stale to the UI

- **Symptom:** the "no fresh data" badge on a market ticking every second — because WS
  `price_change` deltas updated only the worker's memory, never the DB snapshot the UI
  reads.
- **Fix:** the evaluator persists its patched book (rate-limited 1 write/s/token); the
  per-token staleness sweep replaced the old socket-global timer that marked EVERY token
  stale together.
- **Proof:** test `snapshot freshness: a delta-only tape keeps the persisted snapshot
fresh (rate-limited)`.

### P0-6 — Phantom mids and phantom prices (found during live verification)

- **Symptom:** on the live stack, a fresh price_move strategy on a flat 12.5¢ market
  **falsely triggered** with a recorded "37.5¢ drop" — twice.
- **Root cause A:** upstream `book` frames list levels worst-first (verified live: raw
  `bids[0]`=0.01, `asks[0]`=0.99); `computeMidPrice` read `[0]` → phantom 0.50 mid pushed
  into the window on every book frame (and stored as the snapshot's `midPrice`).
- **Root cause B:** `price_change` items without best-bid/ask fed their raw level price
  (deep-book orders included) into the window.
- **Fix:** `computeMidPrice` scans for the true best levels regardless of ordering;
  bestless price-change items contribute **no** price sample (the evaluator samples the
  patched book's mid instead); the evaluator also ignores frames for tokens nothing
  watches (one subscription delivers BOTH outcome tokens' frames — verified live).
- **Proof:** market-feed tests with deliberately worst-first asymmetric books; scenario
  test `a deep resting order can NEVER fabricate a price move`; live: the re-armed
  strategy stayed `ACTIVE_WAITING` with `actual: 0` on the same flat tape that had
  false-fired an hour earlier.

### P1 — WS contract violations (likely the source of production reconnect churn)

Verified against docs.polymarket.com on 2026-08-06 (recorded in
`docs/INTEGRATION_VERIFIED.md` §5):

- The client **must send the text frame `PING` every 10 s** — ours never did, so the
  server dropped the socket routinely; before these fixes every drop wiped all price
  windows (P0-2) and marked every snapshot stale.
- Dynamic membership changes use `{assets_ids, operation: "subscribe" | "unsubscribe"}` —
  ours re-sent the initial-subscription frame shape for additions (undocumented behavior)
  and sent **nothing** for removals.
- Both fixed in `packages/polymarket-client/src/ws/market-client.ts`, plus: a dead
  transport (30 s total silence despite our PINGs) is terminated and reconnected
  immediately; a close+error storm can no longer double-schedule reconnects (overlapping
  sockets). Covered by a new transport-contract test suite driven through an injected
  fake socket.

### P1 — Resolved markets masqueraded as stale data

- **Symptom:** a resolved 5-minute market just went quiet; strategies churned DATA_STALE
  forever; the card said "no fresh data" about a market that no longer exists.
- **Fix:** `apps/worker/src/market-status-poller.ts` polls Gamma's closed/active flags
  for watched markets (60 s); `closed` → the strategy is **INVALIDATED** with reason
  `MARKET_RESOLVED` (a path that existed in the state machine but was unreachable), and
  the UI now says **"market resolved"**.
- **Proof:** poller unit tests + scenario test `market resolution INVALIDATES the
strategy instead of eternal 'no fresh data'`.

### P2 — UI truthfulness

- "updated 1s ago" was **fabricated** (hardcoded age 0); now the real server-side
  snapshot age rides in the overview payload.
- "no fresh data" fired on ANY stale leaf; now it names the quiet market
  ("waiting for data — <market>") and distinguishes "market resolved".
- The Review & sign button depended solely on the overview endpoint's actionability; it
  now falls back to the awaiting-triggers list, so no single slow poll can hide a
  signing prompt.
- The signing modal's "data Ns old" disclosure referenced fields the API never returned
  (it silently never rendered); the trigger-detail endpoint now returns them.
- "last check 2h ago" on a healthy monitoring strategy (the timestamp only advanced on
  state changes) now reads "monitoring live" while the strategy is active.

---

## 3. The push pipeline (new)

```
worker: condition satisfied
  → ONE Postgres transaction: rule status CAS + rule_triggers row
    + notification_outbox row + pg_notify('mx2_events', …)     ← 12 ms measured
  → API (LISTEN mx2_events) → per-wallet SSE fan-out           ← ~30 ms measured
  → browser EventSource → invalidates action-center/strategy queries
  → Review & sign renders; Telegram/Discord dispatcher also drains the outbox
```

Because the NOTIFY happens **inside** the transaction, a listener can never observe a
trigger that was rolled back. Every pre-existing poll is untouched — if the SSE stream
dies, the product degrades to exactly its old behavior, never worse.

---

## 4. How to verify manually

Everything below was executed against the local stack on 2026-08-06.

### 4.1 Run the stack

```bash
pnpm compose:up && pnpm db:migrate && pnpm build
```

```bash
FEATURE_CONDITIONAL_RULES=true APP_LOG_LEVEL=debug pnpm dev:worker
```

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

(The worker does not read `.env` — pass env vars in the shell as above.)

### 4.2 The incident, replayed as an automated test

```bash
pnpm vitest run apps/worker/src/trigger-reliability.scenario.test.ts
```

Read the test named `THE INCIDENT` — it is the screenshot's timeline in code: 5-minute
market, armed at open, 13¢ drop at T+40 s that recovers by T+57 s, and asserts exactly one
signing proposal recorded at the drop. To see the OLD behavior, stash the fixes and run it
again: zero triggers, `PRICE_MOVE_WINDOW_INCOMPLETE`.

### 4.3 Instant readiness of a fresh price_move strategy

In the UI: build "if <any active market> drops 10¢ in 1 minute → buy X", arm it, and open
the strategy panel. Within ~2 seconds the condition row shows a real measured move
("now 0¢ · not yet") instead of "no data". Over curl:

```bash
curl -s -b "mx2_session=<your session>" \
  localhost:3001/api/strategies/<id>/evaluate-now | python3 -m json.tool
```

Expect `"reason": "PRICE_MOVE_FAIL"` (or `_OK`), `"stale": false` — never
`PRICE_MOVE_WINDOW_INCOMPLETE` while the market is live. Worker log shows one
`Price-window seeded from history` line per market.

### 4.4 Trigger → signing prompt latency

Arm a strategy whose condition is already true (e.g. price ≤ 99¢). Watch:

- worker log: `trigger.latency` with `feedToEvalMs` / `evalToPersistMs`;
- the strategies page: the "Conditions met — Review & sign" popup appears effectively
  instantly (SSE), not after a poll tick;
- the SSE stream directly:

```bash
curl -N -b "mx2_session=<your session>" localhost:3001/api/realtime/stream
```

fires `event: mx2` with `{"kind":"rule.triggered", …}` the moment the worker log line
appears (measured gap ≈ 30 ms).

### 4.5 Worker restart / reconnect resilience

Arm a price_move strategy, kill the worker, restart it. The `seeded` log line reappears
and `evaluate-now` is evaluable again within seconds (previously: blind for a full
window). Timeline (`/api/strategies/<id>/timeline`) shows any stale pause/resume as
audited `rule.state_changed` events — silent resets no longer exist, and any dropped
trigger would appear as `rule.trigger_dropped` (reasons: `cas_lost` = your own
pause/cancel won the race; `persist_failed` = DB outage, rule resynced and re-fired).

### 4.6 What to grep when something looks wrong

| Signal                                             | Meaning                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `trigger.latency`                                  | a trigger was committed; carries feed→eval→persist timings                                |
| `rule.trigger_dropped` (audit)                     | a computed trigger was NOT recorded — the reason says why; this is now impossible to miss |
| `Price-window seeded from history`                 | seeding worked for a token                                                                |
| `Price-window seed failed` / `returned no history` | seeding degraded — strategy falls back to live-fill (old behavior)                        |
| `Duplicate trigger suppressed by unique index`     | a race was safely absorbed by the DB                                                      |
| `Token quiet — marking snapshot stale`             | one token's data genuinely stopped (per-token now, not all-tokens)                        |
| `Market status changed upstream`                   | Gamma reported the market resolved/paused                                                 |
| `Event-bus LISTEN established` (api)               | the SSE fast path is live                                                                 |

---

## 5. Residual risks (disclosed, all fail-closed)

- **Seed-bar coarseness.** `/prices-history` bars are ~1-minute resolution; a move that
  completed entirely BEFORE arming can be under-measured inside the seeded region. This
  can only delay/miss (never fabricate) a trigger, and only for pre-arm moves; the live
  window takes over within seconds.
- **Trade-vs-mid mixing.** Seed bars and `last_trade_price` prints are trade-based;
  live samples are best-level mids. On a thin market with a stale last trade these can
  differ; both are honest market prices, and the book-freshness gate still applies.
- **Gamma status lag.** Market resolution is detected on a 60 s poll; a strategy can
  churn stale for up to a minute before being invalidated (previously: forever).
- **Single-worker topology** is unchanged (D-001): these fixes assume one evaluator
  process, as before. Do not run multi-instance without leasing (R-011).
- **Live subscription semantics.** `operation: subscribe/unsubscribe` frames are
  implemented per current docs; if upstream silently ignores them on some gateway
  versions, the reconnect path (full-set resubscribe on open) remains the safety net.
