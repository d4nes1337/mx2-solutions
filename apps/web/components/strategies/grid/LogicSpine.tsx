"use client";

/**
 * The IF → THEN connector between the WATCH and ACT zones. Shows the root
 * ALL/ANY combinator and the hold window; reads vertically on desktop
 * (between the columns) and horizontally when the zones stack on mobile.
 * Edit mode makes the combinator a toggle and the hold chip a button into
 * the strategy settings.
 */
import { ArrowDown, ArrowRight } from "lucide-react";
import { Badge, Segmented } from "@/components/ui";
import { humanDuration } from "@/lib/strategies/sentence";

const ROOT_OPTIONS = [
  { value: "and", label: "ALL" },
  { value: "or", label: "ANY" },
];

export function LogicSpine({
  rootOp,
  holdsForMs,
  edit,
}: {
  rootOp: "and" | "or";
  holdsForMs: number;
  edit?:
    | {
        onSetRootOp: (op: "and" | "or") => void;
        onOpenSettings: () => void;
      }
    | undefined;
}) {
  const holdText = holdsForMs > 0 ? `holds ${humanDuration(holdsForMs)}` : "instant";
  return (
    <div className="flex items-center justify-center gap-2 py-1 lg:flex-col lg:gap-2.5 lg:py-6">
      <span className="text-micro font-semibold uppercase tracking-wider text-faint">IF</span>
      {edit ? (
        <Segmented
          options={ROOT_OPTIONS}
          value={rootOp}
          onChange={(v) => edit.onSetRootOp(v as "and" | "or")}
          size="sm"
        />
      ) : (
        <Badge tone="brand">{rootOp === "and" ? "ALL met" : "ANY met"}</Badge>
      )}
      {edit ? (
        <button
          type="button"
          onClick={edit.onOpenSettings}
          className="tabular rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-brand/50 hover:text-fg"
          title="Hold window, recurrence, expiry…"
        >
          {holdText}
        </button>
      ) : (
        <span className="tabular text-[11px] text-muted">{holdText}</span>
      )}
      <ArrowRight size={18} aria-hidden className="hidden text-faint lg:block" />
      <ArrowDown size={18} aria-hidden className="text-faint lg:hidden" />
      <span className="text-micro font-semibold uppercase tracking-wider text-faint">THEN</span>
    </div>
  );
}
