# Arima Private Beta Release Brief

**Version:** 1.0  
**Date:** 23 July 2026  
**Status:** Owner-approved product direction; implementation planning handoff  
**Primary audience:** Claude Fable / senior implementation agent  
**Target:** A controlled private beta for 5–7 active Polymarket traders, followed by a 10-person Season 0 cohort

## Executive instruction

Build the smallest reliable private-beta release around one promise:

> Describe the setup. Arima watches Polymarket. You sign when it hits.

The connected Polymarket wallet is the default trading mode. The Arima Wallet remains available as an explicit, opt-in Beta feature for users who want automated execution with ring-fenced funds and strict limits. Do not require a deposit before the user receives value.

The release must add a global Action Center so a signed-in user can notice, inspect, and sign a triggered Smart Order from anywhere in the application. Every browser-signed order and every Arima Wallet order must carry and preserve Arima's configured Polymarket builder code.

This brief is an implementation contract, not permission to enable unrestricted live trading. All money-moving features remain fail-closed behind existing flags and owner gates. Follow `AGENTS.md`, the requirements kit, Gate 6, and the low-value staged rollout in this document.

## 1. Locked product decisions

The owner has approved the following decisions.

1. The existing/main Polymarket wallet is the default. Manual wallet signature is the promoted beta execution path.
2. The Arima Wallet is an additional opt-in Beta feature. It must not be hidden, but it must not be the onboarding prerequisite or global navigation priority.
3. The global Deposit button is removed. Funding is shown only in contextual Arima Wallet flows and after opt-in.
4. Arima Wallet creation is lazy. Do not provision an internal wallet automatically at login; provision only after an explicit user action.
5. The strategy playground, AI draft, examples, and simulation are public. Saving, arming, notifications, trading, private portfolio data, and Season 0 participation require an invitation.
6. The first cohort is 5–7 active traders. The public goal is a 10-person Season 0 cohort.
7. Private beta access and Arima fees are free. Do not promise “free forever.”
8. Season 0 uses non-transferable Beta Points with no monetary value or promise of a token, payment, or future benefit.
9. A qualifying Arima Wallet Smart Order fill earns 2× the normal filled-order point award, subject to caps. Deposits and uncapped trading volume never earn points.
10. Beta Points determine the default Season 0 rank. PnL and routed volume are secondary, opt-in statistics and must not determine the default rank.
11. The advanced graph canvas may remain desktop-first. The mobile path must support landing, AI draft, review, waitlist/invite, alerts, Action Center, and signing.
12. Rollout is low-value and staged: owner first, two testers next, then the rest of the cohort. No $10K–$20K Arima Wallet beta deposits.

## 2. Release outcome and success criteria

### 2.1 Primary user outcome

An invited active Polymarket trader can, without live guidance:

1. Connect and sign in with the wallet they already use.
2. Create a Smart Order from an AI prompt, template, or simple manual path.
3. Understand the rule, watched markets, order size, maximum spend, and execution mode.
4. Arm the strategy in “Ask me to sign” mode.
5. Enable browser alerts and/or connect Telegram.
6. Notice when the conditions are met.
7. Open a fresh review showing whether the setup still holds.
8. Sign and submit the prepared order with Arima's builder code attached.
9. See confirmation, fill state, or an honest failure/recovery state.

### 2.2 Beta activation definition

A user is activated only when all of the following are true:

- One valid strategy was created.
- The strategy was saved and armed.
- At least one notification channel was enabled: browser alerts or Telegram.
- The user reached a real trigger or completed a controlled test notification.

Do not use account creation or waitlist signup as the activation metric.

### 2.3 Promotion gate from 5–7 testers to 10

- At least 70% create a strategy.
- At least 50% arm a strategy and enable notifications.
- At least five users complete the core flow without owner intervention.
- At least three users receive and act on a real trigger.
- At least 50% return during the following seven days.
- No ambiguous, duplicate, or unattributed money-moving event occurs.
- Trigger-to-browser-alert latency is measured and acceptable for the observed strategies.
- All Gate 6 operational checks are complete.

