"use client";

import type { ReactNode } from "react";
import type { GammaEvent } from "@/lib/types";
import { Card, Empty, ErrorNote, Skeleton } from "./ui";
import { MarketFeedRow } from "./MarketFeedRow";

export function MarketFeedColumn({
  title,
  subtitle,
  events,
  isLoading,
  error,
  headerExtra,
}: {
  title: string;
  subtitle?: string;
  events?: GammaEvent[];
  isLoading: boolean;
  error: Error | null;
  headerExtra?: ReactNode;
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border bg-surface-2/40 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-3.5 w-0.5 rounded-full bg-brand-strong" />
            <span className="text-xs font-semibold uppercase tracking-wide text-fg">{title}</span>
            {events ? (
              <span className="tabular rounded-sm border border-border bg-surface px-1 text-[10px] text-muted">
                {events.length}
              </span>
            ) : null}
          </div>
          {subtitle ? <div className="mt-0.5 pl-2.5 text-[10px] text-muted">{subtitle}</div> : null}
        </div>
        {headerExtra}
      </div>
      <div className="no-scrollbar max-h-[min(74vh,760px)] min-h-[320px] overflow-y-auto">
        {isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-2.5">
                <Skeleton className="h-7 w-7 shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-1.5 w-full" />
                  <Skeleton className="h-2 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="p-2">
            <ErrorNote message={error.message} />
          </div>
        ) : null}
        {!isLoading && !error && events?.length === 0 ? (
          <div className="p-2">
            <Empty>No markets in this feed.</Empty>
          </div>
        ) : null}
        {!isLoading &&
          events?.map((e) => <MarketFeedRow key={`${e.id}-${primaryKey(e)}`} event={e} />)}
      </div>
    </Card>
  );
}

function primaryKey(event: GammaEvent): string {
  const m = event.markets.find((x) => !x.closed);
  return m?.id ?? "none";
}
