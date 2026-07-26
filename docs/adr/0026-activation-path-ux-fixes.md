# ADR-0026 — Activation-path UX fixes

- **Status:** Accepted (owner-approved plan, 2026-07-23; Slice 5 of the private-beta release brief)
- **Date:** 2026-07-23
- **Decision id:** D-049

## Context

Brief §8 asks for comprehension fixes on the first-time activation path — NOT a redesign of the
already-built dashboard. The Slice 0 audit confirmed several concrete defects: a user saying
"$200" silently became a 200-SHARE order; the AI order price fell back to `0`; a manually-bound
order kept a static 50¢ default; the homepage hero swapped its whole message post-hydration; and
the public draft path overflowed horizontally on mobile.

## Decision

1. **AI dollars-vs-shares (brief §8.1.1).** The `create_strategy` action gains an optional
   `budgetUsd` (mutually exclusive with `size`). The server converts a budget to shares at the
   candidate's FRESH price (`size = round(budgetUsd / price)`) and surfaces the assumption as a
   warning shown with the draft ("Interpreted $200 as N shares at Yc — edit the size if you meant a
   share count"). Prompt + tool guidance rewritten; the zod mirror defaults `budgetUsd` to null so
   existing few-shots stay valid.
2. **Order price anchored to fresh market context (brief §8.1.5).** The AI order price no longer
   falls back to `0` — a missing price anchors to the candidate's current price (clamped to the
   tick band), only defaulting to 50¢ with a labeled warning when no fresh price exists. In the
   builder, binding a market to an order action snaps the limit to the picked outcome's current
   price (threaded through `MarketMeta.currentPrice`) instead of the static default.
3. **Hero stability (brief §8.1.2).** The hero treats the flags-loading state as AI-on (the beta
   default) so the first paint already matches the resolved value — no post-hydration message swap
   or layout shift in the private-beta configuration.
4. **Three clear entry paths + Start blank (brief §8.1.6/7).** The hero shows three creation paths
   — describe (the AI composer), "start from a template", and a new "start blank". `?start=blank`
   opens an EMPTY canvas the user builds up market → condition → action → execution via the
   Add-a-block palette, rather than a pre-filled template. The advanced canvas stays desktop-first;
   the 4-market cap is unchanged.
5. **Mobile horizontal overflow (brief §8.1.3).** Fixed the grid `min-width:auto` blowout on the
   homepage (chart column) and clipped the desktop-first React Flow canvas viewport; the builder's
   template-chip row scrolls horizontally and the workspace tab bar truncates — the public
   draft/homepage paths now have zero horizontal page scroll at 375px.
6. **One honest example (brief §8.1.10)** is already served by the existing "Proven plays"
   backtested showcases (hypothetical-results disclaimers per R-023/R-035) with a Build CTA — no
   new surface needed.

## Deferred (scoped follow-up)

- **Unified market-availability resolver (brief §8.1.4).** Removing every contradictory
  availability/geoblock/lifecycle state in the market cockpit is a cross-component reconciliation
  (Banners, OrderTicket, AUTO badges, book-unavailable copy) that is safer as its own focused
  change than folded in near the end of this slice. The Action Center (Slice 4) already uses the
  brief's honest vocabulary; this item is tracked for a follow-up. No correctness risk — the
  states are individually honest; the gap is only that two can appear at once.

## Consequences

- A "$200" request produces a dollar-correct draft with a visible assumption; manually-built and
  AI-built orders both anchor to fresh prices; the homepage no longer flickers; and the first-time
  mobile draft path does not overflow. Behavioral/UI only — no schema change, no new flag; rollback
  = revert the commits.

## Verification (2026-07-23, local)

Unit: AI budget→shares conversion (417 shares at 48¢ from "$200", assumption warning) + missing-
price anchoring (0.48 not 0); builder store price-anchoring on bind (snap + clamp + no-price
no-op). Browser (mobile 375px): homepage and the public draft/builder path have zero horizontal
overflow (docWidth == clientWidth); `?start=blank` opens an empty "add a condition to begin"
canvas; the desktop homepage renders the stable AI hero with all three entry paths and no
post-hydration swap. Suites: 771 root + 300 web green; typecheck/lint/format clean.
