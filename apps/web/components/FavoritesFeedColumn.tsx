"use client";

import { useAccount } from "wagmi";
import { useSession, useSignIn } from "@/lib/auth";
import { useFavoritesDefaultFeed } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { Button } from "./ui";
import { MarketFeedColumn } from "./MarketFeedColumn";

export function FavoritesFeedColumn() {
  const { isConnected } = useAccount();
  const session = useSession();
  const signIn = useSignIn();
  const feed = useFavoritesDefaultFeed();

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
          ? "Personal watchlist — save markets here (coming soon)."
          : "Sign in to pin markets. Showing suggested picks until then."
      }
      events={feed.data?.events}
      isLoading={feed.isLoading}
      error={feed.error as Error | null}
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
            <span className="text-[10px] text-muted">Connect wallet to sign in</span>
          ) : null}
          {err ? <span className="max-w-[120px] truncate text-[10px] text-neg">{err}</span> : null}
        </div>
      }
    />
  );
}
