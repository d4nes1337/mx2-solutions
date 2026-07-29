# ADR-0029 — AI analyst grounding, guaranteed drafts, and the cost floor

- Status: Built (2026-07-28); amends ADR-0011 (NL→strategy generation) and ADR-0016 (draft-first)
- Owner decisions: model switch, web-search flag, product Q&A and full scope approved 2026-07-28
  (D-051…D-053)

## Context

Owner feedback on the AI builder: it too often failed to produce anything ("can't even build a
strategy"), felt slow (20–60 s blocking call behind fake timer-based progress), and wasn't
"clever" — it saw only market titles and prices, with no volatility, fees, backtests, news, or
product knowledge. Investigation added two technical findings: (a) the generation loop allowed
only ONE validation-repair round before hard-failing with `AI_GENERATION_FAILED`; (b) the system
prompt embedded a millisecond timestamp INSIDE the `cache_control`-marked block, so the Anthropic
prompt cache never hit and every request paid full input price.

## Decision

1. **Guaranteed-draft floor.** A fresh generation must never dead-end for a genuine trading
   prompt. The repair budget is now 2 rounds; when the model still can't produce a valid
   definition (or the upstream dies mid-generation while verified candidates exist),
   `buildFallbackDraft` deterministically emits a minimal valid ALERT strategy anchored to the
   top-ranked candidate's current price, labeled with warnings + openQuestions and
   `fallback: true` in the audit metadata. **Refinement turns never take this path** — replacing
   a user's existing strategy with a minimal alert would destroy their work; they get a `clarify`
   instead. `AI_GENERATION_FAILED` is unreachable for real prompts; `AI_UPSTREAM` remains only
   for candidate-less outages.
2. **Pre-search seeding.** On fresh prompts (no pins, no history, no currentDefinition) the
   server runs the smart market search on the raw prompt BEFORE the first model call and seeds
   the results as pre-verified candidates (same id-withholding presentation as pins). The common
   path is now ONE model call instead of a search round-trip. A seed counts against the search
   budget, keeping ADR-0015 §6's ≤12 Gamma calls/generation ceiling; the seeded call cap is 5.
3. **Prompt-cache fix + Haiku default.** The system prompt is split into a byte-stable cached
   block (core + product guide + few-shots) and an uncached current-time block. `AI_MODEL`
   defaults to `claude-haiku-4-5` ($1/$5 per MTok vs Sonnet 5's $3/$15); the effort parameter is
   gated off for Haiku as before. Sonnet remains one env var away. Combined estimate: 3–6×
   cheaper per generation. Caveat: Haiku's minimum cacheable prefix is 4096 tokens — verify
   `usage.cache_read_input_tokens` once in staging; if the prefix is under the floor, accept it
   (Haiku input is cheap), don't pad.
4. **Analyst grounding, native tools — not MCP.** MCP is a client-side protocol (desktop
   assistants → tool servers); for a server-side product feature it adds infrastructure for no
   benefit. Instead: a strict `get_market_stats` tool (≤3 calls/generation) returns book,
   7-day range, typical movement, 24 h drift, volume/liquidity, fees/rewards (shared 5-min
   economics cache, extracted to `lib/market-economics.ts`) and top-2 backtested scenario
   summaries (shared 15-min scenarios cache). All prices 0–1; ids stay withheld; every section
   best-effort.
5. **Hosted web search behind `FEATURE_AI_WEB_SEARCH` (default off).** Anthropic's server-side
   web_search tool (`web_search_20250305` on Haiku, `web_search_20260209` on Sonnet/Opus tiers),
   `max_uses: 3`. Cost ceiling ≈ $0.03/generation on top of tokens; bounded by the 15/day/IP
   limit. The loop resumes `pause_turn` turns; citations are deduped (≤5) and returned as
   `sources` on ok/clarify results, rendered as a Sources row in the panel. Prompt rule: web
   facts only for time-sensitive external context, never prices.
6. **Product Q&A.** A `## Product guide` section (true-to-shipped-features; includes the
   referral/waitlist/invite reality) lives in the cached block, and a strict `answer_user` tool
   answers product questions over the clarify wire shape (zero client changes). The clarify tool
   is now reserved for gibberish/off-topic.
7. **Real progress over SSE.** `POST /api/ai/generate-strategy/stream` emits `stage` events
   (searching/drafting/analyzing/researching/repairing) plus one terminal `result`/`error`
   event; it shares the exact rate-limit scopes with the JSON route (one budget; a fallback
   retry costs 2 daily units — accepted). The client falls back to the JSON route whenever the
   response isn't `text/event-stream` (buffering proxy) and the panel's timer theater survives
   only as that fallback's cosmetic. Client disconnect aborts the generation between model calls
   (`GenerateAborted`), unwritten and unaudited.
8. **`AI_BASE_URL` experiment knob (Kimi/Moonshot).** Optional Anthropic-compatible endpoint
   override for a cheaper-model experiment (Kimi K2.5, ~$0.60/$3). Guards: effort omitted when
   set; boot refuses `FEATURE_AI_WEB_SEARCH` + `AI_BASE_URL` together (server tools don't exist
   off-Anthropic); empty string = unset. NOT the default — sending user prompts to a
   China-hosted provider is an owner-level compliance decision, and Moonshot compatibility with
   `cache_control`/strict tools is unverified (smoke test required before any default change).

## Consequences

- Reliability: every genuine prompt yields a draft or a pointed clarify; the fabricated-id
  security property is preserved (the fallback binds only server-verified candidates).
- Cost: cache hits + 1-call happy path + Haiku ≈ 3–6× cheaper per generation; audit rows now
  carry `statsCalls`/`webSearches`/`fallback` for observability.
- Latency: typical fresh prompt ≈ one Haiku call after one cached Gamma search; the panel shows
  real stages.
- Risks accepted: SSE through the deployed proxy topology is unverified (mitigated by the
  content-type fallback); Haiku draft quality is mitigated by validation + repair + floor and is
  an env-var rollback; a stream cut after start can cost a second generation on the JSON retry.
- Verification: 31 route tests (`apps/api/src/routes/ai.test.ts`), stats/config/panel suites;
  end-to-end smoke with a real key still owed in staging (cache hit check + SSE pass-through).
