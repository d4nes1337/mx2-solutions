# ADR-0016 — AI-first home & draft-first generation

- Status: Built (2026-07-17) behind the existing `FEATURE_AI_CHAT`; no new flags
- Owner decision: AI-first UX pivot approved 2026-07-17 (see DECISIONS D-027)

## Context

The core goal is shortening the path from landing to a working strategy on the canvas to
near zero, with AI as the primary building interface. The experience broke at every seam:
the AI treated `clarify` as a co-equal terminal (ADR-0011 few-shot posture) and
interrogated users instead of drafting; a `?prompt=` deep link could land on a canvas that
stayed silently blank when generation clarified or failed; the hero was a plain textarea
with no market awareness; and the home "examples" were data-gated — an empty
`/api/showcases` silently swapped in chartless fallbacks, so the teaching surfaces
vanished exactly when a fresh visitor arrived. The owner's framing: demos carry the
teaching job, proven plays carry proof, and the AI should behave like a confident
assistant that drafts and then asks, not the reverse.

## Decision

1. **Draft-first policy.** The system prompt's tool-protocol step is rewritten: any
   plausible trading intent MUST end in `create_strategy` with sensible defaults (alert
   action, 5-min hold, thresholds anchored to current prices, closest liquid market);
   `clarify` is reserved for gibberish, empty, or non-prediction-market input. An
   imperfect market match binds the closest liquid candidate and says so — assumptions
   and follow-ups ride along with the draft instead of blocking it. This supersedes
   ADR-0011's clarify-co-equal wording (amendment recorded there). The prompt edit is a
   one-time prompt-cache invalidation, accepted (R-036); the file is byte-stable again
   after.
2. **The `open_questions` contract.** `CREATE_STRATEGY_TOOL` gains an optional
   `open_questions: string[]` (≤3 items, ≤200 chars each; the tool is non-strict since
   `a6ebac7`, so an optional field is safe for old few-shots) with a zod mirror defaulting
   to `[]`. `GenerateResult`'s ok-variant carries `openQuestions` through the route to the
   client; assistant bubbles render them as tappable chips that prefill the composer — the
   existing history + currentDefinition refinement loop answers them. Questions are
   advisory text, never ids or bindings: the server-side binding rules of ADR-0011 §3 are
   untouched.
3. **The canvas is never silently blank.** The builder store gains
   `aiStatus: "idle" | "drafting" | "error"`; an empty doc shows a drafting spinner or a
   "draft failed — see the AI panel" overlay. A `?prompt=` deep link always activates the
   AI tab (the module-level store can survive navigation with a stale tab). Failures keep
   the last prompt and render Retry beside the template chips.
4. **Home hero = the AI chat, for real.** `HeroChat` replaces the plain textarea: autogrow
   composer, @-mention market search with pinned chips (machinery extracted from AiPanel
   into a shared hook, behavior-identical), submit deep-links
   `/smart-orders/new?prompt=…&pinned=…` so pinned conditionIds survive the handoff and
   seed pre-verified candidates before auto-fire.
5. **Hero demo player: curated scenarios, live binding, honest fallback.** Five curated
   scenarios (news-momentum cross-market, maker range farming, trailing-stop protection,
   live-match dip-buy, confirmed threshold entry — each mapping to an existing template)
   auto-type into the chat while the strategy preview (diagram chips + chart + markers)
   builds alongside. One state machine (`use-demo-player.ts`: `{idx, phase, chars}`, a
   single interval) drives text, chips, chart markers, and carousel dots — synchronization
   is structural, not coordinated. At render each scenario binds a live market via smart
   search (ADR-0015): real title, real price series. When binding fails, a deterministic
   seeded synthetic series renders with an explicit "illustrative" caption — the honesty
   bar: **synthetic data is always labeled, live data is always attributed** (extends
   R-023; risk R-035). Hover/typing pauses; `prefers-reduced-motion` gets a static
   fully-revealed scenario.
6. **Discovery section: proof beside action.** Two columns replace ShowcaseGallery +
   HotMarkets. Left, **"Proven plays"**: the backtested showcase carousel (real PnL entry
   markers, hypothetical-results disclaimer kept on every card); an empty `/api/showcases`
   now renders three curated sample cards captioned "Sample plays — live backtests refresh
   every 15 min" instead of silently degrading to a chartless gallery — charts never
   vanish. Right, **"Automate these markets now"**: top live-feed markets, each with a
   best-fit strategy suggestion from deterministic heuristics (mid 0.35–0.65 → dip-buy;
   mid > 0.75 → trailing-stop protect; high 24h volume → momentum alert; else threshold
   entry) and a one-click Build that deep-links a drafting canvas — the draft-first policy
   is what makes one click reliable.

## Alternatives considered

- **Clarify-first / co-equal (status quo):** rejected — over-asking is the observed
  failure; a reviewable draft with questions attached beats an interrogation, and every
  generated order is still hard-forced `execution:"prepare"` (ADR-0011 §4), so a wrong
  assumption costs one glance, not money.
- **Fully synthetic hero demos (no live binding):** rejected — canned charts undercut the
  "live market data" claim the product makes everywhere else; live-first with a labeled
  fallback keeps the wow honest.
- **Free-running LLM demo (generate live on the homepage):** rejected — spend and latency
  on every visit for content that must be reliable on the first paint; curated scenarios
  with live binding get the freshness without the cost.
- **Keep the teaching column (templates) instead of suggestions:** rejected by owner —
  the hero demos carry the teaching job; showing already-worked strategies beside
  actionable suggestions is the stronger pairing.

## Consequences

- The funnel is now: watch a scenario type itself → type your own idea with @-mentions →
  land on a canvas that visibly drafts → answer open-question chips to refine. No step
  can strand the user on a blank canvas.
- `open_questions` is additive and optional — old few-shots and stored conversations stay
  valid; no `packages/rules` changes.
- The home page takes a hard dependency on smart search (ADR-0015) for scenario binding;
  its failure mode is the labeled synthetic fallback, not a broken hero.
- All AI safety invariants are unchanged: prepare-only orders, index-based binding, loop
  caps, per-IP limits (R-022), prompt-injection posture (R-024).
- Rollback: `FEATURE_AI_CHAT=false` still degrades the hero to the pre-AI design; the
  discovery section and demo player are flag-independent UI and revert with the code.
