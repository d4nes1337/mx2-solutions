"use client";

/**
 * "How you could enter this market" — up to three backtested entry scenarios
 * served by GET /api/markets/:id/scenarios, rendered directly under the price
 * chart. Each card shows the rule sentence, its 30-day hypothetical result,
 * the chat prompt that would build it, and a one-click deep link that hydrates
 * the exact definition in the builder (?scenarioMarket=…&scenario=…).
 * Estimates only — winners are selected by design (same honesty contract as
 * the home showcases, R-023).
 */
import Link from "next/link";
import { Sparkles, TrendingDown, TrendingUp, Clock3, ShieldCheck, Repeat2 } from "lucide-react";
import { useMarketScenarios } from "@/lib/queries";
import { signedUsd } from "@/lib/format";
import type { MarketScenario } from "@/lib/types";
import { Badge, Card, CardHeader, cn } from "@/components/ui";

const KIND_META: Record<MarketScenario["kind"], { Icon: typeof TrendingUp; tone: string }> = {
  dip_buy: { Icon: TrendingDown, tone: "text-pos" },
  breakout: { Icon: TrendingUp, tone: "text-accent" },
  limit_entry: { Icon: Clock3, tone: "text-muted" },
  trailing_dip: { Icon: TrendingDown, tone: "text-accent" },
  rescue_exit: { Icon: ShieldCheck, tone: "text-warn" },
  farm_rewards: { Icon: Repeat2, tone: "text-pos" },
};

export function MarketScenarios({
  marketId,
  outcomeIdx,
  outcomeLabel,
}: {
  marketId: string;
  outcomeIdx: number;
  outcomeLabel: string;
}) {
  const scenarios = useMarketScenarios(marketId, outcomeIdx);
  const list = scenarios.data?.scenarios ?? [];

  if (!scenarios.isLoading && list.length === 0) return null;

  return (
    <Card data-tour="market-scenarios">
      <CardHeader right={<Badge tone="neutral">hypothetical · past ≠ future</Badge>}>
        How you could enter this market
      </CardHeader>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        {scenarios.isLoading
          ? Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton h-36 rounded-lg" aria-hidden />
            ))
          : list.map((sc) => (
              <ScenarioCard key={sc.id} scenario={sc} marketId={marketId} outcomeIdx={outcomeIdx} />
            ))}
      </div>
      {list.length > 0 ? (
        <p className="px-4 pb-3 text-[11px] leading-relaxed text-faint">
          Backtested on the real last-{list[0]!.stats.windowDays}-day price series for{" "}
          {outcomeLabel}. Only entries that would have worked are shown — that&apos;s selection
          bias, not a promise.
        </p>
      ) : null}
    </Card>
  );
}

function ScenarioCard({
  scenario,
  marketId,
  outcomeIdx,
}: {
  scenario: MarketScenario;
  marketId: string;
  outcomeIdx: number;
}) {
  const { Icon, tone } = KIND_META[scenario.kind];
  const pnl = scenario.stats.hypotheticalPnlUsd;
  const href = `/smart-orders/new?scenarioMarket=${encodeURIComponent(marketId)}&scenario=${encodeURIComponent(scenario.id)}&outcome=${outcomeIdx}`;

  return (
    <div className="flex flex-col justify-between gap-2 rounded-lg border border-border bg-surface-2/50 p-3">
      <div>
        <div className="flex items-center gap-1.5">
          <Icon size={14} className={cn("shrink-0", tone)} aria-hidden />
          <span className="text-[13px] font-semibold text-fg">{scenario.label}</span>
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-muted">{scenario.sentence}</p>
      </div>

      <div className="tabular text-[11px]">
        {pnl !== undefined ? (
          <span>
            <span className={pnl >= 0 ? "font-semibold text-pos" : "font-semibold text-neg"}>
              {signedUsd(pnl)}
            </span>{" "}
            <span className="text-faint">
              hypothetical · would have fired {scenario.stats.triggerCount}×
            </span>
          </span>
        ) : scenario.stats.touches !== undefined ? (
          <span className="text-faint">
            price touched this level {scenario.stats.touches}× in {scenario.stats.windowDays}d
          </span>
        ) : scenario.stats.rewardsPerDayUsd !== undefined ? (
          <span className="text-faint">
            pool pays ≈${scenario.stats.rewardsPerDayUsd}/day, shared across makers
          </span>
        ) : scenario.stats.triggerCount !== undefined ? (
          <span className="text-faint">
            would have spoken up {scenario.stats.triggerCount}× in {scenario.stats.windowDays}d — no
            profit claim
          </span>
        ) : (
          <span className="text-faint">no backtest claim for this one</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Link
          href={scenario.link?.href ?? href}
          className="inline-flex items-center gap-1 rounded-md border border-brand/40 bg-brand-soft px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:border-brand"
        >
          <Sparkles size={11} aria-hidden /> {scenario.link?.label ?? "Open in builder"}
        </Link>
        <span className="tabular text-[11px] text-muted">
          {scenario.kind === "rescue_exit" || scenario.kind === "farm_rewards"
            ? `now ${scenario.entryPriceCents}¢`
            : `entry ${scenario.entryPriceCents}¢`}
        </span>
      </div>
    </div>
  );
}
