# ADR-0027 — Markets browse mirror and instant (recurring) markets

- Status: Built (2026-07-27)
- Owner decision: approved 2026-07-27 (plan `i-want-you-to-shimmering-wombat`); Block C
  explicitly deferred behind a walkthrough gate

## Context

Two market-discovery problems, one root cause: the app treated every Polymarket market as a
one-off.

1. The **Markets tab** was the custom-ranked home feed (ADR-0007/0012) capped at 18 cards with
   a tiny header search — no pagination, no categories, and a selection that never matched
   what users saw on polymarket.com.
2. The **builder search** drowned crypto queries in dead recurring instances: "btc" returned
   0/100 resolved "Bitcoin Up or Down" windows because nothing understood that those markets
   come in series with a fresh instance every 5 minutes.

Live probing of Gamma (2026-07-27) established the upstream mechanics the fix builds on:
`/events/pagination` (offset paging + `hasMore`, `tag_slug`, `series_id`, `end_date_min` —
what polymarket.com's own grid uses), `/series?slug=` (recurring-series metadata), instance
slugs that embed the unix window start (`btc-updown-5m-1785158400`), and instances
**pre-created ~10h ahead with live books**. Two data quirks matter: without `end_date_min`,
series listings return months-old never-closed instances; and the series `recurrence` field
is unreliable (doge-up-or-down-5m reports "daily").

## Decision

1. **The Markets tab is a polymarket.com mirror.** `GET /api/markets/browse` passes through
   `/events/pagination` (active, open, not archived, `volume24hr` desc, optional `tag`) with
   a per-page 20s cache, single-inflight, stale-on-error ≤5 min (`degraded: true`), and a
   60/min per-IP rate limit. The page (`apps/web/app/markets/page.tsx`) gets a hero search
   bar (`/` shortcut), curated category chips (`apps/web/lib/browse.ts`, deep-linked via
   `?tag=`), and infinite scroll — the repo's first `useInfiniteQuery` +
   `IntersectionObserver` sentinel, with a manual "Load more" fallback and page-1-only
   polling (a v5 infinite-query refetch replays every page). The ranked feed (ADR-0007/0012)
   is **not** deleted — it still powers the home surface (`AutomateNow`).
2. **Search hygiene at read time** (`apps/api/src/lib/search-hygiene.ts`) — see the ADR-0015
   amendment. Ended series instances are dropped, each series collapses to its most tradable
   window, dead one-offs are rank-penalized. DTOs now carry `seriesSlug`/`recurrence`/
   `startDate` end to end.
3. **Instant markets are a first-class surface.** `GET /api/markets/instant`
   (`apps/api/src/lib/instant-markets.ts`) serves a curated series list (BTC/ETH/SOL/XRP/DOGE
   × 5m/15m + BTC hourly; curation in code, cadence authoritative over Gamma's unreliable
   `recurrence`) with the live window and next 2 future windows each, resolved via
   `series_id` + mandatory `end_date_min` + `order=endDate asc`. One shared cache entry,
   15s TTL, stale-on-error 2 min. The builder gets an **Instant Markets rail** (idle content
   of the picker; countdowns tick client-side, rollover invalidates the query) and a
   **pinned series card** on crypto-asset queries — both bind through the same
   `MarketSearchHit` payload as normal search results.
4. **Instant strategies die with their window.** Binding a recurring instance carries
   `endDate`/`seriesSlug`/`recurrence` into `MarketMeta`, and `tightenedExpiry`
   (`apps/web/lib/strategies/doc.ts`) defaults the strategy's `expiresAtMs` to the window
   end — only ever tightening, never loosening a user-set value. The engine's existing
   `EXPIRED` terminal transition (state-machine-v2:183) makes this a real stop, which
   mitigates (not fixes) the known "resolved markets only ever go DATA_STALE" gap for the
   markets where it bites hardest.

## Block C seam (deferred)

Auto-rolling `SeriesRef` ("always enter the freshest BTC-5m window under 60¢") is specced in
the approved plan file and **must not start until the owner approves a full user-path
walkthrough**. The seams left ready: `resolveSeriesWindows` is exported and gamma-injected
(worker reuse), `seriesSlug`/`recurrence` persist in every DTO and in `MarketMeta`, and
deterministic instance slugs make trigger-time resolution one lookup.

## Consequences

- The Markets tab shows exactly what polymarket.com shows, ~12k events deep, at a bounded
  upstream cost (≤1 Gamma call per (tag, page) per 20s; instant ≈12 calls/15s worst case,
  shared across all clients). First knob under load: raise TTLs.
- Offset paging over a live-reordering list can double-serve events across pages — the grid
  dedupes by event id.
- `/events/pagination` and `/series` are undocumented endpoints: schemas are passthrough
  with defensive defaults, parse failures surface as 502s, and contract fixtures pin the
  observed shapes. Drift degrades to stale/empty, not crashes.
- Curation is code: adding an asset or cadence is a one-line change in `CURATED_SERIES`
  (backend) and nothing on the frontend.
