"use client";

import { useMemo } from "react";
import type { Position } from "@/lib/types";
import { signed, signedUsd, toNum, usd } from "@/lib/format";
import { Card, CardHeader, cn, Empty } from "@/components/ui";

export function PortfolioAllocation({ positions }: { positions: Position[] }) {
  const { rows, total, best, worst } = useMemo(() => {
    const valued = positions
      .map((p) => ({ p, value: Math.max(0, toNum(p.currentValue)) }))
      .filter((r) => r.value > 0);
    const total = valued.reduce((s, r) => s + r.value, 0);
    const rows = [...valued].sort((a, b) => b.value - a.value).slice(0, 6);
    const byPnl = [...positions].sort((a, b) => toNum(b.cashPnl) - toNum(a.cashPnl));
    const best = byPnl[0];
    const worst = byPnl.length > 1 ? byPnl[byPnl.length - 1] : undefined;
    return { rows, total, best, worst };
  }, [positions]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        right={
          <span className="tabular text-xs text-muted">
            Exposure <span className="font-semibold text-fg">{usd(total)}</span>
          </span>
        }
      >
        Allocation
      </CardHeader>
      <div className="flex-1 space-y-3 p-4">
        {rows.length === 0 ? (
          <Empty>No open exposure.</Empty>
        ) : (
          <div className="space-y-2.5">
            {rows.map(({ p, value }, i) => {
              const share = total > 0 ? value / total : 0;
              const pnl = toNum(p.cashPnl);
              const title = p.title ?? p.conditionId;
              return (
                <div key={`${p.asset}-${i}`} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {p.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.icon}
                          alt=""
                          className="h-4 w-4 shrink-0 rounded-sm object-cover"
                        />
                      ) : null}
                      <span className="truncate text-fg">{title}</span>
                      {p.outcome ? (
                        <span
                          className={cn(
                            "shrink-0 text-[10px] font-semibold",
                            p.outcome.toUpperCase() === "YES"
                              ? "text-pos"
                              : p.outcome.toUpperCase() === "NO"
                                ? "text-neg"
                                : "text-muted",
                          )}
                        >
                          {p.outcome}
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular shrink-0 text-muted">{usd(value)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-brand-strong"
                        style={{ width: `${Math.max(2, share * 100)}%` }}
                      />
                    </div>
                    <span className="tabular w-10 shrink-0 text-right text-[10px] text-faint">
                      {(share * 100).toFixed(0)}%
                    </span>
                    <span
                      className={cn(
                        "tabular w-16 shrink-0 text-right text-[10px] font-medium",
                        pnl >= 0 ? "text-pos" : "text-neg",
                      )}
                    >
                      {signedUsd(pnl)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(best || worst) && (best?.title || worst?.title) ? (
          <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
            <Mover label="Top mover" position={best} />
            <Mover label="Worst" position={worst} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function Mover({ label, position }: { label: string; position?: Position }) {
  if (!position) return <div />;
  const pnl = toNum(position.cashPnl);
  const pct = toNum(position.percentPnl);
  return (
    <div className="rounded-md border border-border bg-surface-2/50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 truncate text-[11px] text-fg" title={position.title}>
        {position.title ?? position.conditionId}
      </div>
      <div className={cn("tabular mt-1 text-xs font-semibold", pnl >= 0 ? "text-pos" : "text-neg")}>
        {signedUsd(pnl)}{" "}
        <span className="text-[10px] font-normal text-faint">({signed(pct)}%)</span>
      </div>
    </div>
  );
}
