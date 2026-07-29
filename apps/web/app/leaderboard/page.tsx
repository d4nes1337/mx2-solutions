"use client";

import { Trophy } from "lucide-react";
import { useFeatureFlags, useReferralLeaderboard } from "@/lib/queries";
import { Card, CardHeader, Empty, ErrorNote, Skeleton } from "@/components/ui";

const shortWallet = (w: string): string => `${w.slice(0, 6)}…${w.slice(-4)}`;

const fmtUsd = (raw: string): string => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "$0";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
};

const RANK_TONE = ["text-warn", "text-muted", "text-[#b87333]"];

/**
 * Public referral leaderboard: codes ranked by the lifetime traded volume of
 * the users they brought in. No auth — this is the shareable stats surface.
 */
export default function LeaderboardPage() {
  const flags = useFeatureFlags();
  const leaderboard = useReferralLeaderboard();
  const enabled = flags.data?.referrals ?? true;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-fg">
          <Trophy size={18} className="text-warn" aria-hidden />
          Referral leaderboard
        </h1>
        <p className="mt-1 text-sm text-muted">
          Codes ranked by the trading volume of the people they brought to arima.
        </p>
      </div>

      {!enabled ? (
        <Empty>The referral program hasn’t started yet.</Empty>
      ) : leaderboard.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : leaderboard.isError ? (
        <ErrorNote message="Could not load the leaderboard." />
      ) : leaderboard.data.entries.length === 0 ? (
        <Empty>No referral volume yet — be the first.</Empty>
      ) : (
        <Card>
          <CardHeader
            right={
              <span className="text-[11px] text-faint">
                updated {new Date(leaderboard.data.updatedAt).toLocaleTimeString()}
              </span>
            }
          >
            Top referrers
          </CardHeader>
          <ul className="divide-y divide-border/60">
            {leaderboard.data.entries.map((e) => (
              <li key={e.code} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span
                  className={`w-7 text-right font-mono font-semibold ${RANK_TONE[e.rank - 1] ?? "text-faint"}`}
                >
                  {e.rank}
                </span>
                <span className="font-mono font-semibold tracking-wider text-fg">{e.code}</span>
                {e.ownerWallet ? (
                  <span className="hidden font-mono text-[11px] text-faint sm:inline">
                    {shortWallet(e.ownerWallet)}
                  </span>
                ) : null}
                <span className="ml-auto text-[12px] text-muted">{e.refereeCount} joined</span>
                <span className="w-24 text-right font-mono font-semibold text-fg">
                  {fmtUsd(e.attributedVolumeUsd)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
