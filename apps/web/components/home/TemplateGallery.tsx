"use client";

import Link from "next/link";
import { ArrowRight, Repeat2, Scale, Sprout, TrendingDown, Zap } from "lucide-react";
import { templateSpecById } from "@mx2/rules";
import { TEMPLATES } from "@/lib/smart-orders/templates";
import { useFeatureFlags } from "@/lib/queries";

/** Gallery icons per template id (copy/structure come from the shared specs). */
const ICONS: Record<string, typeof TrendingDown> = {
  "re-entry": TrendingDown,
  "spike-reversal": Zap,
  "maker-reward": Repeat2,
  "rebate-farm": Sprout,
  "cross-market": Scale,
};

export function TemplateGallery() {
  const flags = useFeatureFlags();
  const rebateFarm = flags.data?.makerLoop ? templateSpecById("rebate-farm") : null;
  const cards = [
    ...TEMPLATES.map((t) => ({ ...t, href: `/smart-orders/new?template=${t.id}` })),
    // The maker loop is designed in the farming cockpit, not the builder.
    ...(rebateFarm
      ? [
          {
            id: rebateFarm.id,
            name: rebateFarm.name,
            blurb: rebateFarm.blurb,
            example: rebateFarm.example,
            href: "/farming",
          },
        ]
      : []),
  ];
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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((t) => {
          const Icon = ICONS[t.id] ?? TrendingDown;
          return (
            <Link
              key={t.id}
              href={t.href}
              className="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 shadow-panel transition-all hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-elev"
            >
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-soft text-accent">
                <Icon size={18} aria-hidden />
              </span>
              <span className="text-[15px] font-semibold text-fg">{t.name}</span>
              <span className="text-[13px] leading-snug text-muted">{t.blurb}</span>
              <span className="mt-auto rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[12px] italic leading-snug text-muted">
                “{t.example}”
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
