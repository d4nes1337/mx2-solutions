# ADR-0028 — Rolling series bindings (auto-rolling instant markets)

- Status: Built (2026-07-28)
- Owner decisions: approved 2026-07-28 after the mandated user-path walkthrough
  (ADR-0027 gate). Four answers on the record:
  1. only the ORDER TARGET rolls in this version; conditions stay fixed, with the seam left open
  2. ship alert/shadow-first plus manual confirmation that expires with the window; unattended
     auto stays behind its existing flag and a later gate
  3. all-or-nothing per-window outcomes accepted (no exit, settles at resolution)
  4. spend caps stay OPTIONAL, but modeled wins/losses must be shown before saving

## Context

ADR-0027 gave the builder live 5-minute crypto windows, but a strategy bound to one of them
dies with it — five minutes later the market has resolved and the strategy is pointing at a
settled book. The owner's original ask was a strategy that says "enter the most actual BTC
5-minute market on the UP side, if it is still under 60¢" and keeps meaning that tomorrow.

The upstream mechanics make this tractable (verified live 2026-07-27, see ADR-0027): windows
are pre-created hours ahead with open books, instance slugs embed the window's unix start, and
one paginated query returns the live window plus its successors.

## Decision

1. **The binding lives in the definition; the window is resolved at trigger time.**
   `OrderActionV2.rollingSeries?: SeriesRef` is additive — `market` still holds a concrete
   ANCHOR (the window that was live when the strategy was built), so every existing consumer
   (preview, summaries, the denormalized `condition_id`/`token_id` columns, market-existence
   validation) keeps working untouched. The definition is **never rewritten** as windows roll,
   so `definition_hash` stays stable and D-020 immutability holds without superseding churn.
   Rejected alternative: rewriting the definition every window — it would mint a new strategy
   version every five minutes and break the evidence-to-definition hash tie.
2. **Execution reads the trigger, never the definition.** The worker resolves the window, runs
   the guards, and writes a concrete order into `evidence.preparedAction`; the anchor is
   explicitly documented as non-executable. The auto-executor was changed to build from
   `preparedAction` (it previously read `rule.def.action` — on a rolling strategy that would
   have traded the stale anchor with real money).
3. **Guards, evaluated at the moment of entry** (`packages/rules/src/series.ts`, pure):
   the window's live ask must be at or below `maxEntryPrice`; at least `minRemainingMs`
   (default 30s) must remain; the window must not already have been traded. An unresolvable
   window or an empty book is a skip, never a guess.
4. **A skip refunds the repeat.** The state machine has already counted the trigger by the time
   the guards run, so a skip persists a compensated runtime (`revertRepeatForSkip`): the
   trigger count is restored and a 15-second re-arm cooldown replaces the full one. A window
   the strategy declined costs no money and must not consume a "trade at most N windows" budget.
5. **One entry per window, enforced in the database.** `conditional_rules.last_series_window_start`
   is compare-and-set (`claimSeriesWindow`) before any trigger row is written, so the guarantee
   survives restarts and concurrent evaluations. Auto orders additionally key idempotency on
   `auto:<rule>:<series>:<windowStart>`, so the order ledger's unique constraint is a second,
   independent guarantee.
6. **Rolling entries must be immediate (FOK/FAK).** A resting order can fill minutes after the
   price guard was checked; on a market that resolves in five minutes that defeats the guard
   entirely. Validation enforces it (`SERIES_REQUIRES_IMMEDIATE`).
7. **Repeating signed orders are allowed only when rolling.** `REPEAT_REQUIRES_ALERT_OR_AUTO`
   exists so manual confirmations don't pile up; a rolling confirmation expires with its window
   by construction, so the rule is relaxed for exactly that case. Submitting after the window
   closed is refused server-side with `WINDOW_CLOSED` (owner decision 2b).
8. **The anchor is not watched.** `referencedTokenIds` skips a rolling action's market: it would
   burn a WebSocket subscription and one of four market slots on a book nobody reads.
9. **Modeled outcomes before saving** (owner decision 4). Caps stay optional, so the arm sheet
   instead shows exact arithmetic at the price ceiling: best case, worst case, per-window win
   and loss, the most that can ever be spent, and — the headline — the **break-even win rate**
   (entry price plus per-share fee). These markets have no exit, so the only real unknown is
   how often the call is right, and that is the number to put in front of the user.

## Consequences

- A rolling strategy never expires with a market. The slice-4 window-end expiry default is
  explicitly skipped for rolling strategies, including when an instant market is also watched
  as a condition — otherwise binding both would kill the strategy within minutes.
- Windows are resolved lazily, only when a strategy fires. There is no per-window bookkeeping,
  no subscription churn, and no roll audit row: a 5-minute strategy would otherwise write ~288
  timeline entries a day and drown the events that matter. The live target is computed on read
  for display instead. _(This is a deliberate deviation from the approved walkthrough, which
  described a "rolled to the next window" timeline entry; the user-visible promise — see the
  current target, see every entry and skip — is preserved.)_
- The timeline gains five honest skip reasons (price above ceiling, too little time left,
  already traded, no book, unresolved), each rendered with specifics.
- Cost: one Gamma window lookup plus one CLOB book read per trigger of a rolling strategy.
  Series ids are cached an hour. Nothing extra runs between triggers.
- Conditions still cannot roll. History-dependent predicates (`price_move`, `trailing`) are
  meaningless on an instance seconds old, so a later revision must allow rolling only on
  instantaneous conditions. `SeriesRef`, `MarketBinding` and `isSeriesRef` are exported for it.
- Unattended execution is unchanged: still gated by `FEATURE_CONDITIONAL_LIVE_EXECUTION`
  (itself requiring Privy signing + live trading). Rolling changes what a strategy targets, not
  what it is allowed to do without the user.

## Verification

Pure guard/model logic, window resolution, and validation are unit-tested. The acceptance test
(`apps/worker/src/rule-evaluator.rolling.test.ts`) runs the approved walkthrough end to end
through the real evaluator: enter window 1, skip window 2 on price, skip window 3 on time, with
both repeats refunded, plus one-entry-per-window under a flapping condition and fail-closed
behavior when the window can't be resolved or has no book.