## 3. Product vocabulary

Use the following language consistently in UI, analytics, API documentation, tests, and marketing.

### 3.1 Feature and state names

- **Action Center:** the global in-app destination for items requiring the user's attention.
- **Conditions met:** the strategy became true at the recorded trigger time.
- **Ready to sign:** current data is fresh, the condition still holds, and a fresh order preview is available.
- **Price moved:** the strategy triggered, but the current condition no longer holds.
- **Waiting for fresh data:** the system cannot safely claim the setup still holds.
- **Signed and submitted:** the user signed and Arima submitted the order.
- **Executed automatically:** the Arima Wallet path submitted the order under approved limits.
- **Dismissed:** the user chose not to act.

Do not use “in condition,” “order ready,” “AI trade,” or “guaranteed trigger.” “Order ready” alone is misleading after price movement. “Ready to sign” is reserved for a fresh, currently valid preview.

### 3.2 Execution-mode names

- **Ask me to sign** — default; uses the connected/main wallet.
- **Execute automatically · Arima Wallet Beta** — opt-in; requires a prepared Arima Wallet, explicit limits, and all live-execution gates.

### 3.3 Recommended core copy

Homepage headline:

> Stop babysitting Polymarket.

Homepage explanation:

> Describe the price, liquidity, or cross-market conditions. Arima watches live markets and tells you when every rule is true.

Trust row:

> Free private beta · Your wallet first · Automation is optional

Arima Wallet prompt:

> Want Arima to act when the setup hits? Use a separate, ring-fenced balance with strict limits. Free during private beta.

## 4. P0 — private-beta access and invitation boundary

### 4.1 Public surfaces

The following remain available without an invitation:

- Homepage and product explanation.
- Markets discovery and read-only market pages.
- AI strategy drafting, subject to public rate limits.
- Strategy examples and templates.
- Local draft editing and simulation.
- Waitlist submission.

Public users may understand and try the product before being asked to join the queue.

### 4.2 Invite-only surfaces

The backend must enforce invitation status for:

- Server-side draft persistence.
- Saving and arming Smart Orders.
- Browser, Telegram, and Discord notification configuration.
- Manual and automatic order submission.
- Private portfolio and account data.
- Arima Wallet creation, funding, and withdrawal.
- Season 0 enrollment and private-beta leaderboard visibility.

Hiding buttons is not access control. Every private endpoint must enforce authorization server-side.

### 4.3 Required implementation

1. Keep `FEATURE_OPEN_BETA=false` in beta environments. Remove any deployment assumption that unknown wallets will be auto-allowlisted.
2. Add a waitlist record with at least:
   - email;
   - X or Telegram handle;
   - wallet address when available;
   - Polymarket trading frequency;
   - short intended use case;
   - referral/source;
   - consent timestamps;
   - status: `waiting | invited | accepted | rejected | withdrawn`.
3. Add one-time invitation codes:
   - store only a secure hash;
   - expiry and single-use enforcement;
   - record issuing actor and redemption wallet;
   - idempotent redemption;
   - audit all creation, redemption, rejection, and revocation;
   - do not allow a client-supplied wallet to redeem a code for a different authenticated wallet.
4. For the first cohort, provide an owner-only command or admin endpoint to create invitations. Email sending may be manual. Do not block launch on automated campaign infrastructure.
5. Give non-invited users a clear state:
   - “Your draft is ready.”
   - “Private beta access is required to save, arm, and receive live triggers.”
   - Waitlist CTA and an explanation of what happens next.
6. Add rate limits and bot/spam protection to the waitlist and public AI routes.

### 4.4 Acceptance criteria

- A public visitor can create and simulate a draft without private data exposure.
- A non-invited wallet cannot save, arm, configure notifications, access portfolio data, or submit an order through direct API calls.
- An invitation cannot be replayed, enumerated, transferred after redemption, or redeemed for another authenticated wallet.
- Revoking an invited wallet immediately blocks future private actions without deleting audit history.
- `FEATURE_OPEN_BETA=true` remains an explicit future decision, not a beta default.

