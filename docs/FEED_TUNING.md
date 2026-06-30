# Feed Ranking and Manual Tuning

Last updated: 2026-06-30

This document explains how the home feed is organized and how to tune it manually without
touching trading, signing, Privy, or conditional-execution code.

## Current home layout

The home page has three discovery columns:

1. `Now`
   - Goal: markets worth checking immediately.
   - Bias: fresh activity, near resolution, tight books, and non-extreme odds.
   - Examples: crypto up/down, active sports matches, high-attention political/geopolitical
     markets with real 24h activity.

2. `Top Markets`
   - Goal: strongest overall attention and tradeability.
   - Bias: weekly volume, liquidity, competitive books, and non-extreme probabilities.
   - Examples: major elections, geopolitical outcomes, crypto macro, large sports outrights.

3. `Favorites`
   - Signed out: shows suggested high-signal markets and asks the user to sign in so they can
     save a watchlist.
   - Signed in before favorites persistence exists: still shows suggested high-signal picks.
   - Future: replace suggestions with persisted user favorites, sorted by freshness and urgency.

## Current implementation

Backend:

- Route: `GET /api/feed/home`
- Single feed route: `GET /api/feed?kind=now|top|suggestedFavorites`
- Ranking code: `apps/api/src/feed/ranking.ts`
- Route code: `apps/api/src/routes/feed.ts`

Frontend:

- Home page: `apps/web/app/page.tsx`
- Feed hook: `apps/web/lib/queries.ts` (`useHomeFeed`)
- Market selection helper: `apps/web/lib/feeds.ts` (`primaryMarket`)
- Row UI: `apps/web/components/MarketFeedRow.tsx`
- Favorites login prompt: `apps/web/components/FavoritesFeedColumn.tsx`

Tests:

- Ranking tests: `apps/api/src/feed/ranking.test.ts`
- Frontend selected-market regression: `apps/web/lib/feeds.test.tsx`

## Inferred Polymarket approach

This is an inference from public docs and live public API behavior on 2026-06-30, not a claim
about Polymarket's private code.

Polymarket appears to combine:

- Broad Gamma candidate pools from `/events` and `/markets`.
- Sorts such as `volume_24hr`, `liquidity`, `start_date`, `end_date`, and `competitive`.
- Editorial or platform signals such as `featured`.
- Market-maker/reward quality signals such as `competitive` and reward-related fields.
- Category and tag surfaces rather than one universal ranking only.

The useful part for us is `competitive`: it tends to surface markets with tight, tradable books.
The dangerous part is that raw Polymarket-like sorting can still surface:

- 99/1 or 1/99 tail outcomes.
- Past-end or nearly-end markets still marked active upstream.
- Very far-dated markets.
- New markets with little liquidity.
- Many markets from the same event cluster.

Our feed uses Polymarket-like candidate sources, then applies stricter quality gates and
deduplication.

Primary source references:

- https://docs.polymarket.com/market-data/fetching-markets
- https://docs.polymarket.com/api-reference/events/list-events
- https://docs.polymarket.com/api-reference/markets/list-markets
- https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination

## Candidate sources

`/api/feed/home` currently fetches several Gamma event pools:

- `order=competitive&ascending=false`
- `order=volume_24hr&ascending=false`
- `order=liquidity&ascending=false`
- `order=start_date&ascending=false`
- `order=end_date&ascending=true`

The route dedupes by event id, scores each market inside each event, selects the best market per
event, and then builds the three columns.

## Hard filters

A market cannot enter the feed unless it passes these gates:

- Event and market are active.
- Event and market are not closed or archived.
- Market is not explicitly `acceptingOrders=false`.
- Market has CLOB token ids.
- Both best bid and best ask exist and form a sane spread.
- Probability midpoint is between `minProbability` and `maxProbability`.
- Spread is no wider than `maxSpread`.
- Resolution is at least `minResolveHours` away.
- Normal horizon is no farther than `maxResolveDays`.
- Long-horizon exception applies only outside `Now`, and only for highly liquid or high-volume
  markets.
- Liquidity or 24h volume clears the baseline.
- Just-spawned markets need stronger early liquidity or 24h volume.

These gates are intentionally conservative. They are why 99/1 odds, dead end-date rows, and
no-liquidity launches disappear.

`restricted=true` is not used as a read-only discovery filter. Many public Gamma markets carry this
flag for the current environment; the approved project posture is read-only discovery globally, with
trading and execution controls enforced separately by the geoblock/trading layer.

## Default tuning values

Defaults live in `DEFAULT_FEED_TUNING` inside `apps/api/src/feed/ranking.ts`.

