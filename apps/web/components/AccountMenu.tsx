"use client";

/**
 * First-party account control for the header, replacing RainbowKit's stock
 * account modal (the "strange popup"). RainbowKit still owns the CONNECT and
 * chain-switch modals — everything after connection is ours: identity, beta
 * status, trading-wallet balance with one-click top-up, portfolio/wallet
 * links, sign out, disconnect.
 */
import { useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";
import { ArrowUpRight, LogOut, Unplug } from "lucide-react";
import { useSession, useSignIn, useSignOut } from "@/lib/auth";
import { useTradingWallet, useTradingWalletBalance } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { Badge, Button, cn } from "@/components/ui";
import { Popover } from "@/components/ui/Popover";

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

function MenuLink({
  href,
  onNavigate,
  children,
}: {
  href: string;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="block rounded-md px-2 py-1.5 text-sm text-fg hover:bg-surface-2"
      onClick={onNavigate}
    >
      {children}
    </Link>
  );
}

function BalanceBlock({ onNavigate }: { onNavigate: () => void }) {
  const walletStatus = useTradingWallet(true);
  const balance = useTradingWalletBalance(walletStatus.data?.provisioned === true);
  if (!walletStatus.data?.provisioned) {
    // Pre-opt-in: the Arima Wallet is a neutral, optional entry — no prominent
    // "Add funds"/"Set up" emphasis before the user opts in (brief §5.3.2/3).
    return (
      <div className="rounded-md border border-border bg-surface-2 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg">
            Arima Wallet
            <Badge tone="neutral">Beta</Badge>
          </span>
          <Link
            href="/wallet"
            className="text-[11px] text-muted hover:text-fg"
            onClick={onNavigate}
          >
            Optional →
          </Link>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted">
          Automate execution with a separate, ring-fenced balance.
        </p>
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
          onClick={onNavigate}
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
  // Was a <details>: it stayed open until its own summary was clicked again.
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

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
              <div className="flex items-center gap-2">
                {signInError ? (
                  <span className="hidden max-w-[200px] truncate text-xs text-neg sm:inline">
                    {signInError}
                  </span>
                ) : null}
                <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
                  {signIn.isPending ? "Check wallet…" : "Sign in"}
                </Button>
              </div>
            ) : null}

            <Popover
              open={open}
              onOpenChange={setOpen}
              label="Account"
              autoFocus={false}
              panelClassName="z-40 w-64 space-y-1.5 p-2"
              trigger={
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label="Account menu"
                  onClick={() => setOpen((o) => !o)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-border-strong"
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${session.data ? "bg-pos" : "bg-warn"}`}
                  />
                  <span className="tabular">{account.ensName ?? short(account.address)}</span>
                  <span
                    className={cn(
                      "text-[10px] text-faint transition-transform",
                      open && "rotate-180",
                    )}
                  >
                    ▾
                  </span>
                </button>
              }
            >
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <span className="tabular text-[12px] font-medium text-fg">
                  {short(account.address)}
                </span>
                {session.data ? (
                  <Badge tone="pos" dot>
                    signed in
                  </Badge>
                ) : (
                  <Badge tone="warn" dot>
                    not signed in
                  </Badge>
                )}
              </div>

              {session.data ? <BalanceBlock onNavigate={close} /> : null}

              {session.data ? (
                <div className="space-y-0.5">
                  <MenuLink href="/portfolio" onNavigate={close}>
                    Portfolio &amp; analytics
                  </MenuLink>
                  <MenuLink href="/wallet" onNavigate={close}>
                    Wallet settings
                  </MenuLink>
                  <MenuLink href="/strategies" onNavigate={close}>
                    My strategies
                  </MenuLink>
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
                    onClick={() => {
                      signOut.mutate();
                      close();
                    }}
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
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-neg"
                >
                  <Unplug size={13} aria-hidden />
                  Disconnect wallet
                </button>
              </div>
            </Popover>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