## 5. P0 — wallet hierarchy and trading-mode changes

### 5.1 Main-wallet default

The first visible trading mode is:

> Your wallet — sign each trade yourself.

It must be selected by default when a strategy action is created. The user must not be asked to fund Arima before building, arming, receiving a trigger, or opening a manual signing preview.

### 5.2 Arima Wallet Beta

The Arima Wallet remains visible as an advanced feature:

- Add a Beta badge.
- Explain that it uses a separate, ring-fenced balance.
- Explain that automation is opt-in.
- Show limits before any enablement.
- Keep Deposit, Withdraw, Pause, Revoke, and wallet health controls on the Wallet page.
- Link to the wallet contextually when the user selects automatic execution.

### 5.3 Exact UI changes

1. Remove the global `HeaderWallet` balance/Deposit control from the header.
2. Remove the large Add funds emphasis from the account dropdown before Arima Wallet opt-in.
3. Keep a neutral “Arima Wallet Beta” entry in the Wallet page or account menu.
4. Make the main-wallet card visually primary; the Arima Wallet card must not receive the only brand-colored emphasis before opt-in.
5. Stop automatic internal-wallet provisioning during login.
6. Provision the internal Privy wallet only after an explicit “Enable Arima Wallet Beta” action.
7. Require a short confirmation that explains:
   - separate wallet and balance;
   - automation capability;
   - per-order/daily/total limits;
   - pause and withdrawal controls;
   - primary wallet key is never requested;
   - automation remains subject to feature flags and regional restrictions.
8. The builder execution selector defaults to “Ask me to sign.” Selecting auto opens the Arima Wallet readiness flow if needed.

### 5.4 Acceptance criteria

- Signing in does not create an Arima Wallet.
- A user can complete the full manual flow without seeing a Deposit CTA in the header.
- Arima Wallet setup begins only after explicit consent and is auditable.
- Switching to automatic execution never silently provisions, funds, authorizes, or changes the primary trading account.
- Existing funded internal wallets remain discoverable and withdrawable after the hierarchy change.
- No migration archives, replaces, or strands an existing wallet.

## 6. P0 — global Action Center and browser notification workflow

### 6.1 User experience

When a manual Smart Order triggers, the user should experience the following:

1. The server records a durable trigger with evidence.
2. Arima evaluates a fresh, current preview from worker snapshots.
3. If data is fresh and the condition still holds, the item becomes **Ready to sign**.
4. A single in-app toast appears.
5. The header Action Center icon shows an actionable count.
6. The browser tab title and favicon show that action is required.
7. If sound is enabled, one ping plays.
8. If desktop notifications are enabled and the tab is hidden, the browser shows a privacy-safe desktop notification.
9. Clicking any surface opens the fresh review and signing modal.
10. Confirming or dismissing removes the item from the actionable count everywhere.

If the condition no longer holds, show **Price moved**. If data is stale, show **Waiting for fresh data**. Do not play the “Ready to sign” sound until the item actually enters the fresh actionable state.

### 6.2 Global placement

Mount a single `ActionCenterHost` in the global application chrome, not on individual market or Smart Orders pages.

The host owns:

- one global actionable-trigger query;
- header icon and count;
- drawer/sheet;
- toast lifecycle;
- tab title and favicon badge;
- sound and desktop-notification behavior;
- opening the existing `TriggerConfirm` flow;
- cross-tab notification deduplication.

Do not mount the host on `/m/*` restricted-session routes. Those routes retain their focused mobile signing surface.

Remove or refactor page-local `TriggerAlert` instances so the same trigger does not render twice.

### 6.3 Action Center item content

Every item must show:

- state label;
- strategy name;
- market and outcome;
- trigger time;
- short rule explanation;
- actual value versus threshold when available;
- BUY or SELL;
- shares and estimated maximum spend/proceeds;
- limit/worst acceptable price;
- order type;
- data age;
- selected trading account;
- primary CTA;
- Dismiss action.

