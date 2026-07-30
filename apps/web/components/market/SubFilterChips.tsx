"use client";

import { cn } from "@/components/ui";
import { countCompact } from "@/lib/format";
import { useCategoryFilters } from "@/lib/queries";

/**
 * Polymarket's second chip row: the sub-filters under a category (Politics →
 * Trump / Midterms / Congress…), in the same rank order Polymarket uses, with
 * the same live counts, and with zero-count sub-tags hidden.
 *
 * The row is best-effort chrome over a grid that works without it: while it
 * loads, or if Gamma can't serve it, nothing renders and the category grid is
 * unaffected. Categories with no curated sub-tags (Elections, Esports, Art)
 * legitimately have no row.
 */
export function SubFilterChips({
  tag,
  sub,
  onChange,
}: {
  tag: string;
  sub: string | null;
  onChange: (sub: string | null) => void;
}) {
  const { data } = useCategoryFilters(tag);

  if (!data || data.filters.length === 0) return null;

  return (
    <div
      className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5"
      role="tablist"
      aria-label="Sub-filters"
    >
      <Chip active={sub === null} count={data.totalCount} onClick={() => onChange(null)}>
        All
      </Chip>
      {data.filters.map((f) => (
        <Chip key={f.slug} active={sub === f.slug} count={f.count} onClick={() => onChange(f.slug)}>
          {f.label}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
        active
          ? "border-brand/40 bg-brand-soft text-accent"
          : "border-transparent bg-transparent text-muted hover:bg-surface hover:text-fg",
      )}
    >
      {children}
      <span className={cn("ml-1.5 tabular-nums", active ? "text-accent/70" : "text-faint")}>
        {countCompact(count)}
      </span>
    </button>
  );
}
