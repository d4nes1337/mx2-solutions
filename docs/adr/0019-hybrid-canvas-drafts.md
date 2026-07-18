# ADR-0019: Hybrid Canvas Drafts (Local-First + Account Sync)

Date: 2026-07-18

Status: Built

## Context

The builder held a single in-memory zustand doc; every entry point (homepage template chips,
`?template=`/`?prompt=`/`?showcase=` deep links, AI generations) called an unguarded `reset()`,
silently destroying in-progress work — the owner hit this in production use. The AI chat lived in
component-local state, so "new strategy" resets kept replaying old conversations into new
generations.

## Decision

- Every canvas belongs to exactly one **draft**. Entry points `spawnDraft(...)` instead of
  resetting: the outgoing draft is flushed to localStorage first, so nothing can overwrite work.
  A pristine (never-edited) spawn is replaced in place so cycling presets doesn't spray drafts.
  URLs canonicalize to `/smart-orders/new?draft=<id>`.
- **Local-first**: debounced (500ms) autosave to localStorage (`mx2.drafts.v1` index + per-draft
  records, 30-draft LRU, schemaVersion guard). Persistence is gated on user work (edits or an AI
  conversation) so untouched preset spawns don't clutter the list.
- **Per-draft AI chat**: the display log and API history live in the store, scoped to the draft —
  switching drafts switches chats; a fresh draft always starts clean. The first AI turn over
  hand-edited work forks into a new draft (the manual version survives), later turns iterate in
  place.
- **Account sync**: a separate `strategy_drafts` table stores the free-form StrategyDoc + chat,
  keyed by the client draft id, merged last-write-wins on the client updatedAt clock (single-user
  tradeoff). Deliberately NOT `conditional_rules` rows: drafts mutate per keystroke and may not
  compile, while armed definitions are immutable (D-020) and worker-visible. Fail-soft: signed-out
  or offline means local-only, never a broken builder.
- Save & arm marks the draft consumed (tombstone linked to the created rule) locally and
  server-side.

## Consequences

Presets/AI/deep links can no longer destroy work; drafts follow the account across devices; the
"AI remembers old chats" defect is structurally impossible (chat is draft state). localStorage
eviction (private browsing) degrades to server-synced copies for signed-in users. No new feature
flag: the surface is already default-on and moves no money.