Primary CTA by state:

- `READY_TO_SIGN`: “Review & sign.”
- `PRICE_MOVED`: “Review what changed.” Do not present an immediate signing button in the drawer.
- `WAITING_FOR_FRESH_DATA`: “Refresh check.” Signing remains disabled until a fresh preview is available.

The full review modal may allow a deliberate “Review anyway” path after price movement, but it must show current values, repeat the warning, and never submit a stale preview.

### 6.4 Backend contract

Reuse the existing trigger store, evidence, snapshot evaluation, and signing preview. Add or evolve a batch endpoint so the global UI does not make one detail request per trigger on every poll.

Recommended route:

`GET /api/action-center`

Recommended response:

```json
{
  "generatedAt": "2026-07-23T12:00:00.000Z",
  "actionableCount": 1,
  "items": [
    {
      "triggerId": "uuid",
      "ruleId": "uuid",
      "ruleName": "Buy the rebound",
      "triggeredAt": "2026-07-23T11:59:45.000Z",
      "state": "READY_TO_SIGN",
      "market": {
        "conditionId": "0x...",
        "title": "Will ...?",
        "outcome": "YES",
        "tokenId": "..."
      },
      "conditionSummary": "YES rebounded 5c from its low",
      "actual": "49c",
      "threshold": "48c",
      "dataAgeMs": 900,
      "action": {
        "side": "BUY",
        "sizeShares": 100,
        "price": "0.48",
        "maxSpendUsd": "48.00",
        "orderType": "GTC"
      }
    }
  ]
}
```

Requirements:

- Full-session authentication only.
- Wallet scoping on every query.
- Snapshot-only batch evaluation; no upstream fan-out in the request path.
- Missing or stale data fails closed.
- Bounded result count and pagination/history plan.
- The endpoint returns current state, not a cached claim that the condition still holds.
- The existing single-trigger detail endpoint remains the final fresh review before signing.

For the first 5–10 users, retain the existing four-second authenticated poll rather than adding SSE infrastructure. Refetch immediately after confirm/dismiss and when the window regains focus. Record latency so SSE/WebSocket can be justified later. Browser-closed delivery is handled by Telegram in this release.

### 6.5 Header icon and drawer

- Use a bell or lightning-bell icon.
- Accessible name: “Action Center — N ready to sign.”
- Badge counts only items requiring action, not informational events.
- Badge displays `9+` above nine.
- Desktop opens a right-side drawer.
- Mobile opens a bottom sheet.
- The drawer remains usable with multiple triggers and keyboard navigation.
- The newest ready item appears first.
- Sound, desktop notification, and privacy controls are available in Settings and the drawer footer.

### 6.6 Toast

Title:

> Ready to sign

Body example:

> Buy 100 YES at up to 48c · Buy the rebound

Actions:

- Review & sign.
- Dismiss toast only; this must not dismiss the actual trigger.

The toast is prominent but non-blocking. It does not cover the wallet connector or core builder controls. If several triggers arrive together, show one summary toast and the total count rather than stacking an unreadable column.

### 6.7 Browser tab and favicon

- Default title remains the route title.
- With actionable items: `(N) Ready to sign · Arima`.
- Restore the previous route title when the count reaches zero.
- Badge the favicon with a small high-contrast dot or `1–9+` count.
- Preserve light/dark compatibility and restore the original favicon on sign-out.
- This is a signal only; the header Action Center remains the clickable control.

### 6.8 Sound

- Sound is opt-in and requires a user gesture due to browser autoplay policy.
- Add “Enable browser alerts” with a “Play test sound” control.
- Bundle a short, neutral, non-alarming sound locally.
- Default volume is modest and configurable.
- Play once when a previously unseen trigger enters `READY_TO_SIGN`.
- Never replay on every poll, render, focus, or route change.
- Never play for `PRICE_MOVED`, stale data, dismissed triggers, already confirmed triggers, informational fills, or auto-executed events unless the user explicitly enables those categories later.
- Respect reduced-motion settings for visuals; provide an independent sound toggle.

