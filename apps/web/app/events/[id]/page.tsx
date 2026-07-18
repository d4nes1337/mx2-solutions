"use client";

/**
 * Event page: every sub-market of a Polymarket event (totals/spreads inside a
 * match, candidates inside an election) with prices, one tap from its market
 * page or the builder. Powered by GET /api/events/:id/markets.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ErrorNote, Skeleton } from "@/components/ui";
import { GroupedResultCard } from "@/components/market/GroupedResultCard";
import { useEventMarkets } from "@/lib/smart-orders/queries";

export default function EventPage() {
  const params = useParams<{ id: string }>();
  const event = useEventMarkets(params.id ?? null);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href="/markets"
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft size={13} aria-hidden /> Markets
      </Link>

      {event.isLoading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : event.error ? (
        <ErrorNote message={(event.error as Error).message} />
      ) : event.data ? (
        <GroupedResultCard event={event.data} defaultExpanded />
      ) : null}
    </div>
  );
}
