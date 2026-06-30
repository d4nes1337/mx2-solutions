"use client";

import { useAccount } from "wagmi";
import { useSession, useSignIn } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import type { GammaEvent } from "@/lib/types";
import { Button } from "./ui";
import { MarketFeedColumn } from "./MarketFeedColumn";

export function FavoritesFeedColumn({
  events,
  isLoading,
  error,
}: {
  events?: GammaEvent[];
  isLoading: boolean;
  error: Error | null;
}) {
  const { isConnected } = useAccount();
  const session = useSession();
  const signIn = useSignIn();

  const signedIn = Boolean(session.data);
  const err =
    signIn.error instanceof ApiError
      ? signIn.error.message
      : signIn.error instanceof Error
        ? signIn.error.message
        : null;

  return (
    <MarketFeedColumn
      title="Favorites"
      subtitle={
        signedIn
          ? "Pinned markets will live here. Suggested picks for now."
          : "Sign in to pin markets like these."
      }
      events={events}
      isLoading={isLoading}
      error={error}
      headerExtra={
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!signedIn && isConnected ? (
            <Button
              className="rounded-sm px-2 py-1 text-[11px]"
              onClick={() => signIn.mutate()}
              disabled={signIn.isPending}
            >
              {signIn.isPending ? "…" : "Sign in"}
            </Button>
          ) : null}
          {!isConnected ? (
            <span className="max-w-[128px] text-right text-[10px] leading-tight text-muted">
              Connect wallet to save a watchlist
            </span>
          ) : null}
          {err ? <span className="max-w-[120px] truncate text-[10px] text-neg">{err}</span> : null}
        </div>
      }
    />
  );
}