### 6.9 Cross-tab and reload deduplication

Multiple Arima tabs must not produce a chorus.

- Use `BroadcastChannel` to announce newly handled trigger IDs across tabs.
- Select one notification leader with Web Locks when available; use a short local-storage lease fallback.
- Persist per-device handled trigger IDs with timestamps in local storage and prune them.
- All tabs update their title/favicon count, but only the leader plays sound and creates the desktop notification.
- Server trigger status remains the source of truth for whether action is still required.

### 6.10 Desktop notifications

- Request permission only after the user presses “Enable browser alerts.”
- Never request permission on first page load.
- When the tab is hidden and permission is granted, show:
  - title: “Ready to sign — Arima”;
  - privacy-safe body: “Your Smart Order conditions were met. Review the current market before signing.”
- Add an optional “Show trade details in desktop notifications” preference, default off.
- Clicking focuses or opens Arima and opens the matching trigger review.
- If permission is denied, keep the in-app, tab, sound, and Telegram options usable.
- Service-worker Web Push while the browser is fully closed is out of scope for this release.

### 6.11 Notification tests

At minimum, test:

- zero, one, and multiple actionable items;
- fresh true, fresh false, and stale states;
- toast appears once for a new ready trigger;
- poll and rerender do not replay sound;
- two tabs produce one sound/desktop notification;
- title/favicon restore after confirm, dismiss, sign-out, and zero count;
- confirm/dismiss invalidates the global query immediately;
- a restricted `/m/*` session cannot enumerate other triggers;
- desktop permission granted, denied, and unsupported;
- mobile sheet and keyboard accessibility;
- no sensitive trade details appear in OS notifications by default;
- no order can submit from the notification itself without the existing wallet signature flow.

## 7. P0 — builder attribution integrity

Builder volume is credited only to matched orders carrying the correct builder code. Attribution is a release-critical invariant.

### 7.1 Browser-signed orders

The current browser order builder places the configured code into the V2 signed `builder` field. Harden the server boundary:

- Production/beta trading startup must fail closed if the configured builder code is missing, zero, or not a valid `bytes32` value.
- Before accepting a browser-signed order, the API must verify `signedOrder.builder` equals the configured builder code.
- Reject mismatch with a clear `ORDER_BUILDER_MISMATCH` error before creating/submitting a new order intent.
- Record the builder code in the intent and audit metadata.
- Do not display the raw code in the primary confirmation UI; place it under advanced execution details if needed.

### 7.2 Arima Wallet and automated orders

Verify the V2 server-signed `POLY_1271` build path attaches the same builder code inside the signed order. Do not assume intent metadata creates attribution.

- Extend the shared server-side order builder/submit contract to require `builderCode` for beta/live orders.
- Verify the generated signed order's `builder` field before submission.
- Cover the manual server-signed route, auto executor, retry sweeper, and maker loop/quoter paths.
- Preserve one shared signing implementation rather than patching call sites independently.
- Add a contract test against current official Polymarket V2 order-building behavior.

### 7.3 Attribution observability

- Emit a structured event for every submitted order with order intent, trigger, account kind, and builder code presence/match status.
- Add an owner diagnostic that compares local submitted/fill records with the Builder Trades endpoint.
- Do not log signatures, credentials, or sensitive payloads.
- Add a release checklist item: one low-value matched trade appears in Polymarket builder analytics within the documented reporting window.

### 7.4 Acceptance criteria

- Every submitted beta order has the exact configured non-zero builder code in the signed V2 order.
- A client cannot remove or replace the builder code and still submit through Arima.
- Browser-signed, server-signed, retry, and auto paths have tests proving attribution.
- Order idempotency and signature verification remain unchanged.
- A matched staging/low-value production trade is verified in builder analytics before cohort expansion.

## 8. P0 — builder and homepage hardening

Do not start a second full redesign of the monitoring dashboard before testing the action dashboard already built. Focus this release on comprehension and the core path.

### 8.1 Required fixes

