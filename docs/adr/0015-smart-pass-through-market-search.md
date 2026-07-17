# ADR-0015 — Smart pass-through market search

- Status: Built (2026-07-17); powers `GET /api/markets/search` and the AI `search_markets` tool
- Owner decision: AI-first UX pivot approved 2026-07-17 (see DECISIONS D-027)

## Context

Market search was a raw pass-through to Polymarket Gamma `/public-search` capped at 5–8
results: no date parsing, no synonyms, no re-ranking. Everyday queries missed — "Argentina",
"Spain", "Messi scores on 19.07" all returned nothing useful even when matching liquid
markets existed. The same helper serves three funnels at once: the builder's @-mention
dropdown, the public search route, and the AI generation loop's `search_markets` tool
(ADR-0011 §1) — so search quality bounds the entire draft-first experience (ADR-0016): a
draft bound to the wrong market is worse than no draft. The structural question: keep Gamma
as the live source of truth and get smarter around it, or sync markets into a local index
(Postgres FTS/trigram) and search locally.

## Decision

1. **Smart pass-through, not a local index.** Query understanding + bounded fan-out + local
   re-rank layered over Gamma `/public-search`. No sync job, no new table, no freshness
   problem — Gamma stays the single source of truth and results are always live. The local
   index remains a deferred follow-up option (see Alternatives), not a rejection.
2. **Pure query understanding** (`apps/api/src/lib/query-understanding.ts`, shared by the
   route and the AI tool). `understandQuery(raw, nowMs)` strips filler, parses dates
   (`19.07`, `July 19`, `today`/`tomorrow`; year-rollover safe) into a ±36h window matched
   against hit `endDate` (date tokens are removed from the text queries), and applies a
   static synonym/entity table (`scores→goals`, `wc→fifa world cup`, country/team aliases,
   `cs2→counter-strike`) producing ≤2 extra fan-out queries. Pure and deterministic —
   unit-testable without Gamma.
3. **Deterministic local re-rank.** `rankHits(hits, uq)` scores
   `3·lexicalOverlap + 2·dateFit + log10(liquidity+volume)/10` and dedupes by conditionId.
   Ranking preferences live in one pure function instead of trusting Gamma's ordering.
4. **Bounded fan-out with a widening retry and a TTL cache.**
   `smartSearchMarketHits(gamma, q, {limit, maxFanOut})` in
   `apps/api/src/lib/market-search.ts` runs the ≤3 fan-out queries in parallel
   (`searchMarkets(query, 20)` each), flattens through the existing `hitFromGammaMarket`,
   retries once with `status: "any"` when hits < 3 (catches recently-resolved or
   not-yet-active markets), re-ranks, slices. A module-level TTL cache (30s, max 200 keys,
   single-inflight — the `showcases.ts` pattern) absorbs repeat and concurrent queries.
5. **Gamma client change.** `searchMarkets(query, limit, opts?: {status?: "active"|"any"})`
   omits `events_status` when `"any"`; default behavior unchanged.
6. **Rate-limit budget.** ≤4 Gamma calls per uncached search (3 fan-out + 1 widening
   retry); ≤12 per AI generation (`MAX_SEARCHES` stays 4, `maxFanOut: 2` → ≤3 calls per
   search round). Mitigations: the 30s cache, a 250ms client-side debounce
   (`use-debounced-value.ts` inside `useMarketSearch`), and the hard fan-out caps. First
   knob if Gamma 429s appear: fan-out→1 (degrades to roughly the old behavior plus
   re-rank). Per-IP route limits are unchanged (R-020); the new amplification risk is
   R-034.
7. **Consumer limits raised where the quality now supports it.** The public route serves 15
   hits (was 8); the AI tool presents 8 hits per query (was 5); the web dropdown shows 8
   (was 5) and the @-mention regex accepts internal spaces ("@world cup"), ending mention
   mode on Escape / pick / double-space.

## Alternatives considered

- **Local market index (sync Gamma into Postgres, FTS/trigram search):** deferred, not
  rejected. Best ranking control and zero per-search upstream load, but it buys a sync
  worker, a staleness problem on a fast-moving catalog, and a new table for a beta-scale
  product — the smart pass-through's query understanding and re-rank are reusable as-is on
  top of a local index later, so nothing built here is throwaway.
- **Raising raw pass-through limits only:** rejected — more of the same wrong results;
  none of the observed misses were limit problems.
- **LLM query rewriting:** rejected — adds latency and spend to every keystroke-driven
  search; the failure modes observed (dates, synonyms, aliases) are static and
  deterministic, so a table beats a model here.

## Consequences

- One search implementation serves the builder dropdown, the public route, and the AI tool
  — quality fixes land in all three funnels at once, and `understandQuery`/`rankHits` are
  pure functions with deterministic tests.
- Uncached search cost rises from 1 to ≤4 Gamma calls (≤12 per AI generation). The cache,
  debounce, and caps bound it (R-034); the fan-out knob is the documented first response to
  429s.
- The 30s cache is in-memory and single-process by design (D-001) — same posture as the
  rate limiter; revisit with any multi-instance deployment.
- If beta search volume or quality pressure outgrows the pass-through, the local index
  follow-up inherits the query-understanding and re-rank layers unchanged.
