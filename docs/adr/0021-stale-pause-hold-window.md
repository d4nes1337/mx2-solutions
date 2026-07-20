# ADR-0021 — Stale data PAUSES the hold window (grace), instead of resetting it

Date: 2026-07-19 · Status: Accepted (owner decision, 2026-07-19 fix-plan Q&A)

## Context

The owner's beta test surfaced the defining reliability failure of conditional
rules: strategies that should have triggered never did, because any market-data
gap longer than `maxDataAgeMs` (default 30 s) **reset** the accumulating hold
window to zero (`DATA_STALE`). On quiet-but-live books — where the CLOB WS
legitimately sends nothing — long windows could never complete. The REST
freshness-verify pass (D-035) mitigated but was bounded to 8 tokens/pass and
gated on WS connectivity, so lag could still outrun it.

## Decision

1. **Pause, don't reset.** While `ACTIVE_ACCUMULATING`, an evaluation that is
   unsatisfied _only because of staleness_ sets `staleSinceMs` (persisted as
   `conditional_rules.stale_since`, migration 0019) and keeps `trueSinceMs`.
   Reason code `STALE_PAUSED` (same-status transition, audited once).
2. **Resume with the gap excised.** If fresh-and-satisfied data returns within
   `staleGraceMs`, the window resumes with `trueSinceMs` shifted forward by the
   stale interval — quiet time NEVER counts toward `holdsForMs`
   (`STALE_RESUMED`). Fresh-but-unsatisfied data still resets immediately.
3. **Grace exhaustion resets.** Past `staleGraceMs` the legacy conservative
   reset lands (`DATA_STALE`). Default grace: `min(2 × maxDataAgeMs, 60 s)`,
   overridable per definition (validated 0–5 min), defaulted at evaluation
   time by `staleGraceMsOf` — stored JSON is never rewritten (D-020 intact).
4. **v1 parity is exact.** `normalizeDefinition` pins `staleGraceMs: 0` for v1
   rules; grace 0 is the strict legacy reset, so the v1↔v2 parity suite
   (transition-for-transition, timestamp-for-timestamp) stays green.
5. **Reconnect is a staleness onset**, not proof the market moved: it pauses
   (grace 0 → legacy `RECONNECT_RESET`). Restart-resume tolerance widens to
   `maxDataAgeMs + staleGraceMs`, and a persisted pause resumes as a pause —
   the grace counts from the ORIGINAL onset across restarts.

## Fail-closed invariant preserved

The trigger still requires **fresh satisfied data at the trigger instant** and
`holdsForMs` of accumulated fresh-satisfied time. What is relaxed is only the
claim "the condition held during a ≤ grace data gap" — bounded, audited
(`STALE_PAUSED`/`STALE_RESUMED` in the strategy timeline), and never an input
to execution: the auto-executor's guard chain is untouched.

## Companion changes (same slice)

- REST verify: per-pass bound 8 → 32 (env `WORKER_REST_REFRESH_MAX`), two-tier
  priority (tokens of mid-dwell rules always fetch first), per-token
  single-flight + 15 s error backoff.
- "Instant" (`holdsForMs: 0`) became the default for NEW strategies (builder
  `emptyDoc` + API schema default) — hold windows are opt-in (owner decision).