1. Fix the AI dollars-versus-shares semantic bug. A user request for “$200” must never silently become 200 shares. If the action contract cannot represent dollar budgets, ask the user or convert explicitly using a fresh price and show the assumption before strategy creation.
2. Remove the homepage hero hydration/message swap and major layout shift.
3. Fix mobile horizontal overflow on the public draft/review path.
4. Remove contradictory market availability/geoblock states.
5. Ensure a default order price is derived from the requested strategy and fresh market context, not an unrelated static value.
6. Make the three entry paths clear:
   - Describe a setup;
   - Start from a template;
   - Start blank.
7. “Start blank” uses a simple progression before exposing the canvas:
   - choose market;
   - choose condition;
   - choose action;
   - choose execution mode.
8. Keep the advanced canvas available on desktop.
9. Preserve the current maximum of four markets. Do not expand to ten in this release.
10. Add one honest homepage example with reproducible backtest/hypothetical labeling and one CTA.

### 8.2 Mobile boundary

Required on mobile:

- homepage and example;
- public AI draft;
- waitlist and invite redemption;
- strategy summary/review;
- Action Center;
- browser/Telegram notification settings;
- fresh preview and wallet signing.

Allowed damaging admission:

> Advanced canvas editing is desktop-first during private beta. Alerts, review, and signing work on mobile.

## 9. P1 — Season 0 Founding Traders

Season 0 is built only after P0 access, Action Center, attribution, and low-value manual signing are green. If P0 slips, Season 0 is cut from launch rather than compromising execution reliability.

### 9.1 Enrollment and privacy

- Invite-only and opt-in.
- User chooses a public handle.
- Never show full wallet addresses.
- Allow an avatar and optional X handle.
- Record consent and allow withdrawal from public display.
- Withdrawing hides the profile but preserves required audit/accounting records.

### 9.2 Point schedule

Initial schedule:

- First valid strategy created: 20, once.
- First strategy armed: 30, once.
- Telegram connected: 10, once.
- First real trigger received: 20, once.
- Triggered order filled through main wallet: 40, at most once per UTC day.
- Triggered order filled through Arima Wallet: 80, at most once per UTC day.
- Active strategy retained for a week: 10, once per qualifying week.
- Useful interview: 100, owner-awarded.
- Confirmed product bug: 25–100, owner-awarded.

Rules:

- Append-only points ledger.
- Deterministic dedupe key for every automatic award.
- Reversal entries rather than destructive edits.
- No points for deposits.
- No uncapped points per dollar traded.
- No self-reported fill awards.
- Admin awards require reason, actor, and audit event.
- Display the no-value/no-promise disclosure wherever points are explained.

### 9.3 Leaderboard

Default order: Beta Points.

Show:

- rank;
- handle/avatar;
- points;
- Smart Orders filled;
- active-week streak;
- main-wallet or Arima Wallet badge;
- optional Arima Wallet PnL;
- optional Arima-routed volume.

Do not rank main-wallet PnL because it includes activity outside Arima. If Arima Wallet PnL is shown, label source, period, realized/unrealized treatment, and limitations. Absolute PnL and volume do not determine the default rank.

### 9.4 Anti-gaming and acceptance

- No duplicate awards on retries, fill resync, or worker restart.
- A cancelled/unfilled order earns no fill points.
- One user cannot enroll multiple public profiles for one authenticated owner wallet.
- Arima Wallet multiplier applies to qualifying product use, not balance size.
- Suspicious activity can be excluded with an audited owner action.
- Add terms language before public promotion of points.

## 10. Analytics and owner dashboard

Instrument the product funnel without storing secrets or unnecessary personal data.

Required events:

- `waitlist_joined`;
- `invite_created`;
- `invite_redeemed`;
- `strategy_drafted`;
- `strategy_saved`;
- `strategy_armed`;
- `browser_alerts_enabled`;
- `telegram_linked`;
- `trigger_created`;
- `trigger_ready_to_sign`;
- `action_center_opened`;
- `trigger_reviewed`;
- `wallet_signature_requested`;
- `order_submitted`;
- `order_filled`;
- `trigger_dismissed`;
- `arima_wallet_enabled`;
- `points_awarded`.

