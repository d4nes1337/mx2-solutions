"use client";

/**
 * Filter bar for the Smart Orders monitor: text search, status-group chips,
 * tag chips (union of tags across loaded strategies), and an Archived toggle.
 * Pure controlled component — filtering happens in the page.
 */
import { Archive, Search, X } from "lucide-react";
import { cn } from "@/components/ui";
import { GROUP_TITLES, type UserStatus } from "@/lib/smart-orders/status";

export interface StrategyFilters {
  query: string;
  group: UserStatus["group"] | null;
  /** OR-matched: a strategy shows when it carries ANY active tag. */
  tags: string[];
  showArchived: boolean;
}

export const EMPTY_FILTERS: StrategyFilters = {
  query: "",
  group: null,
  tags: [],
  showArchived: false,
};

const chipClass = (active: boolean) =>
  cn(
    "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
    active
      ? "border-brand/50 bg-brand-soft text-accent"
      : "border-border bg-surface text-muted hover:text-fg",
  );

export function FilterBar({
  filters,
  onChange,
  groups,
  tags,
  archivedCount,
}: {
  filters: StrategyFilters;
  onChange: (next: StrategyFilters) => void;
  /** Status groups present in the data, with counts (render order = given order). */
  groups: { group: UserStatus["group"]; count: number }[];
  /** Tag vocabulary (union across strategies). */
  tags: string[];
  archivedCount: number;
}) {
  const hasFilters =
    filters.query !== "" || filters.group !== null || filters.tags.length > 0;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 focus-within:border-brand">
          <Search size={13} className="shrink-0 text-faint" aria-hidden />
          <input
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Search your strategies…"
            aria-label="Search your strategies"
            className="w-44 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </label>
        {groups.map(({ group, count }) => (
          <button
            key={group}
            type="button"
            onClick={() =>
              onChange({ ...filters, group: filters.group === group ? null : group })
            }
            className={chipClass(filters.group === group)}
          >
            {GROUP_TITLES[group]} · {count}
          </button>
        ))}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => onChange({ ...filters, showArchived: !filters.showArchived })}
          className={chipClass(filters.showArchived)}
          title="Show archived strategies"
        >
          <Archive size={11} aria-hidden className="mr-1 inline-block align-[-1px]" />
          Archived{archivedCount > 0 ? ` · ${archivedCount}` : ""}
        </button>
        {hasFilters ? (
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_FILTERS, showArchived: filters.showArchived })}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-fg"
          >
            <X size={11} aria-hidden /> Clear
          </button>
        ) : null}
      </div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            Tags
          </span>
          {tags.map((tag) => {
            const active = filters.tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  onChange({
                    ...filters,
                    tags: active
                      ? filters.tags.filter((t) => t !== tag)
                      : [...filters.tags, tag],
                  })
                }
                className={chipClass(active)}
              >
                {tag}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
