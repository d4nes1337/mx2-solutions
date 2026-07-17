"use client";

/**
 * First-party account control for the header, replacing RainbowKit's stock
 * account modal (the "strange popup"). RainbowKit still owns the CONNECT and
 * chain-switch modals — everything after connection is ours: identity, beta
 * status, trading-wallet balance with one-click top-up, portfolio/wallet
 * links, sign out, disconnect.
 */
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";
import { ArrowUpRight, LogOut, Unplug } from "lucide-react";
import { useSession, useSignIn, useSignOut } from "@/lib/auth";
import { useTradingWallet, useTradingWalletBalance } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { Badge, Button } from "@/components/ui";

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

function MenuLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block rounded-md px-2 py-1.5 text-sm text-fg hover:bg-surface-2"
      onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
    >
      {children}
    </Link>
  );
}

function BalanceBlock() {
  const walletStatus = useTradingWallet(true);
  const balance = useTradingWalletBalance(walletStatus.data?.provisioned === true);
  if (!walletStatus.data?.provisioned) {
    return (
      <div className="rounded-md border border-border bg-surface-2 px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-wide text-muted">Trading wallet</div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[12px] text-muted">Not set up yet</span>
          <Link
            href="/wallet"
            className="text-[11px] font-semibold text-accent hover:text-brand-strong"
            onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
          >
            Set up →
          </Link>
        </div>
      </div>
    );
  }
  const pusd = balance.data?.depositWalletUsdc;
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">Trading balance</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="tabular text-[15px] font-semibold text-fg">
          {pusd == null ? (balance.isLoading ? "…" : "—") : `$${pusd.toFixed(2)}`}
          <span className="ml-1 text-[10px] font-medium text-faint">pUSD</span>
        </span>
        <Link
          href="/wallet?topup=1"
          className="inline-flex items-center gap-1 rounded-md border border-brand bg-brand px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-brand-strong"
          onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
        >
          <ArrowUpRight size={11} aria-hidden />
          Add funds
        </Link>
      </div>
    </div>
  );
}

export function AccountMenu() {
  const session = useSession();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const { disconnect } = useDisconnect();

  const signInError =
    signIn.error instanceof ApiError || signIn.error instanceof Error ? signIn.error.message : null;

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, openChainModal, mounted }) => {
        if (!mounted) {
          return <div aria-hidden className="h-9 w-28 rounded-md bg-surface-2" />;
        }
        if (!account || !chain) {
          return (
            <Button size="sm" onClick={openConnectModal}>
              Connect wallet
            </Button>
          );
        }
        if (chain.unsupported) {
          return (
            <Button size="sm" variant="danger" onClick={openChainModal}>
              Wrong network
            </Button>
          );
        }

        return (
          <div className="flex items-center gap-2" data-tour="account-menu">
            {!session.data ? (
              <>
                {signInError ? (
                  <span className="hidden max-w-[200px] truncate text-xs text-neg sm:inline">
                    {signInError}
                  </span>
                ) : null}
                <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
                  {signIn.isPending ? "Check wallet…" : "Sign in"}
                </Button>
              </>
            ) : null}

            <details className="group relative">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-border-strong [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${session.data ? "bg-pos" : "bg-warn"}`}
                />
                <span className="tabular">{account.ensName ?? short(account.address)}</span>
                <span className="text-[10px] text-faint transition-transform group-open:rotate-180">
                  ▾
                </span>
              </summary>

              <div className="absolute right-0 top-full z-40 mt-1.5 w-64 space-y-1.5 rounded-lg border border-border bg-surface p-2 shadow-pop">
                <div className="flex items-center justify-between gap-2 px-2 py-1">
                  <span className="tabular text-[12px] font-medium text-fg">
                    {short(account.address)}
                  </span>
                  {session.data ? (
                    <Badge tone={session.data.allowlisted ? "pos" : "warn"} dot>
                      {session.data.allowlisted ? "beta access" : "no beta yet"}
                    </Badge>
                  ) : (
                    <Badge tone="warn" dot>
                      not signed in
                    </Badge>
                  )}
                </div>

                {session.data ? <BalanceBlock /> : null}

                {session.data ? (
                  <div className="space-y-0.5">
                    <MenuLink href="/portfolio">Portfolio &amp; analytics</MenuLink>
                    <MenuLink href="/wallet">Wallet settings</MenuLink>
                    <MenuLink href="/smart-orders">My Smart Orders</MenuLink>
                  </div>
                ) : (
                  <p className="px-2 py-1 text-[12px] leading-relaxed text-muted">
                    Sign the message in your wallet to unlock your portfolio and trading.
                  </p>
                )}

                <div className="space-y-0.5 border-t border-border pt-1.5">
                  {session.data ? (
                    <button
                      type="button"
                      onClick={() => signOut.mutate()}
                      disabled={signOut.isPending}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
                    >
                      <LogOut size={13} aria-hidden />
                      Sign out
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (session.data) signOut.mutate();
                      disconnect();
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-neg"
                  >
                    <Unplug size={13} aria-hidden />
                    Disconnect wallet
                  </button>
                </div>
              </div>
            </details>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
