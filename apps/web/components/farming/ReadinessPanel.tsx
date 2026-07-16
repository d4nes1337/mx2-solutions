"use client";

/**
 * The live-farming ladder (RFC-0003 checkpoints) as a checklist: each row is
 * a prerequisite with its live state and the action that unblocks it. Pure
 * presence/state booleans from GET /api/quoter/readiness — no secrets.
 */
import { Check, ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { Skeleton, cn } from "@/components/ui";
import { useQuoterReadiness } from "@/lib/farming/queries";

function Row({ ok, label, action }: { ok: boolean; label: string; action?: string }) {
  return (
    <li className="flex items-start gap-2 px-3 py-1.5 text-[12px]">
      {ok ? (
        <Check size={13} className="mt-0.5 shrink-0 text-pos" aria-label="ready" />
      ) : (
        <X size={13} className="mt-0.5 shrink-0 text-neg" aria-label="not ready" />
      )}
      <span className={cn("flex-1", ok ? "text-fg" : "text-muted")}>
        {label}
        {!ok && action ? <span className="block text-[11px] text-faint">→ {action}</span> : null}
      </span>
    </li>
  );
}

export function ReadinessPanel() {
  const readiness = useQuoterReadiness();
  const [open, setOpen] = useState(false);

  if (readiness.isLoading) return <Skeleton className="h-10 w-full rounded-xl" />;
  if (!readiness.data) return null;
  const r = readiness.data;

  const rows: { ok: boolean; label: string; action?: string }[] = [
    {
      ok: r.wallet.provisioned && r.wallet.depositWalletActive,
      label: "Arima wallet + Polymarket deposit wallet",
      action: "Create the wallet from your profile, then activate the deposit wallet",
    },
    {
      ok: r.flags.privySigning && r.flags.relayer && r.relayerEnabled,
      label: "Server signing + gasless relayer",
      action: "Server env: FEATURE_PRIVY_SIGNING, FEATURE_RELAYER + builder credentials",
    },
    {
      ok: r.rpcConfigured,
      label: "Polygon RPC (balance + allowance reads)",
      action: "Server env: POLYGON_RPC_URL",
    },
    {
      ok: r.adapters.ctfConfigured && r.adapters.negRiskConfigured,
      label: "CTF adapters verified on-chain (merges)",
      action: "Owner runs verify-ctf-adapters, then sets the two adapter addresses",
    },
    {
      ok: r.allowances !== null && r.allowances.every((a) => a.granted),
      label:
        r.allowances === null
          ? "Exchange allowances (pUSD + CTF)"
          : `Exchange allowances (${r.allowances.filter((a) => a.granted).length}/${r.allowances.length} granted)`,
      action: "One click: bootstrap allowances from the wallet card",
    },
    {
      ok: r.wallet.clobCredentials,
      label: "CLOB API credentials (server-derived)",
      action: "One click: set up trading credentials from the wallet card",
    },
    {
      ok: r.flags.makerLoopLive,
      label: "FEATURE_MAKER_LOOP_LIVE (final gate)",
      action: "Owner enables after the shadow soak + adapter verification",
    },
    {
      ok: r.geoblock.status === "allowed",
      label: `Geoblock: ${r.geoblock.status}${r.geoblock.country ? ` (${r.geoblock.country})` : ""}`,
      action: "Live trading requires an unrestricted region",
    },
  ];
  const readyCount = rows.filter((x) => x.ok).length;
  const allReady = readyCount === rows.length;

  return (
    <div className="rounded-xl border border-border bg-surface shadow-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-[13px] font-semibold text-fg">
          Go-live readiness{" "}
          <span className={cn("font-normal", allReady ? "text-pos" : "text-muted")}>
            {readyCount}/{rows.length}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={cn("text-muted transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <ul className="border-t border-border py-1">
          {rows.map((row, i) => (
            <Row key={i} {...row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
