# ADR-0011 — AI natural-language strategy generation ("vibe-trading" onboarding)

- Status: Built (2026-07-10); enabled per-environment behind `FEATURE_AI_CHAT` (fail-closed)
- Owner decision: growth/onboarding brief approved 2026-07-10 (see DECISIONS D-021)

## Context

The Smart Orders builder (ADR-0010) already gives anonymous visitors a public playground —
build, bind live markets, and see a live "would trigger now?" verdict without an account.
But the first-touch experience still required understanding the builder. The owner wants a
Lovable/Gamma-class wow: type a trading idea in plain words, watch the canvas assemble
itself from live market data, see an instant PnL projection, and be pulled toward sign-in
and deposit. That requires (a) an LLM turning free text into a `StrategyDefinition`, (b) a
forward-looking payoff/backtest estimate (everything before this was backward-looking), and
(c) removing the funnel wall where unknown wallets hit `NOT_ALLOWLISTED` at the moment of
highest intent.

## Decision

1. **NL→DSL is a bounded server-side tool loop, not freeform generation.**
   `POST /api/ai/generate-strategy` (public, flag-gated) runs a manual Anthropic tool-use
   loop (`apps/api/src/ai/generate.ts`): the model may call `search_markets` (executed
   server-side via the same `searchMarketHits` helper the builder search uses) and must
   finish with exactly one `create_strategy` or `clarify`. Hard caps: ≤ 6 model calls,
   ≤ 4 searches, ≤ 1 validation-repair round, `max_tokens` 4096.
2. **Strict, bounded tool schemas.** All tools use `strict: true`; the expression tree is a
   bounded unrolling (root → optional sub-group → conditions) matching
   `EXPR_LIMITS.maxDepth = 3`, because strict schemas forbid recursion. Conditions are one
   flattened nullable-field shape re-discriminated by zod server-side.
3. **The model never sees market ids.** Search results are presented as indexed candidates
   (title, outcomes, current prices, liquidity, rewards params) WITHOUT
   conditionId/tokenIds. The model references candidates by index (or, when refining, by a
   tokenId already present in the user's own current definition); the server binds real
   `MarketRef`s from its candidate cache. A fabricated id can never bind.
4. **Server-forced safety fields.** Generated orders are ALWAYS
   `execution: "prepare"` / `orderType: "GTC"`, `limits: null`, `templateId: "ai"`; the AI
   cannot emit auto-execution, stop_strategy, or spend limits. Repeat recurrence is coerced
   to `once` for order actions (validator invariant) with a user-visible warning. The final
   definition passes the same `validateStrategyDefinition` the create route uses; one
   repair round-trip returns issue codes to the model before failing.
5. **Model + config.** `claude-sonnet-5` by default (latency/cost fit for a public wow
   path), overridable via `AI_MODEL`. `FEATURE_AI_CHAT=true` without `ANTHROPIC_API_KEY`
   refuses to boot (`packages/config`). The system prompt is byte-stable (prompt-cached,
   `cache_control: ephemeral`) with the current time last; few-shots mirror the three
   builder templates.
6. **Stateless conversation.** The client (AiPanel) holds ≤ 6 compact turns and re-sends
   them plus the compiled current definition; iterating ("make it $200") regenerates the
   whole definition. No chat storage server-side; audit records metadata only (no prompt
   text): `ai.strategy_generated` with model, turn count, market/action kind.
7. **Instant PnL = deterministic estimates, not predictions.** Client-pure
   `projection.ts` (binary payoff math; order size is SHARES; hypothetical $100 stake for
   alert-only strategies) + `backtest.ts` (trigger simulation over CLOB trade-price
   history, price/time_window conditions on ONE market only, continuity-gap guard,
   recurrence semantics) rendered in `ProjectionCard` with MakerEstimator-style
   "estimates, not a promise / past ≠ future" copy. New PUBLIC
   `GET /api/markets/prices-history?tokenId=` (rate-limited 60/min) serves token-keyed
   history.
8. **Open beta.** Behind `FEATURE_OPEN_BETA`, a VALID EIP-712 sign-in auto-inserts the
   wallet into the allowlist (`system:open-beta`, audited `allowlist.auto_added`). The
   allowlist table stays the source of truth; per-wallet revocation still works; all
   real-money flags are untouched.

## Security and cost controls

- **Prompt injection surface:** market titles/descriptions from Gamma are embedded in tool
  results. Mitigations: an explicit untrusted-data instruction, ids withheld from the
  model, server-side binding + validation, and the hard `execution:"prepare"` cap — worst
  case is a bad _draft_ the user still has to review and sign. (R-024)
- **Cost/abuse:** per-IP `ai-burst` 5/min + `ai-daily` 15/day rate limits sit BEFORE any
  model work; loop caps bound the per-request spend; 503 fail-closed when disabled. (R-022)
- **Compliance framing:** projections/backtests are estimates with hard disclaimers; the
  prompt forbids profit promises. (R-023)
- **StrictMode regression:** the panel's auto-fire is deferred out of the mount effect via
  a cleaned-up timer — mutating synchronously in the mount effect loses the settle
  notification under React StrictMode (regression-tested in `AiPanel.test.tsx`).

## Consequences

- The wow path is one vertical slice: hero prompt → `?prompt=` deep link → AiPanel →
  canvas reveal → live verdict → projection → save (sign-in, auto-allowlist) → `/wallet`.
- Rollback = flip `FEATURE_AI_CHAT=false` (hero degrades to the pre-AI design
  automatically, endpoint 503s) and/or `FEATURE_OPEN_BETA=false`; no migrations to revert.
- The in-memory rate limiter remains single-process (D-001); revisit with any
  multi-instance deployment. Anthropic spend should be watched in the console during beta.

## Amendments

- **Amended 2026-07-17 — `create_strategy` is no longer strict** (supersedes decision §2's
  "All tools use `strict: true`"). Verified live: the flattened nullable condition shape
  now carries 21 union-typed parameters (19 pre-trailing) and Anthropic's strict-mode
  grammar compilation caps at 16 unions, so strict compilation 400s — non-strict since
  commit `a6ebac7`. `search_markets` and `clarify` stay strict; the `create_strategy`
  safety net is unchanged in kind: zod mirror parse + one repair round +
  `validateStrategyDefinition` still gate every generated definition.
- **Amended 2026-07-17 — draft-first supersedes clarify-co-equal** (ADR-0016, D-027).
  Decision §1's "must finish with exactly one `create_strategy` or `clarify`" still holds
  mechanically, but `clarify` is no longer a co-equal terminal: any plausible trading
  intent must end in a `create_strategy` draft with assumptions/follow-ups riding along in
  the new optional `open_questions` field; `clarify` is reserved for gibberish/empty/
  non-prediction-market input.
