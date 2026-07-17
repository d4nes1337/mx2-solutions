"use client";

/**
 * A REAL trending market with its REAL 30-day backtest — extracted from the
 * old hero so "Proven plays" can reuse the card. Live cards are all real
 * data; sample cards (curated fallbacks with synthetic series) say so
 * honestly. The disclaimer keeps the selection-bias honesty bar (R-023) on
 * every card.
 */
import Link from "next/link";
import { Badge, LiveDot } from "@/components/ui";
import { AreaChart } from "@/components/charts/AreaChart";
import { signedUsd } from "@/lib/format";
import type { Showcase } from "@/lib/types";

/** A chip in a Smart Order sentence preview (shared hero/home styling). */
export function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    neutral: "border-border bg-surface text-fg",
    brand: "border-brand/40 bg-brand-soft text-accent",
    pos: "border-pos/30 bg-pos/10 text-pos",
    neg: "border-neg/30 bg-neg/10 text-neg",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] font-medium ${tones[tone] ?? tones.neutral}`}
    >
      {children}
    </span>
  );
}

export function ShowcaseCard({
  showcase,
  sample = false,
}: {
  showcase: Showcase;
  /** Curated fallback (synthetic series) — label it, never sell it as live. */
  sample?: boolean;
}) {
  const action = showcase.definition.action;
  const entryCents =
    action.kind === "order" ? Math.round(action.price * 100) : showcase.market.currentPriceCents;
  const noun = sample ? "trigger" : "dip-buy";
  // Sample ids don't resolve server-side — deep-link the prompt instead.
  const href =
    sample && showcase.prompt
      ? `/smart-orders/new?prompt=${encodeURIComponent(showcase.prompt)}`
      : `/smart-orders/new?showcase=${encodeURIComponent(showcase.id)}`;

  return (
    <div className="glass rounded-xl p-5 shadow-elev">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {sample ? "Sample play" : "Live showcase · Dip-buy"}
        </span>
        {sample ? <Badge>Sample</Badge> : <LiveDot label="BACKTESTED" />}
      </div>
      <div className="mt-3 line-clamp-2 text-[14px] font-semibold leading-snug text-fg">
        {showcase.market.title}
      </div>
      {sample ? (
        <p className="mt-3 text-[12px] leading-relaxed text-muted">{showcase.sentence}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 leading-relaxed">
          <Chip>If</Chip>
          <Chip tone="brand">{showcase.market.outcome} price</Chip>
          <Chip>dips below {entryCents}¢</Chip>
          <Chip>for 15 minutes</Chip>
          <span className="mx-1 text-muted">→</span>
          <Chip tone="pos">Buy $100 at {entryCents}¢</Chip>
        </div>
      )}
      <AreaChart
        data={showcase.series.map((pt) => ({ t: pt.t, v: pt.p }))}
        height={96}
        showAxis={false}
        markers={showcase.triggers.map((tr) => ({
          t: tr.t,
          label: `trigger @ ${Math.round(tr.price * 100)}¢`,
        }))}
        valueFormat={(v) => `${Math.round(v * 100)}¢`}
        className="mt-3"
      />
      <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
        <span className="tabular text-[12px] font-semibold text-pos">
          {signedUsd(showcase.stats.hypotheticalPnlUsd)} across {showcase.stats.triggerCount} × $
          {showcase.stats.stakeUsd} {noun}
          {showcase.stats.triggerCount > 1 ? "s" : ""} · last {showcase.stats.windowDays}d
        </span>
        <Link href={href} className="text-[12px] font-semibold text-accent hover:text-brand-strong">
          Open this strategy →
        </Link>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-faint">
        {sample
          ? "Hypothetical sample on synthetic prices — past performance doesn't predict the future."
          : "Hypothetical backtest on real prices — past performance doesn't predict the future."}
      </p>
    </div>
  );
}
