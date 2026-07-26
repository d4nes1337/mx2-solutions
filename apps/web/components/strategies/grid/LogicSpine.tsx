"use client";

/**
 * The IF → THEN connector between the WATCH and ACT zones. Shows the root
 * ALL/ANY combinator and the hold window; reads vertically on desktop
 * (between the columns) and horizontally when the zones stack on mobile.
 */
import { ArrowDown, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui";
import { humanDuration } from "@/lib/strategies/sentence";

export function LogicSpine({ rootOp, holdsForMs }: { rootOp: "and" | "or"; holdsForMs: number }) {
  const opText = rootOp === "and" ? "ALL met" : "ANY met";
  const holdText = holdsForMs > 0 ? `holds ${humanDuration(holdsForMs)}` : "instant";
  return (
    <div className="flex items-center justify-center gap-2 py-1 lg:flex-col lg:gap-2.5 lg:py-6">
      <span className="text-micro font-semibold uppercase tracking-wider text-faint">IF</span>
      <Badge tone="brand">{opText}</Badge>
      <span className="tabular text-[11px] text-muted">{holdText}</span>
      <ArrowRight size={18} aria-hidden className="hidden text-faint lg:block" />
      <ArrowDown size={18} aria-hidden className="text-faint lg:hidden" />
      <span className="text-micro font-semibold uppercase tracking-wider text-faint">THEN</span>
    </div>
  );
}
