# ADR-0007 - Feed Ranking and Tuning

Date: 2026-06-30
Status: **Accepted (built after owner approval)**
Deciders: Owner (PM/BA), Senior Technical Lead

---

## Context

The MVP brief makes discovery-first feed a P0 requirement. The home page previously used four
columns (`Hottest`, `Volume 7d`, `Latest`, `Favorites`) assembled mostly from raw Gamma API sorts
and lightweight frontend scoring. That created weak product behavior:

- raw liquidity and volume can surface 99/1 tail outcomes;
- some upstream active rows have past or nearly expired end dates;
- newly spawned low-liquidity markets can appear too early;
- multi-market events can show the wrong tail market;
- the Favorites placeholder did not strongly sell the value of signing in.

The owner asked for three columns:

- left: newest + hottest + resolving soon;
- middle: hottest overall markets;
- right: Favorites, with a signed-out login push and high-quality suggestions.

## Decision

Ranking now lives in the backend:

- `GET /api/feed/home` returns all three ranked columns.
- `GET /api/feed?kind=now|top|suggestedFavorites` returns one column for debugging.
- `apps/api/src/feed/ranking.ts` owns gates, scores, diversity, and `_feed` metadata.
- `docs/FEED_TUNING.md` documents the knobs and manual tuning process.

The backend gathers a broad candidate pool from Gamma event sorts that approximate Polymarket's
own public discovery signals:

- `competitive`;
- `volume_24hr`;
- `liquidity`;
- `start_date`;
- `end_date`.

Then the app applies stricter terminal-specific quality gates:

- active/open/tradable metadata;
- CLOB token presence;
- bid and ask present;
- probability not near 0 or 1;
- spread not too wide;
- minimum liquidity or 24h activity;
- no nearly-ended markets;
- no low-traction newborn markets;
- limited long-horizon exceptions;
- one selected market per event;
- diversity cap by primary tag;
- cross-column dedupe on the home screen.

The Gamma `restricted` flag is deliberately not a read-only discovery gate. The project decision
D-004 keeps read-only access global and applies Polymarket geoblock fail-closed only at the
trading/execution layer.

The frontend consumes the ranked response through `useHomeFeed`, renders three columns, and respects
the backend-selected market id so liquid tail outcomes do not override the intended primary market.

## Consequences

- **Positive:** feed behavior is deterministic, tested, and owner-tunable; noisy upstream sorts are
  filtered before they reach the UI; the Favorites column can sell watchlist value before persistence
  is built.
- **Positive:** the route exposes query-param tuning for local/product experiments without changing
  code defaults.
- **Negative:** backend now makes several product ranking choices, so future changes need product
  review when they materially alter discovery behavior.
- **Negative:** the feed still depends on Gamma field quality and does not yet use external news,
  wallet flow, or deeper order-book depth.

## Alternatives considered

- **Keep frontend-only scoring.** Rejected because it made deterministic testing and shared tuning
  difficult, and it let event-level sort quirks leak into the UI.
- **Use raw Polymarket/Gamma sorts directly.** Rejected because live sampling showed too many
  1-cent tails, stale/past-end rows, and duplicated clusters.
- **Build a full smart/news feed now.** Rejected as P1/P2 scope. The P0 feed should use public
  Polymarket market data only, with a clean seam for future news/social/smart-money signals.
