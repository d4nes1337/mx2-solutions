"use client";

/**
 * Farming cockpit: markets ranked by liquidity-rewards farmability, with an
 * inline loop designer. Everything is flag-gated (FEATURE_MAKER_LOOP) and
 * loops arm in shadow mode (RFC-0003).
 */
import { useState } from "react";
import { Sprout } from "lucide-react";
import { Badge, Empty, ErrorNote, Skeleton, cn } from "@/components/ui";
import { useFeatureFlags } from "@/lib/queries";
import { useRewardsScanner, type ScannerMarket } from "@/lib/farming/queries";
import { LoopDesigner } from "@/components/farming/LoopDesigner";
import { cents, usdCompact } from "@/lib/format";

const money = (n: number) => `$${n.toFixed(0)}`;

export default function FarmingPage() {
  const flags = useFeatureFlags();
  const enabled = Boolean(flags.data?.makerLoop);
  const scanner = useRewardsScanner(enabled);
  const [selected, setSelected] = useState<ScannerMarket | null>(null);

  if (flags.data && !enabled) {
    return (
      <Empty>
        Rebate farming isn&apos;t enabled on this server yet — it ships dark behind
        FEATURE_MAKER_LOOP (see RFC-0003).
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-fg">
            <Sprout size={20} className="text-pos" aria-hidden />
            Rebate farming
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-snug text-muted">
            Markets ranked by their daily liquidity-rewards pool. Design a delta-neutral quoting
            loop — it runs in shadow mode first, recording what it would do without placing
            anything.
          </p>
        </div>
        <Badge tone="brand">shadow mode</Badge>
      </div>

      {scanner.isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : scanner.isError ? (
        <ErrorNote message="The rewards scanner is unavailable right now." />
      ) : (scanner.data?.markets.length ?? 0) === 0 ? (
        <Empty>No reward-carrying markets surfaced right now — try again in a few minutes.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-panel">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2.5">Market</th>
                <th className="px-3 py-2.5 text-right">Pool/day</th>
                <th className="px-3 py-2.5 text-right">Min size</th>
                <th className="px-3 py-2.5 text-right">Reward band</th>
                <th className="px-3 py-2.5 text-right">Live spread</th>
                <th className="px-3 py-2.5 text-right">Mid</th>
                <th className="px-3 py-2.5 text-right">Liquidity</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {scanner.data!.markets.map((m) => {
                const mid =
                  m.bestBid !== null && m.bestAsk !== null ? (m.bestBid + m.bestAsk) / 2 : null;
                const active = selected?.conditionId === m.conditionId;
                return (
                  <tr
                    key={m.conditionId}
                    className={cn(
                      "border-b border-border/60 transition-colors last:border-0",
                      active ? "bg-brand-soft/40" : "hover:bg-surface-2/60",
                    )}
                  >
                    <td className="max-w-[320px] truncate px-3 py-2.5 font-medium text-fg">
                      {m.title}
                      {m.negRisk ? (
                        <span className="ml-1.5 rounded-full border border-border px-1.5 text-[9px] text-muted">
                          negRisk
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold text-pos">
                      {money(m.ratePerDayUsd)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{m.minSize ?? "—"}</td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {m.maxSpreadCents !== null ? `±${m.maxSpreadCents}¢` : "—"}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {m.spreadCents !== null ? `${m.spreadCents}¢` : "—"}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {mid !== null ? cents(mid) : "—"}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {m.liquidityUsd !== null ? usdCompact(m.liquidityUsd) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setSelected(active ? null : m)}
                        disabled={!m.yesTokenId || !m.noTokenId}
                        className="rounded-md border border-brand/50 bg-brand/10 px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-brand/20 disabled:opacity-40"
                      >
                        {active ? "Close" : "Design loop"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? <LoopDesigner market={selected} /> : null}

      <p className="text-[11px] leading-snug text-faint">
        Pool rates are Polymarket&apos;s published daily liquidity rewards, shared pro-rata across
        qualifying makers — your share depends on the competition. Data refreshes every 15 minutes.
        Not investment advice.
      </p>
    </div>
  );
}
