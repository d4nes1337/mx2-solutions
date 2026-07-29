"use client";

import { Gift, Link2, Users } from "lucide-react";
import { useFeatureFlags, useReferralsMe } from "@/lib/queries";
import type { ReferralCodeItem } from "@/lib/types";
import { Badge, Card, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { CopyButton } from "./funds/shared";

const shortWallet = (w: string): string => `${w.slice(0, 6)}…${w.slice(-4)}`;

const STATUS_TONE: Record<ReferralCodeItem["status"], "pos" | "neutral" | "warn" | "neg"> = {
  active: "pos",
  exhausted: "warn",
  expired: "neutral",
  disabled: "neg",
};

function CodeRow({ item, shareBaseUrl }: { item: ReferralCodeItem; shareBaseUrl: string }) {
  const shareLink = `${shareBaseUrl.replace(/\/$/, "")}/r/${item.code}`;
  const seatsLeft = Math.max(0, item.maxUses - item.usedCount);

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[15px] font-semibold tracking-widest text-fg">
          {item.code}
        </span>
        <CopyButton text={item.code} />
        <Badge tone={STATUS_TONE[item.status]} dot>
          {item.status}
        </Badge>
        <span className="ml-auto text-[11px] text-muted">
          {item.usedCount}/{item.maxUses} used
          {item.status === "active" ? ` · ${seatsLeft} left` : ""}
          {Number(item.attributedVolumeUsd) > 0
            ? ` · $${Math.round(Number(item.attributedVolumeUsd)).toLocaleString()} referred volume`
            : ""}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[12px] text-muted">
        <Link2 size={12} className="shrink-0 text-faint" aria-hidden />
        <span className="truncate font-mono">{shareLink}</span>
        <CopyButton text={shareLink} />
      </div>
      {item.redemptions.length > 0 ? (
        <div className="border-t border-border pt-2">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted">
            <Users size={11} aria-hidden /> Joined with this code
          </div>
          <ul className="space-y-0.5">
            {item.redemptions.map((r) => (
              <li
                key={r.walletAddress}
                className="flex items-center justify-between font-mono text-[11px] text-muted"
              >
                <span>{shortWallet(r.walletAddress)}</span>
                <span className="text-faint">{new Date(r.redeemedAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Invite friends" card (Wallet page): the user's referral codes with share
 * links and who joined through them. Codes are minted server-side at sign-in;
 * seat caps are admin-controlled.
 */
export function ReferralsSection({ signedIn }: { signedIn: boolean }) {
  const flags = useFeatureFlags();
  const referralsEnabled = flags.data?.referrals ?? false;
  const me = useReferralsMe(signedIn && referralsEnabled);

  if (!referralsEnabled || !signedIn) return null;

  return (
    <Card>
      <CardHeader>
        <span className="flex items-center gap-1.5">
          <Gift size={14} className="text-accent" aria-hidden />
          Invite friends
        </span>
      </CardHeader>
      <div className="space-y-3 p-4">
        <p className="text-[12px] leading-snug text-muted">
          Share your code — friends who sign in with it get instant access. Each code has a limited
          number of seats; ask us to raise yours if your community is bigger.
        </p>
        {me.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : me.isError ? (
          <ErrorNote message="Could not load your referral codes." />
        ) : (
          me.data.codes.map((item) => (
            <CodeRow key={item.id} item={item} shareBaseUrl={me.data.shareBaseUrl} />
          ))
        )}
      </div>
    </Card>
  );
}
