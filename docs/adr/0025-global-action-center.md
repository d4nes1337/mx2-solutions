# ADR-0025 — Global Action Center

- **Status:** Accepted (owner-approved plan, 2026-07-23; Slice 4 of the private-beta release brief)
- **Date:** 2026-07-23
- **Decision id:** D-048

## Context

The brief (§6) requires a single global destination where a signed-in user notices, inspects, and
signs a triggered Smart Order from anywhere in the app. Before this, awaiting triggers surfaced
only via page-local `TriggerAlert` banners on two pages (Smart Orders + a market page), so a user
on any other route would miss a ready-to-sign order. All the cross-cutting primitives the brief
asks for (toast, tab/favicon badge, sound, desktop notifications, cross-tab dedupe) were greenfield.

## Decision

1. **One backend batch read, snapshot-only, fail-closed.** New `GET /api/action-center`
   (`apps/api/src/routes/rules.ts`) — full-session auth only (a restricted sign-link session cannot
   enumerate the wallet's orders), wallet-scoped, bounded (`ACTION_CENTER_ITEM_CAP`). It resolves
   every awaiting trigger against worker `market_snapshots` (no upstream fan-out in the request
   path) to an honest state via the shared `@mx2/rules` evaluator: `READY_TO_SIGN` (fresh + holds),
   `PRICE_MOVED` (fresh + no longer holds), `WAITING_FOR_FRESH_DATA` (any stale/missing referenced
   market — fail-closed). `actionableCount` counts only `READY_TO_SIGN`. The single-trigger detail
   endpoint remains the FINAL fresh review before any signature — this batch is never a signing path.
2. **One global host.** `ActionCenterHost` mounts once in `AppChrome` (excluded from `/m/*`
   restricted routes). It owns the one query (`useActionCenter`, retained 4s poll — no SSE for
   5–10 users; refetch on focus; confirm/dismiss invalidate `["action-center"]` immediately), the
   toast, the tab title/favicon badge, sound, desktop notifications, cross-tab dedupe, and opens
   the existing `TriggerConfirm` fresh-review + signing modal. The two page-local `TriggerAlert`
   mounts (and the component) were removed; the Smart Orders card "Review & sign" now routes
   through the shared `action-center-store`.
3. **Header bell + drawer.** `ActionCenterBell` in the header cluster (a11y "Action Center — N
   ready to sign", badge caps at 9+, subtle dot when awaiting-but-not-ready). Desktop opens a
   right-side drawer, mobile a bottom sheet (`ActionCenterDrawer`, matchMedia-switched). Each item
   shows state, strategy, market/outcome, condition summary, actual vs threshold, side/size/max
   spend/limit/order-type, data age, and account, with a per-state CTA ("Review & sign" /
   "Review what changed" / "Refresh check") and Dismiss.
4. **Alerts are opt-in and deduped.** Sound (a bundled short neutral `/sounds/alert.wav`), the tab
   title `(N) Ready to sign · Arima` + canvas favicon badge (restored at zero and on sign-out),
   and desktop notifications are all gated behind an explicit "Enable browser alerts" gesture —
   the ONLY moment OS permission is requested (never on load). Sound plays once per newly-ready
   trigger, never on poll/render/focus, never for `PRICE_MOVED`/stale. Cross-tab: `BroadcastChannel`
   - Web Locks leader election (localStorage-lease fallback) so every tab updates the badge but
     only the leader plays sound + shows the desktop notification; per-device handled-ids
     (localStorage, pruned) dedupe across reloads. Server trigger status stays the source of truth.
5. **Owner refinement (2026-07-23):** the user is actively prompted to turn on browser alerts —
   the "Enable browser alerts" prompt shows in the drawer footer, and arming a strategy opens the
   Action Center once (when alerts are still off) — followed by an optional "connect Telegram"
   link for when Arima is closed.
6. **Privacy/safety invariants:** the desktop body is privacy-safe by default (no trade details
   unless the user opts in); a notification/toast never executes an order — every path opens
   `TriggerConfirm`, which still requires the fresh preview + wallet signature.

## Consequences

- A signed-in user is alerted to a ready-to-sign order from any full-app route, once, without a
  chorus across tabs. Behavioral/UI only — no schema change, no new flag.
- Rollback: unmount `ActionCenterHost` and restore the `TriggerAlert` mounts (kept in git history);
  the endpoint is additive.

## Verification (2026-07-23, local)

API: `GET /api/action-center` unit-tested for all three states (READY/PRICE_MOVED/WAITING),
fail-closed on missing snapshot, `actionableCount`, 401 without a full session, and rejection of a
restricted sign-link session (5 tests); live-verified authed (200 + correct shape) and unauth
(401). Web: cross-tab handled-id dedup + prune, tab-badge title set/restore + 9+ cap, and
notification-prefs persistence unit-tested (5 tests). Browser (real seeded session): the header
bell renders; the desktop right drawer opens with the honest empty state and the browser-alerts
priming + "connect Telegram" link; the explicit "Enable browser alerts" gesture flips the footer
to the per-device controls (Sound / Desktop — correctly shown "(blocked)" when OS permission is
denied / Show-details / Play test sound); signed-out chrome renders clean with the bell absent and
no page-local alerts. Suites: 769 root + 297 web green; typecheck/lint/format clean. Owner live
checks (wallet-connection + live-trigger gated): audible ping, a granted-permission desktop
notification, the two-tab single-notification dedupe, and a populated drawer + toast.