Required beta dashboard:

- invited users;
- accepted users;
- activation rate;
- strategies created/armed;
- active strategies;
- notification-channel adoption;
- trigger count;
- median and p95 trigger-to-browser-ready latency;
- Action Center open rate;
- trigger-to-review conversion;
- trigger-to-submit conversion;
- matched Arima-attributed volume;
- execution and notification failures;
- users returning in seven days.

Do not optimize for waitlist size as the north-star metric.

## 11. Safety, compliance, and operational gates

### 11.1 Invariants

- Never request, read, log, store, or transmit a user's private key or seed phrase.
- Primary-wallet trades require a fresh wallet signature.
- Notification links never execute an order by themselves.
- Every order remains idempotent.
- Stale or missing data fails closed.
- Regional restrictions are checked server-side before trading.
- Arima Wallet automation remains off by default.
- Do not enable unattended execution without the existing RFC, limits, threat model, owner gate, and staged validation.
- Terms, privacy notice, risk disclosure, and points disclosure are required before the wider beta.

### 11.2 Low-value rollout

Stage A — owner:

- $1–$5 per order;
- manual submit, fill/cancel, and reconciliation;
- one tightly capped Arima Wallet automated strategy;
- pause, revoke, kill switch, and withdrawal test;
- verify builder attribution.

Stage B — two testers:

- main-wallet manual mode first;
- $5 maximum per triggered trade during observation;
- Arima Wallet optional;
- automated limits no greater than $5/order, $25/day, and $100 lifetime per strategy;
- one automated strategy per tester.

Stage C — remaining cohort:

- admit only after Stage B has no unresolved money-moving incident;
- raise limits individually, never globally by default;
- keep automation exposure far below each trader's normal bankroll;
- do not solicit $10K–$20K Arima Wallet deposits.

### 11.3 Gate 6 release package

Before expanding beyond the owner:

- complete tests, lint, typechecks, formatting checks, and production build;
- run dependency and secret scans;
- verify auth/invite boundary tests;
- verify log redaction;
- test backup and restore;
- document deployment and rollback;
- verify monitoring and alerts;
- test kill switches;
- update `STATUS.md`, `DECISIONS.md`, `RISK_REGISTER.md`, and relevant ADRs;
- complete the owner acceptance checklist;
- record all enabled feature-flag states;
- keep live and unattended flags off until the specific staged gate is approved.

## 12. Recommended implementation sequence

Implement in vertical slices. Each slice must be demonstrable, tested, observable, and independently reversible.

### Slice 0 — read-only audit and plan

- Read all required project and governance documents.
- Inspect the dirty working tree and preserve user changes.
- Verify current official Polymarket V2 builder-code and order-signing behavior.
- Map existing code to this brief.
- Produce file/migration/test impact and no more than five blocking questions.

### Slice 1 — access boundary

- Waitlist, invitations, strict allowlist behavior, backend guards, public draft behavior.
- Demo: public draft works; direct private API calls fail; invite redemption unlocks them.

### Slice 2 — wallet hierarchy

- Remove global Deposit priority, lazy provision Arima Wallet, main-wallet default, contextual auto upgrade.
- Demo: manual flow without internal wallet; existing internal wallet remains recoverable.

### Slice 3 — builder attribution integrity

- Enforce builder code on every signed/submitted path and add diagnostics/tests.
- Demo: mismatched code is rejected; both browser and server-signed orders contain the correct code.

### Slice 4 — Action Center

- Global host, batch endpoint, drawer/sheet, toast, title/favicon, sound, desktop notification, cross-tab dedupe.
- Demo: a synthetic trigger produces exactly one alert and opens the fresh existing review/sign path.

### Slice 5 — activation-path UX fixes

- AI amount semantics, homepage layout stability, mobile overflow, availability copy, execution-mode clarity, start-blank path.
- Demo: first-time user completes the flow on desktop and the supported mobile subset.