| Knob                        | Default | Meaning                                              |
| --------------------------- | ------: | ---------------------------------------------------- |
| `limit`                     |      20 | Max cards per feed column                            |
| `minLiquidity`              |    2000 | Baseline order-book liquidity gate                   |
| `minVolume24h`              |    1000 | Baseline 24h activity gate                           |
| `newbornHours`              |     0.5 | Age under which a market is treated as newly spawned |
| `newbornMinLiquidity`       |   10000 | Liquidity required for newborn markets               |
| `newbornMinVolume24h`       |    2000 | 24h volume required for newborn markets              |
| `minResolveHours`           |       2 | Removes nearly-ended markets                         |
| `maxResolveDays`            |     365 | Normal max horizon                                   |
| `longHorizonMaxResolveDays` |     920 | Max horizon for major non-Now exceptions             |
| `longHorizonMinLiquidity`   |  500000 | Liquidity required for long-horizon exception        |
| `longHorizonMinVolume1wk`   |  250000 | Weekly volume required for long-horizon exception    |
| `minProbability`            |    0.03 | Removes 1-cent tails                                 |
| `maxProbability`            |    0.97 | Removes 99-cent near-certainties                     |
| `maxSpread`                 |    0.10 | Rejects ugly/wide books                              |
| `goodSpread`                |    0.03 | Score boost threshold for tight books                |
| `maxPerPrimaryTag`          |       6 | Diversity cap per primary tag                        |

## Quick manual experiments

You can tune the feed without editing code by passing query params to the backend route.

Examples:

```bash
# Stricter probabilities: remove more tail outcomes.
curl "http://localhost:3001/api/feed/home?minProbability=0.05&maxProbability=0.95"

# More liquid, fewer low-quality rows.
curl "http://localhost:3001/api/feed/home?minLiquidity=10000&minVolume24h=2500"

# More urgent Now feed, less long-horizon content.
curl "http://localhost:3001/api/feed/home?maxResolveDays=90&minResolveHours=6"

# Looser discovery for testing, not recommended for beta defaults.
curl "http://localhost:3001/api/feed/home?minLiquidity=500&minVolume24h=250&maxSpread=0.15"

# Inspect one column only.
curl "http://localhost:3001/api/feed?kind=now&limit=10"
```

The response includes:

- `tuning`: the effective values after defaults and query overrides.
- `candidateCount`: deduped upstream event count.
- Per-feed `candidateCount` and `rejectedCount`.
- Per-event `_feed` metadata:
  - `score`
  - `selectedMarketId`
  - `reasons`
  - `metrics`

The `_feed.metrics` block is the best debugging surface. Use it to answer "why is this here?"
or "why did this not appear?"

## How to tune safely

Use this loop:

1. Start with query-param experiments against local API.
2. Compare 20 to 50 returned cards manually in the browser.
3. Look for failure patterns:
   - too many 1-cent outcomes: raise `minProbability`, lower `maxProbability`;
   - too many dead markets: raise `minResolveHours`;
   - too many low-quality launches: raise `newbornMinLiquidity` or `newbornMinVolume24h`;
   - too many far-dated markets: lower `maxResolveDays` or raise long-horizon thresholds;
   - too much one category: lower `maxPerPrimaryTag`;
   - too few markets: lower `minLiquidity` or `minVolume24h` carefully.
4. Once values feel right, update `DEFAULT_FEED_TUNING`.
5. Run:

```bash
pnpm test apps/api/src/feed/ranking.test.ts apps/web/lib/feeds.test.tsx
pnpm --filter @mx2/web run typecheck
pnpm run typecheck
```

6. Record the product reason if the change meaningfully alters discovery behavior.

## Column-specific behavior

`Now` scoring favors:

- 24h activity.
- Time-to-resolution, peaking after the nearly-ended danger window.
- Newness with traction.
- Liquidity and tight spread.
- Polymarket-like `competitive`/`featured` signals.

`Top Markets` scoring favors:

- 7d activity.
- Liquidity.
- 24h activity.
- Non-extreme, interesting odds.
- Polymarket-like `competitive`/`featured` signals.

`Favorites` suggestions blend:

- Top-market strength.
- Recent activity.
- Enough urgency to avoid feeling stale.

## Product guardrails

- Do not tune the feed to imply investment advice or guaranteed profit.
- Do not use user-specific private data in the public suggested feed.
- Do not weaken trading geoblock or execution gates while tuning discovery.
- Do not add P1 news aggregation or smart-feed claims without a separate decision.
- Keep ranking deterministic and documented. Feed behavior is part of MVP acceptance.

## Known limitations

- Candidate quality depends on Gamma fields that can drift.
- Tags are only a soft diversity tool, not a full taxonomy.
- The current Favorites column is still suggested content until favorites persistence is built.
- The feed does not yet use live order-book depth beyond Gamma top-of-book fields.
- The feed does not yet use external news, social velocity, wallet flow, or trader quality.
