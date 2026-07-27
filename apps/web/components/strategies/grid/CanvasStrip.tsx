"use client";

/**
 * The canvas, always on screen as a horizontal strip under the grid — the old
 * Grid/Canvas toggle was a header button nobody found, which hid the feature
 * users like most. It "peeks" by default (enough to read the shape of the
 * strategy) and expands in place; selection is shared with the grid through
 * the store, so clicking a block here highlights the matching grid card.
 */
import dynamic from "next/dynamic";
import { forwardRef, useEffect, useState } from "react";
import { Eraser, Maximize2, Minimize2, Network } from "lucide-react";
import { Skeleton, cn } from "@/components/ui";
import { docHasContent } from "@/lib/strategies/doc";
import { useBuilderStore } from "@/lib/strategies/store";
import type { BuilderIssue } from "@/lib/strategies/compile";
import type { DraftEvaluation } from "@/lib/strategies/queries";
import type { CanvasHeight } from "@/lib/strategies/builder-view";
import { AddPalette } from "@/components/builder/AddPalette";

const BuilderCanvas = dynamic(() => import("@/components/builder/BuilderCanvas"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-xl" />,
});

/** Two-click wipe of the doc + AI chat; the armed state disarms after 3s. */
function ClearButton() {
  const clearCanvas = useBuilderStore((s) => s.clearCanvas);
  const canClear = useBuilderStore((s) => docHasContent(s.doc) || s.aiMessages.length > 0);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!canClear) return null;
  return (
    <button
      type="button"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        clearCanvas();
        setArmed(false);
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        armed
          ? "border-neg/50 bg-neg/10 text-neg"
          : "border-border bg-surface text-muted hover:border-neg/40 hover:text-neg",
      )}
    >
      <Eraser size={11} aria-hidden />
      {armed ? "Wipe everything?" : "Clear"}
    </button>
  );
}

const HEIGHT_CLASS: Record<CanvasHeight, string> = {
  peek: "h-[220px]",
  tall: "h-[min(70vh,640px)]",
};

export const CanvasStrip = forwardRef<
  HTMLDivElement,
  {
    height: CanvasHeight;
    onHeightChange: (h: CanvasHeight) => void;
    evaluation: DraftEvaluation | undefined;
    issues: BuilderIssue[];
  }
>(function CanvasStrip({ height, onHeightChange, evaluation, issues }, ref) {
  const expanded = height === "tall";
  return (
    <section ref={ref} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg">
            <Network size={13} aria-hidden /> Canvas
          </span>
          <span className="truncate text-[11px] text-faint">
            drag to rewire · click a block to find it in the grid
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ClearButton />
          <button
            type="button"
            onClick={() => onHeightChange(expanded ? "peek" : "tall")}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-brand/50 hover:text-fg"
          >
            {expanded ? (
              <>
                <Minimize2 size={11} aria-hidden /> Collapse
              </>
            ) : (
              <>
                <Maximize2 size={11} aria-hidden /> Expand
              </>
            )}
          </button>
        </div>
      </div>
      {/* Remounting on height change re-runs fitView so the graph re-frames
          itself instead of sitting cropped in the new box. The palette is the
          only way to add GROUPS (nested ANY/ALL), so it rides with the canvas. */}
      <div className={cn("relative overflow-hidden transition-[height]", HEIGHT_CLASS[height])}>
        <BuilderCanvas key={height} evaluation={evaluation} issues={issues} />
        <AddPalette />
      </div>
    </section>
  );
});
