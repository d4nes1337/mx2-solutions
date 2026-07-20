"use client";

/**
 * One-line dashboard pulse: "2 ready to sign · 1 missed · 5 approaching —
 * closest 1.2¢ away". Each chip scrolls to its section. Renders nothing when
 * there is no action or anticipation to point at (only watching/done).
 */
import { cn } from "@/components/ui";
import { cents } from "@/lib/format";
import type { Section } from "@/lib/smart-orders/sections";
import type { StrategyOverviewItem } from "@/lib/smart-orders/queries";

const CHIP_TONES: Record<string, string> = {
  failed: "border-neg/40 bg-neg/10 text-neg",
  ready: "border-pos/40 bg-pos/10 text-pos",
  missed: "border-warn/40 bg-warn/10 text-warn",
  approaching: "border-brand/40 bg-brand-soft text-accent",
};

const CHIP_LABELS: Record<string, (n: number) => string> = {
  failed: (n) => `${n} need${n === 1 ? "s" : ""} attention`,
  ready: (n) => `${n} ready to sign`,
  missed: (n) => `${n} missed`,
  approaching: (n) => `${n} approaching`,
};

export function PulseStrip({
  sections,
  overview,
}: {
  sections: Section[];
  overview: Map<string, StrategyOverviewItem>;
}) {
  const chips = sections.filter((s) => s.section in CHIP_LABELS && s.rows.length > 0);
  if (chips.length === 0) return null;

  const approaching = sections.find((s) => s.section === "approaching");
  const closest = (approaching?.rows ?? [])
    .map((r) => overview.get(r.id)?.proximity?.bindingDistance ?? null)
    .filter((d): d is number => d !== null && d > 0)
    .reduce<number | null>((min, d) => (min === null || d < min ? d : min), null);

  const scrollTo = (id: string) =>
    document
      .getElementById(`section-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="navigation"
      aria-label="Dashboard pulse"
    >
      {chips.map(({ section, rows }) => (
        <button
          key={section}
          type="button"
          onClick={() => scrollTo(section)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-transform hover:scale-[1.03]",
            CHIP_TONES[section],
          )}
        >
          {CHIP_LABELS[section]!(rows.length)}
        </button>
      ))}
      {closest !== null ? (
        <span className="tabular text-[11px] text-muted">closest {cents(closest)} away</span>
      ) : null}
    </div>
  );
}
