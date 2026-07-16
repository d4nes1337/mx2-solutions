"use client";

/**
 * Reward-aware maker estimator panel (shown with the maker template). Reads
 * the strategy's order quote + the live book and reports program
 * qualification, capital use, fill likelihood and worst-case downside —
 * clearly labeled as estimates, never as promised rewards.
 */
import { Badge } from "@/components/ui";
import { useMarketEconomics } from "@/lib/queries";
import { estimateMakerQuote } from "@/lib/smart-orders/maker-estimate";
import { isBound } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import type { DraftEvaluation } from "@/lib/smart-orders/queries";

const money = (n: number) => `$${n.toFixed(2)}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-muted">{label}</span>
      <span className="tabular font-medium text-fg">{children}</span>
    </div>
  );
}

export function MakerEstimator({ evaluation }: { evaluation: DraftEvaluation | undefined }) {
  const doc = useBuilderStore((s) => s.doc);
  const a = doc.action.kind === "order" ? doc.action : null;
  const economics = useMarketEconomics(
    doc.templateId === "maker-reward" && a && isBound(a.market) ? a.market.conditionId : "",
  );
  if (doc.templateId !== "maker-reward" || !a) return null;

  const market = evaluation?.markets.find((m) => m.tokenId === a.market.tokenId);
  const meta = doc.marketMeta[a.market.tokenId];
  const rewards = economics.data?.rewards ?? null;
  const rebateRate = economics.data?.feeSchedule?.rebateRate ?? null;

  const est = estimateMakerQuote({
    price: a.price,
    size: a.size,
    side: a.side,
    bestBid: market?.bestBid ?? null,
    bestAsk: market?.bestAsk ?? null,
    rewardsMinSize: rewards?.minSize ?? meta?.rewardsMinSize ?? null,
    rewardsMaxSpread: rewards?.maxSpread ?? meta?.rewardsMaxSpread ?? null,
  });

  return (
    <aside className="space-y-2.5 rounded-xl border border-border bg-surface p-4 shadow-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-fg">Maker estimate</h3>
        <Badge tone="neutral">estimates</Badge>
      </div>

      <Row label="Would qualify for rewards?">
        {est.qualifies === null ? (
          <Badge tone="neutral">unknown</Badge>
        ) : est.qualifies ? (
          <Badge tone="pos" dot>
            yes
          </Badge>
        ) : (
          <Badge tone="warn">not yet</Badge>
        )}
      </Row>
      {est.meetsMinSize !== null && meta?.rewardsMinSize ? (
        <Row label={`Min resting size (${meta.rewardsMinSize})`}>
          {est.meetsMinSize ? "✓ met" : `${a.size} / ${meta.rewardsMinSize}`}
        </Row>
      ) : null}
      {est.distanceFromMidCents !== null ? (
        <Row
          label={`Distance from mid${meta?.rewardsMaxSpread ? ` (max ${meta.rewardsMaxSpread}¢)` : ""}`}
        >
          {est.distanceFromMidCents.toFixed(1)}¢
        </Row>
      ) : null}
      <Row label="Capital while resting">{money(est.capitalUsd)}</Row>
      <Row label="Fill likelihood">{est.fillLikelihood}</Row>
      <Row label="Worst case if filled">−{money(est.maxDownsideUsd)}</Row>
      {rewards?.ratePerDayUsd != null ? (
        <Row label="Market's rewards pool">≈{money(rewards.ratePerDayUsd)}/day (shared)</Row>
      ) : null}
      {rebateRate != null && (economics.data?.feeSchedule?.rate ?? 0) > 0 ? (
        <Row label="Maker rebates">{Math.round(rebateRate * 100)}% of taker fees, pro-rata</Row>
      ) : null}

      <ul className="space-y-1 border-t border-border pt-2">
        {est.notes.map((note, i) => (
          <li key={i} className="text-[11px] leading-snug text-muted">
            {note}
          </li>
        ))}
      </ul>
    </aside>
  );
}
