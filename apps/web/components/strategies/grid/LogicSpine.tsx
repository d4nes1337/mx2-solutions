"use client";

/**
 * The IF → THEN connector between the WATCH and ACT zones. The root
 * combinator moved to IfZoneHeader (where it visibly spans all the condition
 * cards); the spine now carries only direction and the hold window, so no
 * control appears twice.
 */
import { ArrowDown, ArrowRight, Clock } from "lucide-react";
import { humanDuration } from "@/lib/strategies/sentence";

export function LogicSpine({
  holdsForMs,
  edit,
}: {
  holdsForMs: number;
  edit?: { onOpenSettings: () => void } | undefined;
}) {
  const holdText = holdsForMs > 0 ? `holds ${humanDuration(holdsForMs)}` : "instant";
  const chip = (
    <span className="tabular inline-flex items-center gap-1 text-[11px] text-muted">
      <Clock size={10} aria-hidden />
      {holdText}
    </span>
  );
  return (
    <div className="flex items-center justify-center gap-2 py-1 lg:flex-col lg:gap-2.5 lg:py-8">
      <ArrowRight size={18} aria-hidden className="hidden shrink-0 text-faint lg:block" />
      <ArrowDown size={18} aria-hidden className="shrink-0 text-faint lg:hidden" />
      {edit ? (
        <button
          type="button"
          onClick={edit.onOpenSettings}
          className="rounded-full border border-border bg-surface px-2 py-0.5 transition-colors hover:border-brand/50"
          title="Hold window, recurrence, expiry…"
        >
          {chip}
        </button>
      ) : (
        chip
      )}
    </div>
  );
}
