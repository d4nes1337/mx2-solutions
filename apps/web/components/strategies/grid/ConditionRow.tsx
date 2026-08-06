"use client";

/**
 * One condition line in the grid: plain-English summary, the live reading
 * ("now 63¢") and an honest state chip. Wording and states intentionally
 * mirror the dashboard side panel so every surface describes a condition
 * with the same words. In edit mode the row is a button that opens the
 * shared condition editor, with a delete control beside it — deleting a
 * condition must not require opening the canvas; rows the AI just touched
 * flash briefly.
 */
import { Pencil, X } from "lucide-react";
import { Badge, cn } from "@/components/ui";
import { conditionSummary, formatActual } from "@/lib/strategies/summaries";
import type { StrategyDoc } from "@/lib/strategies/doc";
import type { ConditionLiveResult, GridRow } from "@/lib/strategies/grid-projection";

export function ConditionRow({
  doc,
  row,
  result,
  showMarketDetail = false,
  onClick,
  onDelete,
  highlight = false,
}: {
  doc: StrategyDoc;
  row: GridRow;
  result: ConditionLiveResult | undefined;
  /** Show the market label under the summary (off inside market cards). */
  showMarketDetail?: boolean;
  /** Edit mode: opens this row's editor. */
  onClick?: (() => void) | undefined;
  /** Edit mode: removes this condition from the strategy. */
  onDelete?: (() => void) | undefined;
  /** Flash treatment for rows the AI just added or changed. */
  highlight?: boolean;
}) {
  const { summary, detail } = conditionSummary(doc, row.condition);
  const actual = result ? formatActual(row.condition.kind, result.actual) : null;
  const body = (
    <>
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-fg">{summary}</span>
          {onClick ? <Pencil size={11} aria-hidden className="shrink-0 text-faint" /> : null}
        </div>
        {showMarketDetail && detail ? (
          <div className="truncate text-[11px] text-faint">{detail}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actual !== null ? (
          <span className="tabular text-[12px] text-muted">now {actual}</span>
        ) : null}
        {!result ? (
          <Badge tone="neutral">—</Badge>
        ) : result.stale ? (
          <Badge tone="warn">no data</Badge>
        ) : result.satisfied ? (
          <Badge tone="pos">met</Badge>
        ) : (
          <Badge tone="neutral">not yet</Badge>
        )}
      </div>
    </>
  );
  const rowClass = cn(
    "flex w-full items-center justify-between gap-3 px-3 py-2",
    highlight && "animate-pulse bg-brand-soft",
  );
  if (!onClick && !onDelete) return <div className={rowClass}>{body}</div>;
  // The delete control can't nest inside the edit button (invalid HTML and
  // one swallows the other's click), so the row is a flex pair instead.
  return (
    <div className={cn("group/row flex items-center", highlight && "animate-pulse bg-brand-soft")}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2 pl-3 pr-1 text-left transition-colors hover:bg-surface-2"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2 pl-3 pr-1">
          {body}
        </div>
      )}
      {onDelete ? (
        <button
          type="button"
          aria-label={`Delete condition: ${summary}`}
          title="Delete this condition"
          onClick={onDelete}
          className="mr-1.5 shrink-0 rounded p-1.5 text-faint opacity-60 transition-all hover:bg-surface-2 hover:text-neg focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
