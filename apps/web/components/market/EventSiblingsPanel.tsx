"use client";

/**
 * "More from this event" on the market detail page: the parent event's other
 * sub-markets (totals/spreads, other candidates), each one tap away. Hidden
 * for standalone markets.
 */
import { GroupedResultCard } from "./GroupedResultCard";
import { useMarketSiblings } from "@/lib/smart-orders/queries";

export function EventSiblingsPanel({
  tokenId,
  currentMarketId,
}: {
  tokenId: string | null;
  currentMarketId: string;
}) {
  const siblings = useMarketSiblings(tokenId);
  const event = siblings.data?.event;
  if (!event) return null;
  const others = event.markets.filter((m) => m.marketId !== currentMarketId);
  if (others.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        More from this event
      </h3>
      <GroupedResultCard event={{ ...event, markets: others }} linkTitleToEvent />
    </div>
  );
}
