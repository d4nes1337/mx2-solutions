# ADR-0012 — Backtested showcases and the calm market feed

- Status: Built (2026-07-10)
- Owner decision: round-2 growth brief approved 2026-07-10 (see DECISIONS D-022)

## Context

Round-2 owner feedback on the vibe-trading onboarding (ADR-0011): every generic element
("Start from a template", the hardcoded hero mock, abstract copy) must become a REAL
example — a real market, a real backtested number — and the terminal-style market feed
("a bullx terminal inside a light apple app") must become calm and card-based. Also:
@-mention market pinning in the AI panel, projected PnL visible in the cockpit/builder
headline, and Haiku 4.5 as the beta model for cost/speed.

## Decision

1. **Shared simulation core.** The pure trigger backtest moved from the web app into
   `packages/rules/src/simulate.ts` (zero-dep, already shared by web+api) so the server
   and every UI compute identical numbers.
2. **Showcase engine** (`apps/api/src/lib/showcases.ts`, `GET /api/showcases`, public,
   30/min per IP): one Gamma listEvents (volume_24hr) → ≤10 liquid mid-band markets →
   30-day CLOB history each → dip-buy grid (δ ∈ {3,5,8}¢, hold 15 min, $100 stake) via
   the shared simulator → top 6 positive results, 15-min in-memory cache with a
   single-inflight guard and stale-serve on refresh failure. Trigger counts are
   simulated with repeat recurrence (max 5, 6 h cooldown); the emitted ready-to-open
   `StrategyDefinition` is `once` + order/`prepare` (repeat+prepare is invalid by
   design) and passes `validateStrategyDefinition` before it ships.
3. **Real examples everywhere.** Home page: `ShowcaseGallery` (falls back to the
   template gallery), hero right side: `LiveShowcasePreview` (falls back to the static
   mock), hero prompt examples derived from live showcases, market cards carry a
   "dip-buy +$X/30d" teaser, the cockpit gets a `BacktestTeaser` and payoff-if-fills
   numbers inside the trade ticket, and the builder shows "Projected: +$X if Yes wins"
   next to the live verdict. `?showcase=` deep links open the exact definition in the
   builder.
4. **Calm feed.** `/markets` is one responsive card grid (`MarketCard`) with
   Trending/Top/Favorites tabs and a filter box; the activity tape, movers strip and
   3-column terminal layout were removed. Drag-and-drop was evaluated and rejected for
   v1 (cross-route DnD needs a persistent split view, poor on touch, low
   discoverability) — the per-card "Automate →" one-click deep link delivers the same
   outcome.
5. **@-mention pinning.** The AI panel detects `@query` at the caret, searches live
   markets (existing public search), and pins picks as chips. The server re-resolves
   pinned conditionIds via `findMarket` (never trusting client data) and seeds them as
   pre-verified candidates — the model references them by index without a search round
   (faster + cheaper), and still never sees conditionId/tokenIds.
6. **Haiku 4.5 for beta** via `AI_MODEL=claude-haiku-4-5` in production env (code
   default stays `claude-sonnet-5`). The generate loop now gates `output_config.effort`
   off for haiku-tier models (they reject the parameter with a 400).

## Alternatives considered

- Cron-precomputed showcases (worker): more moving parts than a 15-min lazy cache needs
  at beta scale; revisit if the homepage cold-start (first request warms the cache)
  measurably hurts.
- Client-side-only showcases: N markets × history fetches per visitor — wasteful and
  slow; server cache amortizes across all visitors.
- Balanced (wins + losses) showcase selection: rejected by the owner for the growth
  goal; selection bias is disclosed on every surface instead (R-023).

## Consequences

- Upstream load bounded: ≤1 listEvents + ≤10 history fetches per 15 min (R-025).
- The showcase id (`conditionId:deltaCents`) is stable within a cache window but may
  disappear on refresh; the builder falls back to the default template for unknown ids.
- The in-memory cache/limiter remain single-process (D-001).
