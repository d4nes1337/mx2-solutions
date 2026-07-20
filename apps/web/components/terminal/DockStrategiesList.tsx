"use client";

/**
 * Slim armed-strategies list for the terminal dock: status dot, name, dwell
 * progress, one-line sentence — each row links to the full detail page.
 */
import Link from "next/link";
import { ChevronRight, Star } from "lucide-react";
import { Badge, Empty, LiveDot } from "@/components/ui";
import { docFromDefinition } from "@/lib/smart-orders/doc";
import { strategySentence } from "@/lib/smart-orders/sentence";
import { userStatus } from "@/lib/smart-orders/status";
import type { StrategyRow } from "@/lib/smart-orders/queries";

/** Client-side dwell % from the row's persisted window (no per-row polling). */
const dwellPct = (row: StrategyRow): number | null => {
  const holdsForMs = row.definitionV2.holdsForMs;
  if (row.status !== "ACTIVE_ACCUMULATING" || row.trueSince === null || holdsForMs <= 0) {
    return null;
  }
  const elapsed = Date.now() - new Date(row.trueSince).getTime();
  return Math.min(100, Math.max(0, (elapsed / holdsForMs) * 100));
};

export function DockStrategiesList({ rows }: { rows: StrategyRow[] }) {
  if (rows.length === 0) {
    return (
      <Empty>
        No live strategies.{" "}
        <Link href="/smart-orders/new" className="text-accent hover:underline">
          Create one →
        </Link>
      </Empty>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => {
        const def = row.definitionV2;
        const status = userStatus(row.status, {
          actionKind: def.action.kind,
          execution: def.action.kind === "order" ? def.action.execution : undefined,
        });
        const pct = dwellPct(row);
        return (
          <li key={row.id}>
            <Link
              href={`/smart-orders/${row.id}`}
              className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-2/60"
            >
              <div className="w-32 shrink-0">
                {status.live ? (
                  <LiveDot
                    label={status.label.toUpperCase()}
                    tone={status.tone === "neg" ? "neg" : status.tone === "warn" ? "warn" : "pos"}
                  />
                ) : (
                  <Badge tone={status.tone}>{status.label}</Badge>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 truncate text-[13px] font-medium text-fg">
                  {row.starredAt ? (
                    <Star
                      size={10}
                      aria-label="Starred"
                      className="shrink-0 text-warn"
                      fill="currentColor"
                    />
                  ) : null}
                  <span className="truncate">{row.name || def.name || "Smart Order"}</span>
                </div>
                <div className="truncate text-[11px] text-faint">
                  {strategySentence(docFromDefinition(def))}
                </div>
              </div>
              {pct !== null ? (
                <div className="w-24 shrink-0">
                  <div className="tabular mb-1 text-right text-[10px] text-muted">
                    holding {Math.round(pct)}%
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              ) : null}
              <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
