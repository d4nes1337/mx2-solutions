"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth";
import { useHistory, usePnl, usePositions } from "@/lib/queries";
import { shortAddress } from "@/lib/format";
import { Badge, Card, CardHeader, Empty, ErrorNote, Spinner } from "@/components/ui";
import { PnLSummary } from "@/components/PnLSummary";
import { PositionsTable } from "@/components/PositionsTable";
import { HistoryTable } from "@/components/HistoryTable";

const PROXY_STORAGE_KEY = "mx2.proxyWallet";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export default function ProfilePage() {
  const session = useSession();
  // The deposit wallet is derived server-side from the signed-in EOA and returned
  // by /api/auth/me, so the portfolio loads automatically with no manual entry.
  // The input below is an optional override (e.g. to inspect a different wallet).
  const derivedDeposit = session.data?.depositWallet ?? undefined;
  const [proxyInput, setProxyInput] = useState("");
  const override = ADDRESS_RE.test(proxyInput) ? proxyInput : undefined;
  const proxy = override ?? derivedDeposit;

  // Persist the override so it only has to be entered once.
  // (Read on mount in an effect, not in useState, so SSR doesn't touch window.)
  useEffect(() => {
    const saved = window.localStorage.getItem(PROXY_STORAGE_KEY);
    if (saved) setProxyInput(saved);
  }, []);
  useEffect(() => {
    if (override) window.localStorage.setItem(PROXY_STORAGE_KEY, override);
  }, [override]);

  const signedIn = Boolean(session.data);
  const positions = usePositions(signedIn, proxy);
  const history = useHistory(signedIn, proxy);
  const pnl = usePnl(signedIn, proxy);

  if (session.isLoading) return <Spinner label="Checking session…" />;

  if (!signedIn) {
    return (
      <Empty>
        Connect your wallet and <strong>Sign in</strong> (top right) to view your portfolio, trading
        history and PnL.
      </Empty>
    );
  }

  // The deposit wallet is normally derived automatically. This hint only appears in
  // the rare fallback case where derivation failed (querying the bare EOA, which has
  // no positions) — then guide the user to paste their deposit wallet as an override.
  const queryAddress = positions.data?.queryAddress;
  const showDepositWalletHint =
    !proxy && positions.data !== undefined && positions.data.count === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Profile</h1>
          <Badge tone="accent">{shortAddress(session.data!.address)}</Badge>
          <Badge tone={session.data!.allowlisted ? "pos" : "warn"}>
            {session.data!.allowlisted ? "allowlisted" : "not allowlisted"}
          </Badge>
          {queryAddress ? (
            <span className="text-xs text-muted">
              querying {override ? "override" : derivedDeposit ? "deposit wallet" : "EOA"}{" "}
              {shortAddress(queryAddress)}
            </span>
          ) : null}
        </div>
        <label className="text-xs text-muted">
          Override wallet
          <input
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder="0x… (optional — defaults to derived)"
            className="tabular ml-2 w-[320px] rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg outline-none focus:border-accent/50"
          />
        </label>
      </div>

      {showDepositWalletHint ? (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-fg">
          <p className="font-semibold text-accent">No positions found for your signing wallet.</p>
          <p className="mt-1 text-muted">
            You signed in with your <strong>EOA</strong> ({shortAddress(session.data!.address)}),
            but Polymarket holds positions, history and PnL under your{" "}
            <strong>deposit wallet</strong> (the address shown on your Polymarket profile). Paste
            that address into the <strong>Deposit/proxy wallet</strong> field above to see your
            portfolio. It will be remembered on this device.
          </p>
        </div>
      ) : null}

      {/* PnL */}
      <section className="space-y-2">
        {pnl.isLoading ? (
          <Spinner label="Computing PnL…" />
        ) : pnl.error ? (
          <ErrorNote message={(pnl.error as Error).message} />
        ) : pnl.data ? (
          <PnLSummary data={pnl.data} />
        ) : null}
      </section>

      {/* Positions */}
      <Card>
        <CardHeader>Open positions</CardHeader>
        <div className="p-4">
          {positions.isLoading ? (
            <Spinner />
          ) : positions.error ? (
            <ErrorNote message={(positions.error as Error).message} />
          ) : positions.data ? (
            <PositionsTable positions={positions.data.positions} />
          ) : null}
        </div>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>Recent activity</CardHeader>
        <div className="p-4">
          {history.isLoading ? (
            <Spinner />
          ) : history.error ? (
            <ErrorNote message={(history.error as Error).message} />
          ) : history.data ? (
            <HistoryTable activity={history.data.activity} />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
