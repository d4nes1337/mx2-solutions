"use client";

/**
 * "Strategies that would have paid off" — REAL trending markets, REAL 30-day
 * backtests, one click to a ready-to-save strategy. Only winners are shown by
 * design (see R-023) so every card carries the hypothetical/past≠future label.
 * Falls back to the abstract template gallery while loading or when the
 * showcase engine has nothing.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AreaChart } from "@/components/charts/AreaChart";
import { Skeleton } from "@/components/ui";
import { cents, signedUsd } from "@/lib/format";
import { useShowcases } from "@/lib/queries";
import { TemplateGallery } from "./TemplateGallery";

export function ShowcaseGallery() {
  const sc = useShowcases();

  if (sc.isLoading) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-fg">
          Strategies that would have paid off
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 w-full rounded-xl" />
          ))}
        </div>
      </section>
    );
  }

  const showcases = sc.data?.showcases ?? [];
  if (showcases.length === 0) return <TemplateGallery />;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">
            Strategies that would have paid off
          </h2>
          <p className="text-[12px] text-muted">
            Backtested on the last 30 days of real prices. Hypothetical — past performance
            doesn&apos;t predict the future.
          </p>
        </div>
        <Link
          href="/smart-orders/new"
          className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
        >
          Build your own <ArrowRight size={14} aria-hidden />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {showcases.slice(0, 6).map((s) => (
          <Link
            key={s.id}
            href={`/smart-orders/new?showcase=${encodeURIComponent(s.id)}`}
            className="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 shadow-panel transition-all hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-elev"
          >
            <div className="flex items-start gap-2.5">
              {s.market.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.market.image}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="h-9 w-9 shrink-0 rounded-lg bg-surface-3" />
              )}
              <span className="line-clamp-2 text-[14px] font-semibold leading-snug text-fg">
                {s.market.title}
              </span>
            </div>

            <span className="text-[12px] leading-snug text-muted">{s.sentence}</span>

            <span className="tabular inline-flex w-fit items-center rounded-full bg-pos/10 px-2.5 py-1 text-[12px] font-semibold text-pos">
              {signedUsd(s.stats.hypotheticalPnlUsd)} across {s.stats.triggerCount} × $
              {s.stats.stakeUsd} dip-buy{s.stats.triggerCount > 1 ? "s" : ""} · last{" "}
              {s.stats.windowDays}d
            </span>

            <AreaChart
              data={s.series.map((pt) => ({ t: pt.t, v: pt.p }))}
              height={90}
              showAxis={false}
              markers={s.triggers.map((tr) => ({ t: tr.t, label: `trigger @ ${cents(tr.price)}` }))}
              valueFormat={(v) => cents(v)}
            />

            <span className="mt-auto text-[12px] font-semibold text-accent group-hover:text-brand-strong">
              Open this strategy →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
