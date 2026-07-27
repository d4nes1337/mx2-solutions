"use client";

/**
 * Header of the WATCH column — the one place the ROOT combinator lives.
 * It sits above every condition card and reads as a sentence ("IF all of
 * these hold"), so it can't be mistaken for a per-card control the way the
 * old pill in the first card's header was. Per-card combinators are inline
 * and/or connectors between rows (WatchMarketCard).
 */
import { Segmented } from "@/components/ui";

const ROOT_OPTIONS = [
  { value: "and", label: "ALL" },
  { value: "or", label: "ANY" },
];

export function IfZoneHeader({
  rootOp,
  cardCount,
  onSetRootOp,
}: {
  rootOp: "and" | "or";
  /** Number of condition cards the combinator spans. */
  cardCount: number;
  /** Edit mode only; omitted renders a static label. */
  onSetRootOp?: ((op: "and" | "or") => void) | undefined;
}) {
  // With a single card there is nothing to combine — showing a control would
  // invite the "does this apply to the card or the strategy?" confusion again.
  const meaningful = cardCount > 1;
  return (
    <div className="flex flex-wrap items-center gap-2 px-0.5">
      <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-accent">
        If
      </span>
      {meaningful ? (
        onSetRootOp ? (
          <>
            <Segmented
              options={ROOT_OPTIONS}
              value={rootOp}
              onChange={(v) => onSetRootOp(v as "and" | "or")}
              size="sm"
            />
            <span className="text-[12px] text-muted">
              of these {cardCount} markets hold at once
            </span>
          </>
        ) : (
          <span className="text-[12px] text-muted">
            <span className="font-semibold text-fg">{rootOp === "and" ? "ALL" : "ANY"}</span> of
            these {cardCount} markets hold at once
          </span>
        )
      ) : (
        <span className="text-[12px] text-muted">these conditions hold</span>
      )}
    </div>
  );
}
