"use client";

import { ExternalLink } from "lucide-react";
import { useMarketResolve } from "@/lib/queries";
import { cn } from "@/components/ui";

/**
 * "View on Polymarket" — an outbound link to the original market page,
 * resolved from the conditionId (the only identifier a strategy is guaranteed
 * to carry; armed/edited strategies have no slug in local state). Pass `slug`
 * when already known to skip the lookup. Renders nothing until resolved.
 */
export function PolymarketLink({
  conditionId,
  slug,
  iconOnly = false,
  className,
}: {
  conditionId?: string | null | undefined;
  /** Known market slug — skips the resolve request. */
  slug?: string | null | undefined;
  /** Tight headers: just the outbound icon, label in the tooltip. */
  iconOnly?: boolean;
  className?: string;
}) {
  const resolve = useMarketResolve(slug ? null : (conditionId ?? null));
  const resolvedSlug = slug ?? resolve.data?.slug ?? null;
  if (!resolvedSlug) return null;
  return (
    <a
      href={`https://polymarket.com/market/${encodeURIComponent(resolvedSlug)}`}
      target="_blank"
      rel="noopener noreferrer"
      title="View on Polymarket"
      aria-label="View on Polymarket"
      // Card headers select/open on click — the link must not trigger that too.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-faint transition-colors hover:text-accent",
        className,
      )}
    >
      <ExternalLink size={11} aria-hidden />
      {iconOnly ? null : "View on Polymarket"}
    </a>
  );
}
