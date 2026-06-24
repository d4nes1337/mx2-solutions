"use client";

import type { ReactNode } from "react";
import type { GammaEvent } from "@/lib/types";
import { Card, CardHeader, Empty, ErrorNote, Spinner } from "./ui";
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
    <Card className="flex min-h-0 flex-col overflow-hidden rounded-sm">
      <CardHeader className="shrink-0 space-y-1 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide">{title}</div>
            {subtitle ? <div className="text-[10px] font-normal text-muted">{subtitle}</div> : null}
          </div>
          {headerExtra}
        </div>
      </CardHeader>
      <div className="max-h-[min(72vh,720px)] min-h-[320px] overflow-y-auto">
        {isLoading ? (
          <div className="p-3">
            <Spinner label="Loading…" />
          </div>
        ) : null}
        {error ? (
          <div className="p-2">
            <ErrorNote message={error.message} />
          </div>
        ) : null}
        {!isLoading && !error && events?.length === 0 ? (
          <Empty>No markets in this feed.</Empty>
        ) : null}
        {events?.map((e) => (
          <MarketFeedRow key={`${e.id}-${primaryKey(e)}`} event={e} />
        ))}
      </div>
    </Card>
  );
}

function primaryKey(event: GammaEvent): string {
  const m = event.markets.find((x) => !x.closed);
  return m?.id ?? "none";
}
