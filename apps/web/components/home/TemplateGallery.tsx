"use client";

import Link from "next/link";
import { ArrowRight, Repeat2, Scale, TrendingDown } from "lucide-react";

const TEMPLATES = [
  {
    id: "re-entry",
    icon: TrendingDown,
    name: "Re-entry",
    blurb: "Buy the dip — but only when the price holds and liquidity confirms it.",
    example: "If YES drops below 58¢ for 5 min and liquidity ≥ $2,000, buy YES at 57¢.",
  },
  {
    id: "cross-market",
    icon: Scale,
    name: "Cross-market",
    blurb: "React when two related markets disagree, using @market references.",
    example: "If market A is above 70¢ and @market B is above 40¢ for 10 min, alert me.",
  },
  {
    id: "maker-reward",
    icon: Repeat2,
    name: "Reward-aware maker",
    blurb: "Place maker orders when the spread, liquidity, and expected reward line up.",
    example: "If the spread is tight and expected reward beats the threshold, quote a maker order.",
  },
] as const;

export function TemplateGallery() {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Start from a template</h2>
        <Link
          href="/smart-orders/new"
          className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
        >
          Open the builder <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {TEMPLATES.map((t) => (
          <Link
            key={t.id}
            href={`/smart-orders/new?template=${t.id}`}
            className="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 shadow-panel transition-all hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-elev"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-soft text-accent">
              <t.icon size={18} aria-hidden />
            </span>
            <span className="text-[15px] font-semibold text-fg">{t.name}</span>
            <span className="text-[13px] leading-snug text-muted">{t.blurb}</span>
            <span className="mt-auto rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[12px] italic leading-snug text-muted">
              “{t.example}”
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
