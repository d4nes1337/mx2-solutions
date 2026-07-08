"use client";

/**
 * The always-visible plain-English strategy sentence. Chips are clickable —
 * selecting one focuses the corresponding node on the canvas/inspector.
 */
import { cn } from "@/components/ui";
import { describeStrategy } from "@/lib/smart-orders/sentence";
import { useBuilderStore } from "@/lib/smart-orders/store";

const TONE_STYLES: Record<string, string> = {
  brand: "border-brand/40 bg-brand-soft text-accent",
  pos: "border-pos/30 bg-pos/10 text-pos",
  neg: "border-neg/30 bg-neg/10 text-neg",
  warn: "border-warn/30 bg-warn/10 text-warn",
};

export function SentenceBar() {
  const doc = useBuilderStore((s) => s.doc);
  const select = useBuilderStore((s) => s.select);
  const segments = describeStrategy(doc);

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-panel"
      aria-label="Strategy in plain English"
    >
      {segments.map((seg, i) =>
        seg.nodeId ? (
          <button
            key={i}
            type="button"
            onClick={() => select(seg.nodeId)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-all hover:-translate-y-px",
              TONE_STYLES[seg.tone ?? ""] ?? "border-border bg-surface-2 text-fg",
              doc.selectedNodeId === seg.nodeId && "ring-2 ring-brand/40",
            )}
          >
            {seg.text}
          </button>
        ) : (
          <span key={i} className="text-[12px] text-muted">
            {seg.text}
          </span>
        ),
      )}
    </div>
  );
}
