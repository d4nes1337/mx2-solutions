"use client";

/**
 * One condition line in the grid: plain-English summary, the live reading
 * ("now 63¢") and an honest state chip. Wording and states intentionally
 * mirror the dashboard side panel so every surface describes a condition
 * with the same words.
 */
import { Badge } from "@/components/ui";
import { conditionSummary, formatActual } from "@/lib/strategies/summaries";
import type { StrategyDoc } from "@/lib/strategies/doc";
import type { ConditionLiveResult, GridRow } from "@/lib/strategies/grid-projection";

export function ConditionRow({
  doc,
  row,
  result,
  showMarketDetail = false,
}: {
  doc: StrategyDoc;
  row: GridRow;
  result: ConditionLiveResult | undefined;
  /** Show the market label under the summary (off inside market cards). */
  showMarketDetail?: boolean;
}) {
  const { summary, detail } = conditionSummary(doc, row.condition);
  const actual = result ? formatActual(row.condition.kind, result.actual) : null;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-[13px] text-fg">{summary}</div>
        {showMarketDetail && detail ? (
          <div className="truncate text-[11px] text-faint">{detail}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actual !== null ? <span className="tabular text-[12px] text-muted">now {actual}</span> : null}
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
    </div>
  );
}
