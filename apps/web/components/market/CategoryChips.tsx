"use client";

import { BROWSE_TAGS } from "@/lib/browse";
import { cn } from "@/components/ui";

/**
 * Polymarket-style category row over the browse grid. One active tag at a
 * time; "All" = no tag filter. Horizontally scrollable on small screens.
 */
export function CategoryChips({
  tag,
  onChange,
}: {
  tag: string | null;
  onChange: (tag: string | null) => void;
}) {
  return (
    <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5" role="tablist">
      {BROWSE_TAGS.map((t) => {
        const active = tag === t.slug;
        return (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.slug)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors",
              active
                ? "border-brand/40 bg-brand-soft text-accent"
                : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
