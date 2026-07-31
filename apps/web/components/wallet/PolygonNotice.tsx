"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { POLYGON_CHAIN_ID } from "@/lib/chain";
import { Button } from "@/components/ui";

/**
 * Wrong-network nudge for any surface that is about to ask for a signature.
 *
 * Signing still *attempts* on whatever chain the wallet is on — every EIP-712
 * payload carries chainId 137 explicitly and most wallets honor it — so this
 * never blocks. It exists because the wallets that DON'T honor it fail with an
 * opaque rejection after the user has already committed, and because this app
 * deliberately connects extra chains for bridge funding, so being left on Base
 * or Arbitrum is a normal thing to happen mid-session.
 *
 * Offering the switch before the signature is the difference between "declined"
 * and "you're on Base, tap here".
 */
export function PolygonNotice({ className }: { className?: string }) {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected || chainId === undefined || chainId === POLYGON_CHAIN_ID) return null;

  return (
    <div className={className} role="status" aria-label="Wallet is not on the Polygon network">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-warn">
        <span className="text-[12px] leading-snug">
          Your wallet is on a different network. Polymarket orders are signed on Polygon.
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => switchChain({ chainId: POLYGON_CHAIN_ID })}
        >
          {isPending ? "Switching…" : "Switch to Polygon"}
        </Button>
      </div>
      {error ? (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          Your wallet refused the switch — change the network manually, or sign anyway (the order
          itself is always pinned to Polygon).
        </p>
      ) : null}
    </div>
  );
}
