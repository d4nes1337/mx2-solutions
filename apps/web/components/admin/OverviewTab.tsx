"use client";

import { useAdminOverview } from "@/lib/queries";
import { Card, CardHeader, ErrorNote, Skeleton, Stat } from "@/components/ui";

/** Tiny dependency-free bar sparkline (house style: SVG, no chart libs). */
function SignupsSpark({ data }: { data: { day: string; count: number }[] }) {
  if (data.length === 0) {
    return <p className="text-[12px] text-muted">No referral signups in the last 30 days yet.</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  const w = 12;
  const gap = 3;
  const h = 56;
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${data.length * (w + gap)} ${h + 14}`}
      className="max-h-24"
      role="img"
      aria-label="Referral signups per day, last 30 days"
    >
      {data.map((d, i) => {
        const bh = Math.max(2, (d.count / max) * h);
        return (
          <g key={d.day}>
            <rect
              x={i * (w + gap)}
              y={h - bh}
              width={w}
              height={bh}
              rx={1.5}
              className="fill-brand/80"
            >
              <title>{`${d.day}: ${d.count}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export function OverviewTab() {
  const overview = useAdminOverview(true);

  if (overview.isPending) return <Skeleton className="h-40 w-full" />;
  if (overview.isError) return <ErrorNote message="Could not load the overview." />;
  const d = overview.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Users" value={String(d.totalUsers)} />
        <Stat label="Active access" value={String(d.allowlistedActive)} />
        <Stat label="Seats used" value={`${d.seatsUsed}/${d.seatsTotal}`} />
        <Stat label="Waitlist" value={String(d.waitlistWaiting)} />
      </div>
      <Card>
        <CardHeader>Referral signups — last 30 days</CardHeader>
        <div className="p-4">
          <SignupsSpark data={d.redemptionsByDay} />
        </div>
      </Card>
    </div>
  );
}
