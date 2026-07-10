"use client";

/**
 * "A dip-buy here would have made +$X last month" — the cockpit's FOMO hook.
 * Runs the SAME dip-buy grid the showcase engine uses (shared simulateTriggers
 * from @mx2/rules) against this market's real 30-day history, client-side.
 * Positive results only, honestly labeled; renders nothing otherwise.
 */
import Link from "next/link";
import { TrendingDown } from "lucide-react";
import { simulateTriggers, type ExprNode, type MarketRef } from "@mx2/rules";
import { signedUsd } from "@/lib/format";
import { useTokenPricesHistory } from "@/lib/queries";

const DIP_DELTAS = [0.03, 0.05, 0.08];
const STAKE_USD = 100;

export function BacktestTeaser({
  conditionId,
  tokenId,
  outcome,
  title,
}: {
  conditionId: string;
  tokenId: string | null;
  outcome: string;
  title: string;
}) {
  const history = useTokenPricesHistory(tokenId);
  const series = history.data?.history ?? [];
  if (!tokenId || series.length < 2) return null;

  const current = series[series.length - 1]!.p;
  const ref: MarketRef = { conditionId, tokenId, outcome, title };

  let best: { pnl: number; triggers: number } | null = null;
  for (const delta of DIP_DELTAS) {
    const threshold = Math.round((current - delta) * 100) / 100;
    if (threshold < 0.05 || threshold > 0.95) continue;
    const expr: ExprNode = {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          condition: { kind: "price", market: ref, source: "ask", comparator: "lte", threshold },
        },
      ],
    };
    const result = simulateTriggers({
      expr,
      holdsForMs: 15 * 60_000,
      recurrence: { kind: "repeat", maxRepeats: 5, cooldownMs: 6 * 3_600_000 },
      action: {
        kind: "order",
        market: ref,
        side: "BUY",
        price: threshold,
        size: Math.round(STAKE_USD / threshold),
        orderType: "GTC",
        execution: "prepare",
      },
      series,
    });
    if (!result.supported || result.triggers.length === 0) continue;
    if (result.hypotheticalPnlUsd <= 0) continue;
    if (!best || result.hypotheticalPnlUsd > best.pnl) {
      best = { pnl: result.hypotheticalPnlUsd, triggers: result.triggers.length };
    }
  }

  if (!best) return null;

  const params = new URLSearchParams({
    template: "re-entry",
    conditionId,
    tokenId,
    outcome,
    title: title.slice(0, 120),
  });

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-pos/30 bg-pos/5 px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <TrendingDown size={15} className="mt-0.5 shrink-0 text-pos" aria-hidden />
        <p className="text-[12px] leading-snug text-fg">
          $100 dip-buys here would have made{" "}
          <span className="tabular font-semibold text-pos">{signedUsd(best.pnl)}</span> across{" "}
          {best.triggers} buy{best.triggers > 1 ? "s" : ""} in the last 30 days.{" "}
          <span className="text-[10px] text-muted">Hypothetical — past ≠ future.</span>
        </p>
      </div>
      <Link
        href={`/smart-orders/new?${params.toString()}`}
        className="shrink-0 text-[12px] font-semibold text-accent transition-colors hover:text-brand-strong"
      >
        Automate it →
      </Link>
    </div>
  );
}