### Slice 6 — Season 0

- Opt-in profile, points ledger, capped multiplier, leaderboard, privacy and anti-gaming.
- Demo: deterministic awards, no duplicates, correct sorting, opt-out.

### Slice 7 — release hardening and staged rollout

- Analytics, operational package, owner low-value test, two-user canary, cohort admission.

## 13. Explicit non-goals for this release

- Public beta.
- Ten-market strategies; retain the current four-market cap.
- Full mobile parity for advanced canvas editing.
- Browser push while all Arima tabs are closed.
- Native mobile application.
- News/social sentiment conditions.
- Copy trading.
- Guaranteed performance or AI trade recommendations.
- Pricing/billing implementation.
- Transferable points, token promises, or cash rewards.
- PnL-ranked competition across main wallets.
- Large-balance automated trading.
- A new distributed event bus, queue, or microservice solely for 5–10 beta users.

## 14. Definition of done

The release is done only when:

- The public-to-invite boundary is enforced at the API.
- The main wallet is the default and internal-wallet provisioning is opt-in.
- The global Action Center works on every signed-in full-app route.
- New ready triggers create one toast, one sound, one tab badge, and at most one desktop notification per browser profile.
- Fresh, moved, and stale trigger states are distinguished honestly.
- The signing modal always refreshes before money moves.
- Every submitted order contains the correct non-zero builder code.
- Manual and auto paths remain idempotent and fail closed.
- Supported mobile flows do not overflow and can complete signing.
- Season 0, if included, is opt-in, capped, non-monetary, and resistant to obvious duplication.
- All required tests and operational gates pass.
- The owner completes the low-value acceptance path before any tester uses live execution.

## 15. Copy-paste prompt for Claude Fable

You are the senior technical lead implementing the Arima private-beta release in `/Users/ettrq/mx2-solutions`.

Read `AGENTS.md` and every required document listed there before proposing architecture or changing source code. Then read this entire brief:

`docs/plans/ARIMA_PRIVATE_BETA_RELEASE_BRIEF.md`

Also inspect `STATUS.md`, `DECISIONS.md`, `RISK_REGISTER.md`, relevant ADRs, and the current working tree. Preserve all user-owned changes. Verify version-specific Polymarket V2 builder-code and signing behavior against current official documentation/repositories; do not trust stale signatures from project history.

Start with Slice 0 only: perform a read-only implementation audit and return:

1. Existing components and APIs that will be reused.
2. Exact files, database migrations, routes, components, flags, tests, and governance artifacts likely to change per slice.
3. Any contradictions between the brief and current code.
4. Security, privacy, compliance, attribution, and rollout risks.
5. A vertical-slice implementation plan with demo and rollback path for each slice.
6. At most five blocking owner questions, each with a recommended default and consequence.

Do not implement until the owner approves the plan and any required decision gate. After approval, implement one vertical slice at a time in the order defined by the brief. Every slice must include typed contracts, error handling, observability, deterministic tests, migration/rollback notes where applicable, browser verification, and updates to `STATUS.md`, `DECISIONS.md`, `RISK_REGISTER.md`, and ADRs when consequential.

Security and delivery invariants:

- Never request, inspect, log, or expose secrets or private keys.
- Do not enable live trading or unattended execution flags without the explicit owner gate and low-value staged test.
- Keep the main wallet/manual signature path as the default.
- Make Arima Wallet creation explicit and opt-in.
- Enforce invitations in backend routes, not only UI.
- Fail closed on stale data, missing builder code, attribution mismatch, regional restriction, or ambiguous order state.
- Preserve idempotency, append-only audit events, and explicit state machines.
- Do not add premature infrastructure for a 5–10 user beta.
- Never let an in-app, desktop, Telegram, or Discord notification execute an order without the required authorization path.

The first implementation priority after approval is the dependable path:

`public draft → invite → save/arm → Action Center → fresh review → wallet signature → builder-attributed submit`

Season 0 is P1 and must be cut before compromising this path.
