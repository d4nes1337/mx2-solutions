"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortAddress } from "@/lib/format";
import type { PortfolioProfile } from "@/lib/types";
import { Button, cn } from "@/components/ui";

const PROXY_STORAGE_KEY = "mx2.proxyWallet";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function useWalletOverride(derivedDeposit?: string) {
  const [proxyInput, setProxyInput] = useState("");
  useEffect(() => {
    const saved = window.localStorage.getItem(PROXY_STORAGE_KEY);
    if (saved) setProxyInput(saved);
  }, []);
  const override = ADDRESS_RE.test(proxyInput) ? proxyInput : undefined;
  const proxy = override ?? derivedDeposit;
  useEffect(() => {
    if (override) window.localStorage.setItem(PROXY_STORAGE_KEY, override);
    else if (!proxyInput) window.localStorage.removeItem(PROXY_STORAGE_KEY);
  }, [override, proxyInput]);
  return { proxyInput, setProxyInput, override, proxy };
}

export function PortfolioHeader({
  signerAddress,
  queryAddress,
  profile,
  derivedDeposit,
  onRefresh,
  refreshing,
  proxyInput,
  setProxyInput,
  actions,
}: {
  signerAddress: string;
  queryAddress?: string;
  profile?: PortfolioProfile | null;
  derivedDeposit?: string;
  onRefresh: () => void;
  refreshing?: boolean;
  proxyInput: string;
  setProxyInput: (v: string) => void;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {profile?.profileImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.profileImage}
            alt=""
            className="h-12 w-12 shrink-0 rounded-md border border-border object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-sm font-semibold text-muted">
            {(profile?.name ?? "P").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-fg">
            {profile?.name ?? "Portfolio"}
          </h1>
          <p className="tabular mt-1 truncate text-xs text-muted">
            Signer {shortAddress(signerAddress)}
            {queryAddress ? (
              <>
                {" · "}
                Deposit {shortAddress(queryAddress)}
              </>
            ) : null}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <Button variant="ghost" onClick={onRefresh} disabled={refreshing} className="text-xs">
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </Button>
        <div className="relative" ref={popRef}>
          <Button variant="ghost" onClick={() => setOpen((o) => !o)} className="text-xs">
            ⚙ Wallet
          </Button>
          {open ? (
            <div className="absolute right-0 z-20 mt-1 w-[320px] rounded-sm border border-border bg-surface p-3 shadow-lg">
              <p className="text-xs font-semibold text-fg">Deposit wallet override</p>
              <p className="mt-1 text-[11px] text-muted">
                Defaults to your derived Polymarket deposit wallet
                {derivedDeposit ? ` (${shortAddress(derivedDeposit)})` : ""}.
              </p>
              <input
                value={proxyInput}
                onChange={(e) => setProxyInput(e.target.value)}
                placeholder="0x… optional"
                className="tabular mt-2 w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent/50"
              />
              {proxyInput && !ADDRESS_RE.test(proxyInput) ? (
                <p className="mt-1 text-[11px] text-warn">Enter a valid 0x address</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function PortfolioTabBar({
  tab,
  onTab,
  positionCount,
  orderCount,
  marketPnlCount,
}: {
  tab: "positions" | "market-pnl" | "orders" | "history";
  onTab: (t: "positions" | "market-pnl" | "orders" | "history") => void;
  positionCount: number;
  orderCount: number;
  marketPnlCount: number;
}) {
  const tabs = [
    { id: "positions" as const, label: `Positions (${positionCount})` },
    { id: "market-pnl" as const, label: `Market PnL (${marketPnlCount})` },
    { id: "orders" as const, label: `Open orders (${orderCount})` },
    { id: "history" as const, label: "Activity" },
  ];
  return (
    <div className="flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTab(t.id)}
          className={cn(
            "border-b-2 px-3 py-2 text-xs font-medium transition-colors",
            tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
