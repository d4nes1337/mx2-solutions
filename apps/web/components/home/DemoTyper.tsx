"use client";

/**
 * The hero demo's fake user bubble (Slice 5): renders the auto-typer's
 * visible segments with per-kind highlight colors and a blinking caret.
 * Purely presentational — all timing lives in useDemoPlayer.
 */
import { cn } from "@/components/ui";
import type { TypedSegment } from "@/lib/home/demo-scenarios";
import type { VisibleSegment } from "@/lib/home/use-demo-player";

const segmentClass = (seg: TypedSegment): string | undefined => {
  switch (seg.highlight) {
    case "market":
      return "rounded-full border border-brand/40 bg-brand-soft px-1.5 py-0.5 font-medium text-accent";
    case "logic":
      return "font-semibold text-accent";
    case "number":
      return "tabular font-medium";
    case "action":
      // Buys read green, sells red — same pos/neg language as the cockpit.
      return cn("font-semibold", /sell/i.test(seg.text) ? "text-neg" : "text-pos");
    default:
      return undefined;
  }
};

export function DemoTyper({
  segments,
  caret = true,
}: {
  segments: VisibleSegment[];
  caret?: boolean;
}) {
  return (
    <div className="flex justify-end">
      <div className="w-fit max-w-[92%] rounded-lg rounded-br-sm border border-border bg-surface-2 px-3.5 py-2.5 text-[14px] leading-relaxed text-fg">
        {segments.map((s, i) => (
          <span key={i} className={segmentClass(s.seg)}>
            {s.shown}
          </span>
        ))}
        {caret ? (
          <span
            aria-hidden
            className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse rounded-full bg-accent"
          />
        ) : null}
      </div>
    </div>
  );
}
